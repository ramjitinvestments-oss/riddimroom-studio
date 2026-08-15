/**
 * RiddimRoom Studio — Whisper fallback transcription provider (Step 10).
 *
 * Per the Phase 0 addendum, riddimroom-caption's Whisper deployment path
 * was already flagged as "unconfirmed" before this build step started (see
 * the implementation roadmap's Risks section) — there is no known-good
 * Whisper endpoint to port credentials for. Rather than inventing new
 * infrastructure (a bundled model, a hardcoded third-party endpoint) for a
 * dependency that was never confirmed to exist, this implements the real
 * provider *contract* against a configurable HTTP endpoint
 * (`WHISPER_API_URL`) — any Whisper-compatible transcription service the
 * project owner deploys later can be pointed at by setting one environment
 * variable, no code change required. If `WHISPER_API_URL` is unset (the
 * expected Phase 1 state), this throws a clear configuration error
 * immediately rather than silently no-op'ing or faking a transcript.
 */

import { TranscriptionConfigurationError, type TranscriptionProvider, type TranscriptionRequest, type TranscriptionResult } from './types';

export class WhisperTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'whisper';

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const endpoint = process.env.WHISPER_API_URL;
    if (!endpoint) {
      throw new TranscriptionConfigurationError(
        'WHISPER_API_URL is not configured — no Whisper fallback endpoint is deployed. Set WHISPER_API_URL to a Whisper-compatible transcription service to enable this fallback.',
      );
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaUrl: request.mediaUrl, mimeType: request.mimeType }),
    });
    if (!res.ok) {
      throw new Error(`Whisper endpoint returned HTTP ${res.status}.`);
    }
    const data = (await res.json()) as { words?: Array<{ text: string; start: number; end: number }> };
    const words = (data.words ?? []).filter(
      (w) => typeof w.text === 'string' && w.text.length > 0 && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start,
    );
    return { words, provider: this.name };
  }
}
