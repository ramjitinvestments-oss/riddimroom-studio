import {
  verifyRequest,
  applyAccessToggle,
  AccessToggleError,
  type ApiRequest,
  type ApiResponse,
} from '../_lib.js';

// Phase 2 (Plan v5): POST /api/admin/set-access { uid, approved } — the
// owner's toggle in the Admin screen. Approving writes the same
// entitlement records a Stripe webhook would write later
// (licenses/{uid} tier 'lifetime', active), flips users/{uid} status to
// 'approved', and appends an approvals log entry; revoking deactivates
// the license and returns the user to 'pending'. Non-admin callers get a
// 403 and nothing is written (applyAccessToggle checks first).
export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }
  const decoded = await verifyRequest(req, res);
  if (!decoded) return;

  const body = (req.body || {}) as { uid?: unknown; approved?: unknown };
  if (typeof body.uid !== 'string' || !body.uid) {
    res.status(400).json({ success: false, error: 'uid is required.' });
    return;
  }
  if (typeof body.approved !== 'boolean') {
    res.status(400).json({ success: false, error: 'approved is required.' });
    return;
  }

  try {
    const user = await applyAccessToggle(decoded.uid, body.uid, body.approved, decoded.idToken);
    res.status(200).json({ success: true, user });
  } catch (err: any) {
    if (err instanceof AccessToggleError) {
      if (err.code === 'NOT_ADMIN') {
        res.status(403).json({ success: false, error: 'Admin access required.' });
        return;
      }
      if (err.code === 'USER_NOT_FOUND') {
        res.status(404).json({ success: false, error: 'User not found.' });
        return;
      }
    }
    console.error('[admin/set-access] failed:', err?.message || err);
    res.status(500).json({ success: false, error: 'Failed to update access.' });
  }
}
