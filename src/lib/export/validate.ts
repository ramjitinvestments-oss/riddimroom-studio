/**
 * Basic sanity checks on an export's output — per the explicit requirement
 * not to claim an export worked unless it actually produced a usable
 * output. Not a full media-integrity check (that would need a decode
 * pass), but catches the two most likely silent-failure modes: a
 * CORS-tainted canvas (produces a near-empty recording) and a recorder
 * that stopped before any data was captured.
 */

export interface RenderValidation {
  valid: boolean;
  error?: string;
}

/** ~2KB/second of real video is a very conservative floor — well below even low-bitrate webm. */
const MIN_BYTES_PER_SECOND = 2000;

export function validateRenderResult(blob: Blob, durationSeconds: number): RenderValidation {
  if (blob.size === 0) {
    return { valid: false, error: 'Export produced an empty file. This usually means the browser blocked canvas capture (see storage.cors.json requirements).' };
  }
  const minBytes = Math.max(1024, durationSeconds * MIN_BYTES_PER_SECOND);
  if (blob.size < minBytes) {
    return {
      valid: false,
      error: `Export produced a suspiciously small file (${blob.size} bytes for ${durationSeconds.toFixed(1)}s). This usually means the Storage bucket's CORS configuration is blocking canvas capture — see storage.cors.json.`,
    };
  }
  if (!blob.type.startsWith('video/')) {
    return { valid: false, error: `Export produced an unexpected file type "${blob.type}".` };
  }
  return { valid: true };
}
