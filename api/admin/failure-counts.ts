import { verifyRequest, fetchFailureCounts, AccessToggleError, type ApiRequest, type ApiResponse } from '../_lib.js';

// R40 P-28: GET /api/admin/failure-counts — the Admin screen's
// "What's failing" readout: failure counts by kind for today and the
// last 7 days. Admin-gated in fetchFailureCounts (refuses before
// listing anything when the caller has no admins/{uid} doc).
export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }
  const decoded = await verifyRequest(req, res);
  if (!decoded) return;

  try {
    const summary = await fetchFailureCounts(decoded.uid, decoded.idToken);
    res.status(200).json({ success: true, summary });
  } catch (err: any) {
    if (err instanceof AccessToggleError && err.code === 'NOT_ADMIN') {
      res.status(403).json({ success: false, error: 'Admin access required.' });
      return;
    }
    console.error('[admin/failure-counts] failed:', err?.message || err);
    res.status(500).json({ success: false, error: 'Failed to load failure counts.' });
  }
}
