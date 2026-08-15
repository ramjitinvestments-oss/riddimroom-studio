import { GeminiTranscriptionProvider } from './gemini';
import { WhisperTranscriptionProvider } from './whisper';
import type { TranscriptionProvider } from './types';

export * from './types';

const providers: Record<string, () => TranscriptionProvider> = {
  gemini: () => new GeminiTranscriptionProvider(),
  whisper: () => new WhisperTranscriptionProvider(),
};

/**
 * Gemini is primary per the Phase 1 requirement. Whisper is a real fallback
 * abstraction a caller can select explicitly (e.g. if Gemini is
 * unconfigured or fails) — `server.ts`'s `/api/transcribe` tries Gemini
 * first and only falls back to Whisper on a `TranscriptionConfigurationError`
 * from Gemini, not on every error (a transient Gemini failure should not
 * silently reroute to a different, unproven provider).
 */
export function getTranscriptionProvider(name: 'gemini' | 'whisper'): TranscriptionProvider {
  return providers[name]();
}
