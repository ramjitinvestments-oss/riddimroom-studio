import type { ApiRequest, ApiResponse } from './_lib.js';
import siteImageHandler from './_site-image.js';
import siteScanHandler from './_site-scan.js';

// One Vercel function for the two R21 site endpoints. Their public
// paths (/api/site-scan and /api/site-image) are single top-level
// segments, so this root dispatcher selects the pre-existing handler
// by that segment; every other top-level route remains a static file
// and takes routing precedence over this dynamic route.
//
// The handlers historically exported separate maxDuration values
// (60s for scan, 30s for image). The shared function uses the 60s
// ceiling: the image handler's own upstream fetch still times out at
// 10s, so its observable behaviour is unchanged.
export const config = { maxDuration: 60 };

interface RoutedRequest extends ApiRequest {
  query?: Record<string, string | string[] | undefined>;
  url?: string;
}

function actionFrom(req: RoutedRequest): string | undefined {
  const queried = req.query?.action;
  if (typeof queried === 'string' && queried) return queried;
  if (Array.isArray(queried) && queried[0]) return queried[0];
  if (req.url) {
    try {
      const parts = new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean);
      return parts[parts.length - 1];
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export default async function handler(req: RoutedRequest, res: ApiResponse) {
  switch (actionFrom(req)) {
    case 'site-scan':
      return siteScanHandler(req, res);
    case 'site-image':
      return siteImageHandler(req, res);
    default:
      res.status(404).json({ success: false, error: 'Not found.' });
  }
}
