/**
 * Promo image analysis — server-side only (mirrors the transcription
 * providers' discipline). Reads `GEMINI_API_KEY` from `process.env`;
 * if it is unset, throws `PromoVisionConfigurationError` BEFORE any
 * network call so the endpoint can answer honestly and the client can
 * fall back to its built-in copy bank — the promo words are never
 * blank either way, and a missing key is never dressed up as a result.
 *
 * The model's job is narrow: READ the artwork. Headline words come
 * from the image itself (never invented), dates/venues are copied
 * exactly as printed or left empty, and the call to action is chosen
 * to fit what the artwork is. The client treats every field as a
 * suggestion the user can edit — nothing here is published as-is
 * without the user's own eyes on it in the form.
 */
import { GoogleGenAI, createPartFromText, createPartFromUri, createUserContent, Type } from '@google/genai';

export class PromoVisionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromoVisionConfigurationError';
  }
}

/** The provider is up but busy/quota-limited — worth one retry. */
export class PromoVisionBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromoVisionBusyError';
  }
}

const BUSY_PATTERN = /503|UNAVAILABLE|RESOURCE_EXHAUSTED|quota|rate limit|overloaded/i;

export interface PromoImageSuggestion {
  hook1: string;
  hook2: string;
  sub: string;
  cta: string;
  /** One of the social-post genre keys, best-effort. */
  genre: string;
}

const MODELS = ['gemini-3.8-flash', 'gemini-2.5-flash'];

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    hook1: { type: Type.STRING },
    hook2: { type: Type.STRING },
    sub: { type: Type.STRING },
    cta: { type: Type.STRING },
    genre: { type: Type.STRING },
  },
  required: ['hook1', 'hook2', 'sub', 'cta', 'genre'],
};

const PROMPT = [
  'You are filling the caption fields for a short social-media promo video built from THIS artwork image.',
  'Read the artwork carefully. Rules:',
  '- hook1 and hook2: the punchy headline for the video, taken from the artwork\'s own main title text — split it into two short lines (each 5 words or fewer, ALL CAPS). For a logo, hook1 is the brand name and hook2 its tagline or field (e.g. "REALTY", "SALON"). Never invent a headline unrelated to the artwork.',
  '- sub: the supporting details PRINTED on the artwork — date, venue, city, lineup — joined with " • ", ALL CAPS. Copy them exactly as printed. If no details are printed, return an empty string. NEVER invent a date, venue or name.',
  '- cta: one short call to action that fits the artwork: an event/flyer gets "TICKETS: LINK IN BIO" style wording; a business logo gets "DM TO BOOK" or "CALL TODAY" style; a real-estate banner gets "DM TO BOOK YOUR VIEWING"; a church/gospel piece gets an invitation. 5 words or fewer, ALL CAPS.',
  '- genre: exactly one of: soca, dancehall, gospel, realestate, business, caribbean — whichever fits the artwork best.',
  'Return JSON only, matching the schema.',
].join('\n');

function cleanField(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

/** Pure: coerce whatever the model returned into the suggestion shape. */
export function sanitizePromoSuggestion(raw: unknown): PromoImageSuggestion {
  const r = (raw ?? {}) as Record<string, unknown>;
  const genre = cleanField(r.genre, 24).toLowerCase();
  return {
    hook1: cleanField(r.hook1, 48),
    hook2: cleanField(r.hook2, 48),
    sub: cleanField(r.sub, 90),
    cta: cleanField(r.cta, 48),
    genre: ['soca', 'dancehall', 'gospel', 'realestate', 'business', 'caribbean'].includes(genre) ? genre : 'caribbean',
  };
}

const FILE_READY_POLL_INTERVAL_MS = 1000;
const FILE_READY_TIMEOUT_MS = 12_000;
/**
 * Total server budget for one read (upload + processing wait +
 * generation). The serverless host kills invocations at 60s; the
 * client's own deadline is 25s — so this budget keeps the function
 * answering with a classed result LONG before either kill, instead
 * of stretching toward a minute the way the first version could.
 */
const READ_DEADLINE_MS = 35_000;

async function waitUntilActive(ai: GoogleGenAI, name: string, deadline: number): Promise<void> {
  const pollDeadline = Math.min(deadline, Date.now() + FILE_READY_TIMEOUT_MS);
  for (;;) {
    const file = await ai.files.get({ name });
    if (file.state === 'ACTIVE') return;
    if (file.state === 'FAILED') throw new Error(`Gemini file processing failed for "${name}".`);
    if (Date.now() > pollDeadline) {
      throw new PromoVisionBusyError(`Gemini file "${name}" did not become ready within ${FILE_READY_TIMEOUT_MS / 1000}s.`);
    }
    await new Promise((resolve) => setTimeout(resolve, FILE_READY_POLL_INTERVAL_MS));
  }
}

/**
 * The read runs on the EXACT pipe transcription already proves on
 * this key: upload through the Gemini Files API, wait for ACTIVE,
 * generate from the file URI with a structured schema, model
 * fallthrough on 404, one retry on a 503 demand spike. (The first
 * version sent the image inline — the one unproven variable in the
 * chain — and the owner's tests showed it not landing.)
 */
export async function analyzePromoImage(input: {
  imageBase64: string;
  mimeType: string;
}): Promise<PromoImageSuggestion> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new PromoVisionConfigurationError(
      'GEMINI_API_KEY is not configured on the server, so artwork analysis is unavailable. The client falls back to its built-in suggestions.',
    );
  }
  const ai = new GoogleGenAI({ apiKey });
  const bytes = Buffer.from(input.imageBase64, 'base64');
  const blob = new Blob([bytes], { type: input.mimeType });
  const uploaded = await ai.files.upload({ file: blob, config: { mimeType: input.mimeType } });
  if (!uploaded.uri || !uploaded.name) {
    throw new Error('Gemini file upload did not return a usable file reference.');
  }
  const startedAt = Date.now();
  const deadline = startedAt + READ_DEADLINE_MS;
  try {
    await waitUntilActive(ai, uploaded.name, deadline);
    const failures: string[] = [];
    let sawBusy = false;
    for (const model of MODELS) {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (Date.now() > deadline) {
          sawBusy = true;
          failures.push('read deadline reached');
          break;
        }
        try {
          const response = await ai.models.generateContent({
            model,
            contents: createUserContent([
              createPartFromUri(uploaded.uri, uploaded.mimeType || input.mimeType),
              createPartFromText(PROMPT),
            ]),
            config: {
              responseMimeType: 'application/json',
              responseSchema: RESPONSE_SCHEMA,
            },
          });
          const text = response.text;
          if (!text) throw new Error('The model returned an empty response.');
          return sanitizePromoSuggestion(JSON.parse(text));
        } catch (err: any) {
          const msg = String(err?.message || err);
          if (/404|NOT_FOUND|no longer available|not found/i.test(msg)) {
            failures.push(`${model}: ${msg}`);
            break; // next model
          }
          if (BUSY_PATTERN.test(msg) && attempt === 0) {
            sawBusy = true;
            await new Promise((resolve) => setTimeout(resolve, 3000));
            continue; // one retry on this model
          }
          if (BUSY_PATTERN.test(msg)) {
            sawBusy = true;
            failures.push(`${model}: ${msg}`);
            break; // next model after the retry
          }
          throw err;
        }
      }
    }
    if (sawBusy) {
      throw new PromoVisionBusyError(`The artwork reader is busy right now (${failures.join(' | ')})`);
    }
    throw new Error(`Artwork analysis failed (${failures.join(' | ')})`);
  } finally {
    try {
      await ai.files.delete({ name: uploaded.name });
    } catch {
      /* best-effort cleanup, mirrors the transcription provider */
    }
  }
}
