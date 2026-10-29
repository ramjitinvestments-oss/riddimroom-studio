/**
 * Basic sanity checks on an export's output — per the explicit requirement
 * not to claim an export worked unless it actually produced a usable
 * output. Not a full media-integrity check (that would need a decode
 * pass), but catches the two most likely silent-failure modes: a
 * CORS-tainted canvas (produces a near-empty recording) and a recorder
 * that stopped before any data was captured.
 *
 * R34 (R33 audit §2): the user-facing `error` is the one plain string
 * from exportErrors.ts — developer detail (byte counts, the CORS cause)
 * goes to console.warn only, never into the message a user reads.
 */

import { EXPORT_FINISHING_ERROR } from './exportErrors';

export interface RenderValidation {
  valid: boolean;
  error?: string;
}

/** ~2KB/second of real video is a very conservative floor — well below even low-bitrate webm. */
const MIN_BYTES_PER_SECOND = 2000;

export function validateRenderResult(blob: Blob, durationSeconds: number): RenderValidation {
  if (blob.size === 0) {
    // eslint-disable-next-line no-console
    console.warn('[validate] export produced an empty file (0 bytes) — likely blocked canvas capture / storage CORS.');
    return { valid: false, error: EXPORT_FINISHING_ERROR };
  }
  const minBytes = Math.max(1024, durationSeconds * MIN_BYTES_PER_SECOND);
  if (blob.size < minBytes) {
    // eslint-disable-next-line no-console
    console.warn(
      `[validate] export produced a suspiciously small file (${blob.size} bytes for ${durationSeconds.toFixed(1)}s, floor ${minBytes}) — likely blocked canvas capture / storage CORS.`,
    );
    return { valid: false, error: EXPORT_FINISHING_ERROR };
  }
  if (!blob.type.startsWith('video/')) {
    // eslint-disable-next-line no-console
    console.warn(`[validate] export produced an unexpected file type "${blob.type}".`);
    return { valid: false, error: EXPORT_FINISHING_ERROR };
  }
  return { valid: true };
}
