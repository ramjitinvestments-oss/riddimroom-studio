/**
 * R21 — client half of the URL campaign scan. Thin wrappers over
 * /api/site-scan and /api/site-image with the same honesty rules as
 * the transcription client: a non-JSON answer means the function
 * itself failed (timeout / platform error) and is named as such,
 * never masked behind a generic "try again".
 */
import type { ExtractedSite } from './siteExtract';

export type SiteScanOutcome =
  | { ok: true; scan: ExtractedSite }
  | { ok: false; error: string };

async function postJson(path: string, body: unknown, idToken: string): Promise<{ data: any; status: number; isJson: boolean }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  let data: any = null;
  if (isJson) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }
  return { data, status: res.status, isJson };
}

export async function requestSiteScan(rawUrl: string, idToken: string): Promise<SiteScanOutcome> {
  let result: { data: any; status: number; isJson: boolean };
  try {
    result = await postJson('/api/site-scan', { url: rawUrl }, idToken);
  } catch {
    return { ok: false, error: 'The scan could not reach the server — check your connection and try again.' };
  }
  if (!result.isJson || !result.data) {
    return { ok: false, error: 'The scan service did not answer in time — the website may be slow. Try again in a moment.' };
  }
  if (!result.data.success) {
    return { ok: false, error: result.data.error ?? 'That website could not be scanned.' };
  }
  return { ok: true, scan: result.data.scan as ExtractedSite };
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp',
};

export async function fetchSiteImageFile(
  imageUrl: string,
  idToken: string,
): Promise<{ ok: true; file: File } | { ok: false; error: string }> {
  let result: { data: any; status: number; isJson: boolean };
  try {
    result = await postJson('/api/site-image', { url: imageUrl }, idToken);
  } catch {
    return { ok: false, error: 'That image could not be loaded — check your connection and try again.' };
  }
  if (!result.isJson || !result.data?.success) {
    return { ok: false, error: result?.data?.error ?? 'That image could not be loaded from the website.' };
  }
  const mimeType = String(result.data.mimeType || 'image/jpeg');
  const binary = atob(String(result.data.base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const ext = MIME_EXT[mimeType] ?? 'jpg';
  let base = 'website-image';
  try {
    const leaf = new URL(imageUrl).pathname.split('/').filter(Boolean).pop() ?? '';
    const clean = leaf.replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '');
    if (clean) base = clean;
  } catch {
    /* keep the default name */
  }
  const file = new File([bytes], `${base}.${ext}`, { type: mimeType });
  return { ok: true, file };
}
