/**
 * RiddimRoom Studio — transcription provider abstraction (Phase 1 Step 10).
 *
 * Server-side only (see `server.ts`'s `POST /api/transcribe`) — the actual
 * Gemini API key must never reach the client bundle, per the Phase 1
 * security requirements ("No API secrets are exposed in client code").
 * Whisper is kept as a second implementation of the same interface (a real
 * fallback abstraction, not a placeholder) so a future step can wire an
 * actual Whisper endpoint in without touching the caller.
 */

export interface TranscriptionWord {
  text: string;
  /** Seconds from the start of the supplied media. */
  start: number;
  /** Seconds from the start of the supplied media. */
  end: number;
}

export interface TranscriptionRequest {
  /** A URL the provider can fetch the media bytes from (e.g. a Firebase Storage download URL). */
  mediaUrl: string;
  mimeType: string;
  /** Optional — helps some providers/prompts, not required. */
  durationSeconds?: number;
}

export interface TranscriptionResult {
  words: TranscriptionWord[];
  provider: string;
}

/** Thrown when a provider is selected but not actually configured (missing API key/URL) — never silently faked. */
export class TranscriptionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptionConfigurationError';
  }
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}
