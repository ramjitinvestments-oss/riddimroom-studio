import { verifyRequest, fsGetDoc, type ApiRequest, type ApiResponse } from './_lib.js';
import { fetchPublic, SiteFetchError } from './_siteFetch.js';
import { extractSite, type SitePageDoc } from '../src/lib/promo/siteExtract.js';

// R21 — URL campaign scan. Deterministic extraction only: NO AI, no
// external service, $0 by construction. Mirrors api/promo-analyze.ts's
// auth + access gate (the endpoint spends server resources fetching
// third-party sites, so it is approved-accounts/admins only) plus a
// soft per-account daily cap. Scanned HTML is processed in memory and
// never stored server-side.
export const config = { maxDuration: 60 };

const MAX_SCANS_PER_DAY = 10;
const scanCounts = new Map<string, { day: string; count: number }>();

function scanAllowed(uid: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const entry = scanCounts.get(uid);
  if (!entry || entry.day !== day) {
    scanCounts.set(uid, { day, count: 1 });
    return true;
  }
  if (entry.count >= MAX_SCANS_PER_DAY) return false;
  entry.count += 1;
  return true;
}

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
    res.status(400).json({ success: false, error: 'A website address is required.' });
    return;
  }
  const rawUrl = body.url.trim().match(/^https?:\/\//i) ? body.url.trim() : `https://${body.url.trim()}`;

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
            ? "Your access isn't switched on yet — website scanning is available once the owner approves your account."
            : 'Account access restricted',
      });
      return;
    }
    if (!scanAllowed(uid)) {
      res.status(429).json({ success: false, error: 'You have reached today’s website scan limit — try again tomorrow.' });
      return;
    }

    const decoder = new TextDecoder('utf-8', { fatal: false });
    const home = await fetchPublic(rawUrl, { timeoutMs: 10_000, maxBytes: 2_000_000, accept: 'text/html' });
    const pages: SitePageDoc[] = [
      { url: home.finalUrl, html: home.status < 400 ? decoder.decode(home.bytes) : '', status: home.status },
    ];
    let scan = extractSite(pages);

    // Follow the discovered offer pages (same-domain, capped by the
    // extractor) so a campaign can be grounded in the offer's own
    // page, not just the homepage. Failures are skipped silently —
    // the homepage read still stands on its own.
    if (scan.readable && scan.offerLinks.length) {
      for (const link of scan.offerLinks) {
        try {
          const doc = await fetchPublic(link, { timeoutMs: 6_000, maxBytes: 1_000_000, accept: 'text/html' });
          if (doc.status < 400) {
            pages.push({ url: doc.finalUrl, html: decoder.decode(doc.bytes), status: doc.status });
          }
        } catch {
          /* one unreadable offer page never sinks the scan */
        }
      }
      scan = extractSite(pages);
    }

    res.status(200).json({ success: true, scan });
  } catch (err: any) {
    if (err instanceof SiteFetchError) {
      const statusCode = err.code === 'bad-url' || err.code === 'blocked-host' ? 400 : 502;
      res.status(statusCode).json({ success: false, code: err.code, error: err.message });
      return;
    }
    console.error('[site-scan] failed:', err?.message || err);
    res.status(502).json({ success: false, code: 'failed', error: 'The website could not be scanned — check the address and try again.' });
  }
}
