/**
 * R21 — SSRF-safe public fetcher for the URL campaign scan.
 *
 * A server endpoint that fetches arbitrary user-supplied URLs is an
 * attack surface, so every fetch in the site-scan flow goes through
 * here: http/https only, no credentials in the URL, the hostname must
 * resolve exclusively to public IP addresses (checked before the
 * fetch and again at every redirect hop), redirects are followed
 * manually so each hop is re-validated, and time/size are hard-capped.
 */
import { lookup } from 'node:dns/promises';

export class SiteFetchError extends Error {
  code: 'blocked-host' | 'too-large' | 'timeout' | 'bad-url';
  constructor(code: SiteFetchError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) {
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) return true; // fe80::/10
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // fc00::/7
    const mapped = v6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SiteFetchError('bad-url', 'That does not look like a valid web address.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SiteFetchError('bad-url', 'Only http and https websites can be scanned.');
  }
  if (u.username || u.password) {
    throw new SiteFetchError('bad-url', 'Web addresses with embedded passwords cannot be scanned.');
  }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) {
    throw new SiteFetchError('blocked-host', 'Local network addresses cannot be scanned.');
  }
  // A literal IP is checked directly; a hostname must resolve ONLY to
  // public addresses (a single private answer is enough to refuse).
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    if (isPrivateIp(host)) throw new SiteFetchError('blocked-host', 'That address is not a public website.');
    return u;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new SiteFetchError('bad-url', 'That website address could not be resolved.');
  }
  if (!addresses.length || addresses.some((a) => isPrivateIp(a.address))) {
    throw new SiteFetchError('blocked-host', 'That address is not a public website.');
  }
  return u;
}

export interface PublicFetchResult {
  status: number;
  contentType: string;
  bytes: Uint8Array;
  finalUrl: string;
}

export async function fetchPublic(
  rawUrl: string,
  opts: { timeoutMs: number; maxBytes: number; accept: string },
): Promise<PublicFetchResult> {
  let current = rawUrl;
  const deadline = Date.now() + opts.timeoutMs;
  for (let hop = 0; hop <= 5; hop++) {
    const u = await assertPublicHttpUrl(current);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SiteFetchError('timeout', 'The website took too long to answer.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    let res: Response;
    try {
      res = await fetch(u, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RiddimRoomStudio/1.0; +https://riddimroom.com)',
          Accept: opts.accept,
        },
      });
    } catch {
      clearTimeout(timer);
      throw new SiteFetchError('timeout', 'The website could not be reached in time.');
    }
    clearTimeout(timer);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc || hop === 5) {
        return { status: res.status, contentType: res.headers.get('content-type') ?? '', bytes: new Uint8Array(), finalUrl: u.toString() };
      }
      current = new URL(loc, u).toString();
      continue;
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > opts.maxBytes) {
      throw new SiteFetchError('too-large', 'That page is too large to scan.');
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > opts.maxBytes) {
      throw new SiteFetchError('too-large', 'That page is too large to scan.');
    }
    return {
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      bytes: buf,
      finalUrl: u.toString(),
    };
  }
  throw new SiteFetchError('timeout', 'The website redirected too many times.');
}
