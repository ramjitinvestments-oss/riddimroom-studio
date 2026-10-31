import { verifyRequest, recordDeletionRequest, type ApiRequest, type ApiResponse } from '../_lib.js';

// R40 P-27: POST /api/account/delete-request — record the signed-in
// user's account-deletion request ({ requestedAt, email } in
// accountDeletionRequests/{uid}). Recording only: nothing is deleted
// by this endpoint — the owner completes requests by hand (revoke
// access in Admin, then delete the user in the Firebase console).
//
// Silent-degrade by design, mirroring /api/failure-count: when
// Firestore refuses the write (the published rules have no branch for
// this collection yet), the answer is still a calm 202 with
// recorded:false. The client is fire-and-forget either way, and the
// dialog always offers the email route alongside.
export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }
  const decoded = await verifyRequest(req, res);
  if (!decoded) return;

  try {
    await recordDeletionRequest(decoded.uid, decoded.email, decoded.idToken);
    res.status(200).json({ success: true, recorded: true });
  } catch (err: any) {
    console.warn('[account/delete-request] not recorded:', err?.message || err);
    res.status(202).json({ success: true, recorded: false });
  }
}
