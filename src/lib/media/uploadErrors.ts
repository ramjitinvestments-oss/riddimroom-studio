/**
 * R40 P-14 — plain words for upload failures. The import surface
 * never shows a raw error message or a service code to the user:
 * every failure is mapped here to one plain sentence that says what
 * happened and what to do next.
 */

export const UPLOAD_QUOTA_MESSAGE =
  "You're out of storage space — delete something or free up space, then try again";
export const UPLOAD_TOO_LARGE_MESSAGE = "This file is too large to upload — pick a smaller one, then try again";
export const UPLOAD_UNAUTHORIZED_MESSAGE = "You're not signed in properly — sign in again, then try again";
export const UPLOAD_NETWORK_MESSAGE = 'The connection dropped — check it, then tap Retry';
export const UPLOAD_UNSUPPORTED_MESSAGE = "This kind of file can't be uploaded — pick a video, photo or audio file";
export const UPLOAD_EMPTY_MESSAGE = "This file is empty, so there's nothing to upload";
export const UPLOAD_UNKNOWN_MESSAGE = "The upload didn't go through — tap Retry to try again";

function errorText(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err.toLowerCase();
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';
  return `${code} ${message}`.toLowerCase();
}

/**
 * Map any upload failure (a storage error, a network failure, or the
 * local validation message) to its one plain sentence. The raw text
 * is used ONLY to pick the sentence — it is never returned.
 */
export function humanizeUploadError(err: unknown): string {
  const text = errorText(err);
  if (!text.trim()) return UPLOAD_UNKNOWN_MESSAGE;
  if (text.includes('quota')) return UPLOAD_QUOTA_MESSAGE;
  if (
    text.includes('unauthorized') ||
    text.includes('permission') ||
    text.includes('not signed in') ||
    text.includes('auth/')
  ) {
    return UPLOAD_UNAUTHORIZED_MESSAGE;
  }
  if (
    text.includes('exceeds') ||
    text.includes('too large') ||
    text.includes('file-size') ||
    text.includes('object-too-large') ||
    text.includes('payload-too-large')
  ) {
    return UPLOAD_TOO_LARGE_MESSAGE;
  }
  if (text.includes('unsupported file type')) return UPLOAD_UNSUPPORTED_MESSAGE;
  if (text.includes('empty')) return UPLOAD_EMPTY_MESSAGE;
  if (
    text.includes('network') ||
    text.includes('offline') ||
    text.includes('failed to fetch') ||
    text.includes('unavailable') ||
    text.includes('retry-limit') ||
    text.includes('canceled') ||
    text.includes('cancelled') ||
    text.includes('timed out') ||
    text.includes('timeout')
  ) {
    return UPLOAD_NETWORK_MESSAGE;
  }
  return UPLOAD_UNKNOWN_MESSAGE;
}
