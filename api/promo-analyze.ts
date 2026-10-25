import { verifyRequest, fsGetDoc, type ApiRequest, type ApiResponse } from './_lib.js';
import { analyzePromoImage, PromoVisionBusyError, PromoVisionConfigurationError } from '../src/lib/promo/vision.js';

// Artwork analysis for Viral Promo auto-captions. Mirrors
// api/transcribe.ts's auth + access gate (approved accounts and admins
// only — it spends the project's Gemini quota), but takes the image
// inline (base64, downscaled client-side) instead of a storage URL:
// promo artwork is picked from the device and never uploaded to
// storage, so there is no owned-URL to check. The image is capped at
// ~6MB of base64 (~4.5MB decoded) — the client sends ≤1024px JPEG.
export const config = { maxDuration: 60 };

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BASE64_CHARS = 6_000_000;

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }
  const decoded = await verifyRequest(req, res);
  if (!decoded) return;
  const uid = decoded.uid;
  const idToken = decoded.idToken;

  const body = (req.body || {}) as { imageBase64?: unknown; mimeType?: unknown };
  const { imageBase64, mimeType } = body;
  if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
    res.status(400).json({ success: false, error: 'imageBase64 is required.' });
    return;
  }
  if (imageBase64.length > MAX_BASE64_CHARS) {
    res.status(413).json({ success: false, error: 'That image is too large to analyze — it is downscaled automatically, so please try again.' });
    return;
  }
  if (typeof mimeType !== 'string' || !ALLOWED_MIME.has(mimeType)) {
    res.status(400).json({ success: false, error: 'mimeType must be image/jpeg, image/png or image/webp.' });
    return;
  }

  try {
    const userDoc = await fsGetDoc(`users/${uid}`, idToken);
    if (!userDoc.exists) {
      res.status(404).json({ success: false, error: 'User profile not found — call /api/user/status first.' });
      return;
    }
    const callerIsAdmin = (await fsGetDoc(`admins/${uid}`, idToken)).exists;
    const status = (userDoc.data as { status?: string }).status;
    if (!callerIsAdmin && status !== 'approved') {
      res.status(403).json({
        success: false,
        error:
          status === 'pending'
            ? "Your access isn't switched on yet — artwork analysis is available once the owner approves your account."
            : 'Account access restricted',
      });
      return;
    }

    const suggestion = await analyzePromoImage({ imageBase64, mimeType });
    res.status(200).json({ success: true, suggestion });
  } catch (err: any) {
    if (err instanceof PromoVisionConfigurationError) {
      // Not a failure of the request — the deployment simply has no
      // Gemini key yet. The client falls back to its built-in copy
      // bank, says so in plain words, and the user is never blocked.
      res.status(503).json({ success: false, code: 'not_configured', error: err.message });
      return;
    }
    if (err instanceof PromoVisionBusyError) {
      res.status(503).json({ success: false, code: 'busy', error: 'The artwork reader is busy — try the read again in a moment.' });
      return;
    }
    console.error('[promo-analyze] failed:', err?.message || err);
    res.status(502).json({ success: false, code: 'failed', error: 'Artwork analysis failed — built-in suggestions were used instead.' });
  }
}
