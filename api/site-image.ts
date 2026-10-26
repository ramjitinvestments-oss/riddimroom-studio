import { verifyRequest, fsGetDoc, type ApiRequest, type ApiResponse } from './_lib.js';
import { fetchPublic, SiteFetchError } from './_siteFetch.js';

// R21 — guarded image fetch for URL campaigns. Site images live on
// third-party hosts whose CORS rules would taint or block the canvas
// pipeline, so the bytes travel through this endpoint instead. Same
// auth + approved gate as api/site-scan.ts, same SSRF-safe fetcher,
// image content-types only, 8 MB cap. The response is base64 JSON —
// the same transport api/promo-analyze.ts already uses for images.
export const config = { maxDuration: 30 };

const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp',
]);

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }
  const decoded = await verifyRequest(req, res);
  if (!decoded) return;
  const uid = decoded.uid;
  const idToken = decoded.idToken;

  const body = (req.body || {}) as { url?: unknown };
  if (typeof body.url !== 'string' || !body.url.trim()) {
    res.status(400).json({ success: false, error: 'An image address is required.' });
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
      res.status(403).json({ success: false, error: 'Account access restricted' });
      return;
    }

    const result = await fetchPublic(body.url.trim(), {
      timeoutMs: 10_000,
      maxBytes: 8_000_000,
      accept: 'image/*',
    });
    if (result.status >= 400) {
      res.status(502).json({ success: false, error: 'That image could not be loaded from the website.' });
      return;
    }
    const mimeType = result.contentType.split(';')[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
      res.status(415).json({ success: false, error: 'That file is not a supported image.' });
      return;
    }
    const base64 = Buffer.from(result.bytes).toString('base64');
    res.status(200).json({ success: true, base64, mimeType, finalUrl: result.finalUrl });
  } catch (err: any) {
    if (err instanceof SiteFetchError) {
      res.status(err.code === 'bad-url' || err.code === 'blocked-host' ? 400 : 502)
        .json({ success: false, code: err.code, error: err.message });
      return;
    }
    console.error('[site-image] failed:', err?.message || err);
    res.status(502).json({ success: false, code: 'failed', error: 'That image could not be loaded — try another image or upload your own.' });
  }
}
