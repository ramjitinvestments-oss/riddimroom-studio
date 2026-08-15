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
import { TranscriptionConfigurationError, type TranscriptionProvider, type TranscriptionRequest, type TranscriptionResult } from './types';

const MODEL = 'gemini-2.5-flash';
const FILE_READY_POLL_INTERVAL_MS = 1500;
const FILE_READY_TIMEOUT_MS = 120_000;

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

      const response = await ai.models.generateContent({
        model: MODEL,
        contents: createUserContent([createPartFromUri(uploaded.uri, uploaded.mimeType || request.mimeType), createPartFromText(PROMPT)]),
        config: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      });

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
