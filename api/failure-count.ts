import { verifyRequest, recordFailureCount, isFailureKind, type ApiRequest, type ApiResponse } from './_lib.js';

// R40 P-28: POST /api/failure-count — record ONE final failure count
// ({ kind: 'export' | 'save' | 'transcribe' }). Counts only: the body
// carries nothing else and nothing else is stored. Authenticated like
// every /api route (the caller's own token is the Firestore
// credential, per api/_lib.ts).
//
// Silent-degrade by design: when Firestore refuses the write (the
// published rules have no failureCounts branch yet — see the P-28
// note in _lib.ts), the answer is still a calm 202 with
// recorded:false. The client is fire-and-forget and never shows this
// endpoint's result to the user either way.
export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }
  const decoded = await verifyRequest(req, res);
  if (!decoded) return;

  const kind = (req.body as { kind?: unknown } | null | undefined)?.kind;
  if (!isFailureKind(kind)) {
    res.status(400).json({ success: false, error: 'Unknown failure kind.' });
    return;
  }

  try {
    await recordFailureCount(kind, decoded.idToken);
    res.status(200).json({ success: true, recorded: true });
  } catch (err: any) {
    console.warn('[failure-count] not recorded:', err?.message || err);
    res.status(202).json({ success: true, recorded: false });
  }
}
