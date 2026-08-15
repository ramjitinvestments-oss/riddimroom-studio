// Phase 1 Step 10 verification — unit tests for the transcription provider
// abstraction's most important behavior: refuse to fake success when a
// credential/endpoint is genuinely unconfigured. No server, no emulator,
// no network — these run the actual provider classes directly.
import { GeminiTranscriptionProvider } from './src/lib/transcription/gemini';
import { WhisperTranscriptionProvider } from './src/lib/transcription/whisper';
import { TranscriptionConfigurationError } from './src/lib/transcription/types';

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`PASS: ${name}`);
    passed++;
  } else {
    console.log(`FAIL: ${name}${detail ? ' -- ' + detail : ''}`);
    failed++;
  }
}

async function expectConfigError(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(name, false, 'did not throw');
  } catch (err) {
    check(name, err instanceof TranscriptionConfigurationError, `threw ${(err as Error)?.constructor?.name}: ${(err as Error)?.message}`);
  }
}

async function main() {
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalWhisperUrl = process.env.WHISPER_API_URL;

  delete process.env.GEMINI_API_KEY;
  await expectConfigError('Gemini provider throws TranscriptionConfigurationError with no GEMINI_API_KEY set', () =>
    new GeminiTranscriptionProvider().transcribe({ mediaUrl: 'https://example.com/x.mp4', mimeType: 'video/mp4' }),
  );

  process.env.GEMINI_API_KEY = 'MY_GEMINI_API_KEY'; // the literal placeholder from .env.example
  await expectConfigError('Gemini provider treats the unedited .env.example placeholder as unconfigured', () =>
    new GeminiTranscriptionProvider().transcribe({ mediaUrl: 'https://example.com/x.mp4', mimeType: 'video/mp4' }),
  );

  delete process.env.WHISPER_API_URL;
  await expectConfigError('Whisper provider throws TranscriptionConfigurationError with no WHISPER_API_URL set', () =>
    new WhisperTranscriptionProvider().transcribe({ mediaUrl: 'https://example.com/x.mp4', mimeType: 'video/mp4' }),
  );

  // Neither provider should touch the network at all before the config check.
  const originalFetch = global.fetch;
  let fetchCalled = false;
  // @ts-expect-error test instrumentation
  global.fetch = (...args: unknown[]) => {
    fetchCalled = true;
    return originalFetch(...(args as Parameters<typeof fetch>));
  };
  delete process.env.GEMINI_API_KEY;
  try {
    await new GeminiTranscriptionProvider().transcribe({ mediaUrl: 'https://example.com/x.mp4', mimeType: 'video/mp4' });
  } catch {
    /* expected */
  }
  check('Gemini provider does not call fetch() before the config check fails', !fetchCalled);
  global.fetch = originalFetch;

  if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalGeminiKey;
  if (originalWhisperUrl === undefined) delete process.env.WHISPER_API_URL;
  else process.env.WHISPER_API_URL = originalWhisperUrl;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exitCode = 1;
});
