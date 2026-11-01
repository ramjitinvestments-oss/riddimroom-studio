import {
  verifyRequest,
  applyAccessToggle,
  AccessToggleError,
  type ApiRequest,
  type ApiResponse,
  type AccessState,
} from '../_lib.js';

// R28: POST /api/admin/set-access { uid, access } — the owner's control
// in the Admin screen, with THREE access states: 'pending' (users/{uid}
// status 'pending', license deactivated), 'basic' (status 'approved',
// licenses/{uid} tier 'free', active) and 'premium' (status 'approved',
// licenses/{uid} tier 'lifetime', active — the records a Stripe webhook
// would write later). Every change appends an approvals log entry.
// Backward-compat: a boolean `approved` body (true → 'premium',
// false → 'pending') is still accepted when `access` is absent.
// Non-admin callers get a 403 and nothing is written
// (applyAccessToggle checks first).
const ACCESS_STATES: AccessState[] = ['pending', 'basic', 'premium'];

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }
  const decoded = await verifyRequest(req, res);
  if (!decoded) return;

  const body = (req.body || {}) as { uid?: unknown; approved?: unknown; access?: unknown };
  if (typeof body.uid !== 'string' || !body.uid) {
    res.status(400).json({ success: false, error: 'uid is required.' });
    return;
  }
  let state: AccessState;
  if (body.access !== undefined) {
    if (typeof body.access !== 'string' || !ACCESS_STATES.includes(body.access as AccessState)) {
      res.status(400).json({ success: false, error: 'access is required.' });
      return;
    }
    state = body.access as AccessState;
  } else if (typeof body.approved === 'boolean') {
    state = body.approved ? 'premium' : 'pending';
  } else {
    res.status(400).json({ success: false, error: 'access is required.' });
    return;
  }

  try {
    const user = await applyAccessToggle(decoded.uid, body.uid, state, decoded.idToken);
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
