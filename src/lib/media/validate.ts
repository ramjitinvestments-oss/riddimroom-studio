/**
 * RiddimRoom Studio — client-side media upload validation.
 *
 * Runs before any bytes are sent to Firebase Storage, so obviously-bad
 * uploads (wrong type, absurd size, empty file) fail fast with a clear
 * message instead of burning bandwidth/quota on an upload that Storage
 * rules would accept (the rules only check ownership, not content).
 */

export interface MediaValidationResult {
  valid: boolean;
  error?: string;
}

const ACCEPTED_PREFIXES = ['video/', 'image/', 'audio/'];

/** Generous but real ceiling — this is client-side capture/upload, not a bulk-media ingestion pipeline. */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB

export function validateMediaFile(file: File): MediaValidationResult {
  if (!file) {
    return { valid: false, error: 'No file selected.' };
  }
  if (file.size === 0) {
    return { valid: false, error: 'This file is empty (0 bytes).' };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return { valid: false, error: `File is ${mb} MB, which exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload limit.` };
  }
  const mimeType = file.type || '';
  if (!ACCEPTED_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) {
    return { valid: false, error: `Unsupported file type "${mimeType || 'unknown'}". Please choose an image, video, or audio file.` };
  }
  return { valid: true };
}
