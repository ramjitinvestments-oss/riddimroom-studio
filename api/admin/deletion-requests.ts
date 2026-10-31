import { verifyRequest, fetchDeletionRequests, AccessToggleError, type ApiRequest, type ApiResponse } from '../_lib.js';

// R40 P-27: GET /api/admin/deletion-requests — the Admin screen's
// "Account deletion requests" readout: who asked, and when. Admin-
// gated in fetchDeletionRequests (refuses before listing anything
// when the caller has no admins/{uid} doc).
export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }
  const decoded = await verifyRequest(req, res);
  if (!decoded) return;

  try {
    const requests = await fetchDeletionRequests(decoded.uid, decoded.idToken);
    res.status(200).json({ success: true, requests });
  } catch (err: any) {
    if (err instanceof AccessToggleError && err.code === 'NOT_ADMIN') {
      res.status(403).json({ success: false, error: 'Admin access required.' });
      return;
    }
    console.error('[admin/deletion-requests] failed:', err?.message || err);
    res.status(500).json({ success: false, error: 'Failed to load deletion requests.' });
  }
}
