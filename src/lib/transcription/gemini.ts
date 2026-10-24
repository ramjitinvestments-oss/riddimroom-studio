/**
 * RiddimRoom Studio — Gemini transcription provider (primary, Step 10).
 *
 * Server-side only. Reads `GEMINI_API_KEY` from `process.env` (populated
 * via `.env` / real environment variables — see `.env.example` — never
 * hardcoded, never sent to the client). Uploads the media to Gemini's
 * Files API, waits for it to finish processing, then asks the model for a
 * word-level transcript as structured JSON (a `responseSchema`, not
 * regex-parsed prose) so `TranscriptionResult.words` is reliably shaped.
 *
 * If `GEMINI_API_KEY` is unset, `transcribe()` throws
 * `TranscriptionConfigurationError` immediately, before any network call —
 * per the explicit instruction not to fake successful transcription when a
 * credential is genuinely unavailable.
 */

import { GoogleGenAI, createPartFromUri, createPartFromText, createUserContent, Type } from '@google/genai';
import { TranscriptionConfigurationError, type TranscriptionProvider, type TranscriptionRequest, type TranscriptionResult } from './types.js';
import { summarizeModelFailures, type ModelAttemptFailure } from './errors.js';

/**
 * Model candidates, tried in order. Google gates models by account
 * vintage: a key from a brand-new (free-tier) project gets 404
 * "models/gemini-2.5-flash is no longer available to new users" and is
 * directed to the newer flash model, while older paid projects still
 * serve 2.5-flash. Trying both keeps one build working with either key.
 */
const MODELS = ['gemini-3.8-flash', 'gemini-2.5-flash'];
const FILE_READY_POLL_INTERVAL_MS = 1000;
// The serverless host kills invocations at 60s, so every internal wait
// lives well inside that: file processing gets 30s, generation attempts
// stop by ~50s wall clock, and the endpoint returns a clean JSON error
// instead of dying as a platform timeout.
const FILE_READY_TIMEOUT_MS = 30_000;
const GENERATE_DEADLINE_MS = 50_000;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    words: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          text: { type: Type.STRING },
          start: { type: Type.NUMBER },
          end: { type: Type.NUMBER },
        },
        required: ['text', 'start', 'end'],
      },
    },
  },
  required: ['words'],
};

const PROMPT = [
  'Transcribe the speech in this media file.',
  'Return every spoken word with its start and end time in seconds, measured from the beginning of the file.',
  'Word timings must be non-overlapping and strictly increasing.',
  'If there is no speech, return an empty words array.',
].join(' ');

async function waitUntilActive(ai: GoogleGenAI, name: string): Promise<void> {
  const deadline = Date.now() + FILE_READY_TIMEOUT_MS;
  for (;;) {
    const file = await ai.files.get({ name });
    if (file.state === 'ACTIVE') return;
    if (file.state === 'FAILED') {
      throw new Error(`Gemini file processing failed for "${name}".`);
    }
    if (Date.now() > deadline) {
      throw new Error(`Gemini file "${name}" did not become ready within ${FILE_READY_TIMEOUT_MS / 1000}s.`);
    }
    await new Promise((resolve) => setTimeout(resolve, FILE_READY_POLL_INTERVAL_MS));
  }
}

export class GeminiTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'gemini';

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      throw new TranscriptionConfigurationError(
        'GEMINI_API_KEY is not configured on the server. Set a real key in the environment (see .env.example) to enable AI transcription.',
      );
    }

    const ai = new GoogleGenAI({ apiKey });

    const mediaResponse = await fetch(request.mediaUrl);
    if (!mediaResponse.ok) {
      throw new Error(`Could not download media for transcription (HTTP ${mediaResponse.status}).`);
    }
    const arrayBuffer = await mediaResponse.arrayBuffer();
    const blob = new Blob([arrayBuffer], { type: request.mimeType });

    const uploaded = await ai.files.upload({ file: blob, config: { mimeType: request.mimeType } });
    if (!uploaded.uri || !uploaded.name) {
      throw new Error('Gemini file upload did not return a usable file reference.');
    }

    try {
      await waitUntilActive(ai, uploaded.name);

      // Model strategy, bounded by GENERATE_DEADLINE_MS:
      // - 404 / NOT_FOUND: this key's account can't use that model —
      //   fall through to the next candidate.
      // - 503 / UNAVAILABLE: free-tier demand spike — retry the same model
      //   once after a short pause, then fall through.
      // - anything else (quota, billing, bad media) is real: propagate.
      const generateStartedAt = Date.now();
      let response;
      // Per-model failures, in the order the models were tried. If every
      // candidate fails, the thrown error summarizes ALL of them with
      // the primary first (see errors.ts) — never just the last model's
      // message, which misattributes the failure to the fallback.
      const modelFailures: ModelAttemptFailure[] = [];
      outer: for (const model of MODELS) {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (Date.now() - generateStartedAt > GENERATE_DEADLINE_MS) break outer;
          try {
            response = await ai.models.generateContent({
              model,
              contents: createUserContent([createPartFromUri(uploaded.uri, uploaded.mimeType || request.mimeType), createPartFromText(PROMPT)]),
              config: {
                responseMimeType: 'application/json',
                responseSchema: RESPONSE_SCHEMA,
              },
            });
            break outer;
          } catch (err: any) {
            const msg = String(err?.message || err);
            if (/404|NOT_FOUND|no longer available|not found/i.test(msg)) {
              modelFailures.push({ model, message: msg });
              break; // next model
            }
            if (/503|UNAVAILABLE|high demand/i.test(msg) && attempt === 0) {
              await new Promise((resolve) => setTimeout(resolve, 3000));
              continue; // one retry on this model
            }
            if (/503|UNAVAILABLE|high demand/i.test(msg)) {
              modelFailures.push({ model, message: msg });
              break; // next model after retry
            }
            throw err;
          }
        }
      }
      if (!response) throw new Error(summarizeModelFailures(modelFailures));

      const text = response.text;
      if (!text) {
        throw new Error('Gemini returned an empty transcription response.');
      }
      const parsed = JSON.parse(text) as { words?: Array<{ text: string; start: number; end: number }> };
      const words = (parsed.words ?? []).filter(
        (w) => typeof w.text === 'string' && w.text.length > 0 && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start,
      );
      return { words, provider: this.name };
    } finally {
      // Best-effort cleanup — an orphaned uploaded file isn't a correctness
      // problem (Gemini expires unused files on its own), so a failure here
      // must never mask the transcription result/error above.
      try {
        await ai.files.delete({ name: uploaded.name });
      } catch {
        /* ignore */
      }
    }
  }
}
