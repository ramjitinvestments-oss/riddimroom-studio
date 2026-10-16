import { verifyRequest, getLicenseTier, type ApiRequest, type ApiResponse } from './_lib';

// v1 Licensing: POST /api/checkout — Stripe Checkout stub (mirrors
// server.ts). Until Stripe keys + session creation are wired, this returns
// a clear 503 — never invent keys or charge.
export default async function handler(req: ApiRequest, res: ApiResponse) {
  const decoded = await verifyRequest(req, res);
  if (!decoded) return;
  const tier = await getLicenseTier(decoded.uid);
  if (tier === 'lifetime') {
    res.status(200).json({ success: true, tier, message: 'Already lifetime.' });
    return;
  }
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID_LIFETIME) {
    res.status(503).json({ success: false, error: 'Checkout is not configured yet (missing STRIPE_SECRET_KEY / STRIPE_PRICE_ID_LIFETIME).' });
    return;
  }
  res.status(503).json({ success: false, error: 'Stripe Checkout wiring is pending — keys are set but the session creation is not yet implemented. See server.ts TODO.' });
}
