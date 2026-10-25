/**
 * Auto-fit promo words — the client half. Two sources, one contract:
 * the fields are NEVER blank and the user's own typing is NEVER
 * overwritten.
 *
 *  1. The copy bank (this file): instant, offline, deterministic
 *     suggestions shaped by the artwork kind, the file name, and the
 *     detected genre. It fills the fields the moment an image lands.
 *  2. The vision endpoint (/api/promo-analyze): reads the artwork's
 *     own printed words via the server's Gemini setup and refines the
 *     still-untouched fields. Any failure — no key, no network, a
 *     non-JSON platform error — returns null and the bank stands.
 *
 * Rendered-type house rule: added video type avoids the word "fete"
 * (the locked templates standard — written copy like hashtags may
 * keep it, rendered type uses "party" wording).
 */
import type { PromoTexts } from './recipes';
import { detectPostGenre, type PostGenre } from '../export/socialPosts';

export type SuggestionField = 'hook1' | 'hook2' | 'sub' | 'cta';
export const SUGGESTION_FIELDS: SuggestionField[] = ['hook1', 'hook2', 'sub', 'cta'];

export interface SuggestionContext {
  kind: 'logo' | 'flyer' | 'portrait';
  fileName: string;
}

export interface VisionSuggestion {
  hook1: string;
  hook2: string;
  sub: string;
  cta: string;
  genre: string;
}

interface GenreBank {
  hooks: Array<[string, string]>;
  subs: string[];
  ctas: string[];
}

const EVENT_CTAS = ['TICKETS: LINK IN BIO', 'GET YOUR TICKETS EARLY', 'LINK IN BIO FOR TICKETS'];
const EVENT_SUBS = ['ONE NIGHT ONLY', 'ONE NIGHT. ONE CROWD. ONE SOUND.'];

const BANKS: Record<PostGenre, GenreBank> = {
  soca: {
    hooks: [
      ['ONE NIGHT.', 'TWO SOUNDS.'],
      ['PURE SOCA.', 'PURE ENERGY.'],
      ['D PARTY', 'CALLIN’ YOU.'],
    ],
    subs: EVENT_SUBS,
    ctas: EVENT_CTAS,
  },
  dancehall: {
    hooks: [
      ['ONE NIGHT.', 'TWO SOUNDS.'],
      ['DI PLACE', 'AGO SHELL.'],
      ['FULL ENERGY.', 'NO SITTING.'],
    ],
    subs: EVENT_SUBS,
    ctas: EVENT_CTAS,
  },
  gospel: {
    hooks: [
      ['A NIGHT OF', 'PRAISE.'],
      ['COME LET US', 'WORSHIP.'],
      ['ONE VOICE.', 'ONE PRAISE.'],
    ],
    subs: ['ALL ARE WELCOME', 'BRING A FRIEND. BRING YOUR PRAISE.'],
    ctas: ['ALL ARE WELCOME', 'DETAILS: LINK IN BIO', 'BRING A FRIEND'],
  },
  realestate: {
    hooks: [
      ['YOUR NEXT', 'HOME AWAITS.'],
      ['STEP INSIDE', 'THIS ONE.'],
      ['JUST LISTED.', 'FULL TOUR.'],
    ],
    subs: ['TOUR IT BEFORE IT’S GONE', 'WATCH THE FULL TOUR'],
    ctas: ['DM TO BOOK YOUR VIEWING', 'CALL TO VIEW TODAY', 'DM “VIEWING” TODAY'],
  },
  business: {
    hooks: [
      ['NEW LOOK.', 'SAME FIRE.'],
      ['NOW BOOKING.', 'NEW CLIENTS.'],
      ['BUILT ON', 'GOOD WORK.'],
    ],
    subs: ['WATCH THIS SPACE', 'SHARE THIS WITH A FRIEND'],
    ctas: ['DM TO BOOK', 'BOOK YOUR SPOT', 'CALL TODAY'],
  },
  caribbean: {
    hooks: [
      ['ONE NIGHT.', 'TWO SOUNDS.'],
      ['SOMETHING BIG', 'IS COMING.'],
      ['THE COUNTDOWN', 'IS ON.'],
    ],
    subs: EVENT_SUBS,
    ctas: EVENT_CTAS,
  },
};

function cleanNameWords(fileName: string): string[] {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b(sample|flyer|promo|final|v\d+|img|image|photo|copy)\b/gi, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1);
}

export function genreForContext(ctx: SuggestionContext): PostGenre {
  return detectPostGenre(cleanNameWords(ctx.fileName).join(' '));
}

/** Split a headline into two punchy lines, balanced by words. */
export function splitHeadline(headline: string): [string, string] {
  const words = headline.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0) return ['', ''];
  if (words.length === 1) return [words[0], ''];
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
}

/** The instant, offline suggestion — hook + CTA are never empty. */
export function bankSuggestion(ctx: SuggestionContext): Pick<Required<PromoTexts>, 'hook1' | 'hook2' | 'sub' | 'cta'> {
  const genre = genreForContext(ctx);
  const bank = BANKS[genre];
  const nameWords = cleanNameWords(ctx.fileName);
  let hook1 = bank.hooks[0][0];
  let hook2 = bank.hooks[0][1];
  if (ctx.kind === 'logo' && nameWords.length > 0) {
    // A logo's best headline is its own name.
    const [a, b] = splitHeadline(nameWords.slice(0, 4).join(' ').toUpperCase());
    if (a) hook1 = a;
    if (b) hook2 = b;
  } else if (ctx.kind === 'flyer' && nameWords.length >= 3) {
    const [a, b] = splitHeadline(nameWords.slice(0, 5).join(' ').toUpperCase());
    if (a && b) {
      hook1 = a;
      hook2 = b;
    }
  }
  return { hook1, hook2, sub: bank.subs[0], cta: bank.ctas[0] };
}

/** The bank pick for an EXPLICIT genre — used by the readout
    classifier, whose genre comes from the artwork's own words and
    must never fall back to a filename-derived bank (R13: a gospel
    design was one step from a business-bank CTA). */
export function bankCtaForGenre(genre: PostGenre): string {
  return BANKS[genre].ctas[0];
}

/** Alternates for one field from an EXPLICIT genre's bank — the
    campaign planner's pools come from the genre the artwork's own
    words detected (R13's rule), never a filename guess. */
export function bankAlternatesForGenre(field: SuggestionField, genre: PostGenre): string[] {
  const bank = BANKS[genre];
  switch (field) {
    case 'hook1':
      return bank.hooks.map((h) => h[0]);
    case 'hook2':
      return bank.hooks.map((h) => h[1]);
    case 'sub':
      return [...bank.subs];
    case 'cta':
      return [...bank.ctas];
  }
}

/** Alternates for one field (the ↻ cycle), bank order. */
export function fieldAlternates(field: SuggestionField, ctx: SuggestionContext): string[] {
  const genre = genreForContext(ctx);
  const bank = BANKS[genre];
  switch (field) {
    case 'hook1':
      return bank.hooks.map((h) => h[0]);
    case 'hook2':
      return bank.hooks.map((h) => h[1]);
    case 'sub':
      return [...bank.subs];
    case 'cta':
      return [...bank.ctas];
  }
}

/** Next value in a cycle: the entry after `current`, wrapping. */
export function cycleAlternate(alternates: string[], current: string): string {
  const list = alternates.filter((a) => a.trim().length > 0);
  if (list.length === 0) return current;
  const idx = list.findIndex((a) => a.trim().toLowerCase() === current.trim().toLowerCase());
  return list[(idx + 1) % list.length];
}

/**
 * Fill only the fields the user has not touched. A field the user
 * edited even once is theirs — auto-fill never reaches it. Empty
 * suggestion values never erase anything.
 */
export function mergeIntoUntouched(
  texts: PromoTexts,
  touched: ReadonlySet<string>,
  suggestion: Partial<PromoTexts>,
): PromoTexts {
  const next: PromoTexts = { ...texts };
  for (const field of SUGGESTION_FIELDS) {
    if (touched.has(field)) continue;
    const value = suggestion[field]?.trim();
    if (value) next[field] = value;
  }
  return next;
}

export type VisionReadOutcome = 'ok' | 'not-configured' | 'busy' | 'failed' | 'timeout';

export interface VisionReadResult {
  outcome: VisionReadOutcome;
  suggestion: VisionSuggestion | null;
  /** Short provider reason on a 'failed' outcome — shown in the UI note. */
  reason?: string;
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

/**
 * The POST half of the artwork read, factored out so its outcome
 * mapping is unit-testable without a browser canvas. The endpoint
 * answers with a classed code (not_configured / busy / failed) and
 * this maps it to the outcome the UI reports in plain words — a
 * failed read is NEVER silent: the note under the word fields says
 * exactly which thing happened.
 */
export async function requestVisionRead(
  imageBase64: string,
  idToken: string,
  fetcher: Fetcher = fetch,
  timeoutMs = 25_000,
): Promise<VisionReadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher('/api/promo-analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ imageBase64, mimeType: 'image/jpeg' }),
      signal: controller.signal,
    });
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    if (!isJson) return { outcome: 'failed', suggestion: null };
    const data = await res.json();
    if (res.ok && data?.success && data.suggestion) {
      const sg = data.suggestion as VisionSuggestion;
      return {
        outcome: 'ok',
        suggestion: {
          hook1: String(sg.hook1 ?? ''),
          hook2: String(sg.hook2 ?? ''),
          sub: String(sg.sub ?? ''),
          cta: String(sg.cta ?? ''),
          genre: String(sg.genre ?? ''),
        },
      };
    }
    if (data?.code === 'not_configured') return { outcome: 'not-configured', suggestion: null };
    if (data?.code === 'busy') return { outcome: 'busy', suggestion: null };
    return { outcome: 'failed', suggestion: null, reason: typeof data?.reason === 'string' ? data.reason : undefined };
  } catch (err: any) {
    if (err?.name === 'AbortError') return { outcome: 'timeout', suggestion: null };
    return { outcome: 'failed', suggestion: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the server to READ the artwork (downscaled to ≤1024px JPEG
 * here, so the request stays small). A 'busy' outcome earns ONE
 * automatic retry after a short pause — free-tier demand spikes are
 * usually momentary. Any other failure returns its classed outcome;
 * the caller keeps the bank suggestion, so analysis never blocks a
 * build and never fails silently.
 */
export async function fetchVisionRead(bitmap: ImageBitmap, idToken: string): Promise<VisionReadResult> {
  let base64: string | null = null;
  try {
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { outcome: 'failed', suggestion: null };
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) return { outcome: 'failed', suggestion: null };
    base64 = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        resolve(result.includes(',') ? result.split(',')[1] : null);
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return { outcome: 'failed', suggestion: null };
  }
  if (!base64) return { outcome: 'failed', suggestion: null };
  // One 25-second budget for the whole read, retry included — the
  // note in the UI must ALWAYS land on a verdict (owner's test
  // stranded on "Reading…" when nothing in the chain had a deadline).
  const budgetEndsAt = Date.now() + 25_000;
  const remaining = () => Math.max(1_000, budgetEndsAt - Date.now());
  const first = await requestVisionRead(base64, idToken, fetch, remaining());
  if (first.outcome !== 'busy') return first;
  if (Date.now() + 2_000 > budgetEndsAt) return first;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return requestVisionRead(base64, idToken, fetch, remaining());
}
