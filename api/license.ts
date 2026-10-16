import { verifyRequest, getLicenseTier, type ApiRequest, type ApiResponse } from './_lib';

// v1 Licensing: GET /api/license — tier + whether checkout is configured.
// Mirrors server.ts.
export default async function handler(req: ApiRequest, res: ApiResponse) {
  const decoded = await verifyRequest(req, res);
  if (!decoded) return;
  const tier = await getLicenseTier(decoded.uid);
  res.status(200).json({
    tier,
    watermarkEnabled: tier !== 'lifetime',
    checkoutAvailable: !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID_LIFETIME),
  });
}
