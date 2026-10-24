/**
 * Client-side wording for transcription failures that never produce a
 * JSON API response (TranscribePanel). Pure and dependency-free so it
 * can be unit-tested without rendering the panel.
 *
 * Why this exists: the serverless host answers a 60s timeout (and some
 * platform failures) with an HTML error page, and a network failure
 * rejects the fetch outright. An earlier version mapped those cases to
 * "Transcription isn't available on this preview build yet." — a false
 * claim on production, where the API exists and the real problem was a
 * timeout. These messages name the actual failure class and the remedy
 * (retry), and never mention a "preview build".
 */

export const TRANSCRIBE_NO_RESPONSE_MESSAGE =
  "The transcription service didn't respond in time — this is usually a timeout or a temporary server problem, not an issue with your clip. Please try again.";

export const TRANSCRIBE_UNREACHABLE_MESSAGE =
  "Couldn't reach the transcription service. Check your connection and try again.";

export const TRANSCRIBE_UNREADABLE_RESPONSE_MESSAGE =
  'The transcription service returned an unreadable response. Please try again.';

/** The response arrived but wasn't JSON (e.g. an HTML platform timeout page). */
export function messageForNonJsonTranscribeResponse(): string {
  return TRANSCRIBE_NO_RESPONSE_MESSAGE;
}

/** The fetch itself threw (network failure, abort, or a body-parse error). */
export function messageForTranscribeFetchFailure(err: unknown): string {
  // res.json() on a non-JSON body rejects with a SyntaxError.
  if (err instanceof SyntaxError) return TRANSCRIBE_UNREADABLE_RESPONSE_MESSAGE;
  // fetch() network failures surface as TypeError in browsers.
  if (err instanceof TypeError) return TRANSCRIBE_UNREACHABLE_MESSAGE;
  const msg = (err as { message?: unknown } | null)?.message;
  return typeof msg === 'string' && msg ? msg : 'Transcription request failed.';
}
