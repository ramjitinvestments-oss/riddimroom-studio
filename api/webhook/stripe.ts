import type { ApiRequest, ApiResponse } from '../_lib.js';

// v1 Licensing: POST /api/webhook/stripe — Stripe webhook stub (mirrors
// server.ts). Signature verification + license writes land with the Stripe
// wiring; until then, clear errors only.
export default async function handler(_req: ApiRequest, res: ApiResponse) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    res.status(400).json({ success: false, error: 'Stripe webhook not configured (missing STRIPE_WEBHOOK_SECRET).' });
    return;
  }
  res.status(501).json({ success: false, error: 'Stripe webhook verification not yet implemented. See server.ts TODO.' });
}
