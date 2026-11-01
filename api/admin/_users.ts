import {
  verifyRequest,
  fetchAdminUsers,
  AccessToggleError,
  type ApiRequest,
  type ApiResponse,
} from '../_lib.js';

// Phase 2 (Plan v5): GET /api/admin/users — every signup, newest first,
// for the in-app Admin screen. Admin-gated twice over: fetchAdminUsers
// refuses non-admins before reading anything, and firestore.rules only
// lets an admin read other users' documents at all.
export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }
  const decoded = await verifyRequest(req, res);
  if (!decoded) return;

  try {
    const users = await fetchAdminUsers(decoded.uid, decoded.idToken);
    res.status(200).json({ success: true, users });
  } catch (err: any) {
    if (err instanceof AccessToggleError && err.code === 'NOT_ADMIN') {
      res.status(403).json({ success: false, error: 'Admin access required.' });
      return;
    }
    console.error('[admin/users] failed:', err?.message || err);
    res.status(500).json({ success: false, error: 'Failed to load users.' });
  }
}
