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
import type { PromoSkinId, PromoTexts } from './recipes';
import { detectPostGenre, type PostGenre } from '../export/socialPosts';
import type { SiteProfile } from './siteProfile';

export type SuggestionField = 'hook1' | 'hook2' | 'sub' | 'cta';
export const SUGGESTION_FIELDS: SuggestionField[] = ['hook1', 'hook2', 'sub', 'cta'];

export type NoTextPurpose = 'event' | 'product' | 'business' | 'look';

export interface SuggestionContext {
  kind: 'logo' | 'flyer' | 'portrait';
  fileName: string;
  /** R20: set when the image has NO readable words — the user's
      answer to "what's this promo for?" steers the bank. */
  purpose?: NoTextPurpose | null;
  /** The brand kit's name, exactly as printed — a no-text logo's
      headline is its brand's name. */
  brandName?: string;
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

/* ------------------------------------------------------------------ */
/* R24 (WS-C2) — ONE resolved campaign context.                        */
/*                                                                     */
/* Genre, tag set and every rotation pool key from this single       */
/* resolution, in precedence order:                                    */
/*   1. the confirmed website profile (its category/services)          */
/*   2. the user's stated purpose (the no-text answer)                 */
/*   3. the artwork analysis (readout / vision genre)                  */
/*   4. the filename                                                   */
/* Before R24 each call site re-derived genre from the filename, so  */
/* a product photo and a dental practice both collapsed to party     */
/* copy. Nothing downstream may detect genre on its own again.       */
/* ------------------------------------------------------------------ */

export interface CampaignContext {
  genre: PostGenre;
  source: 'site' | 'purpose' | 'artwork' | 'filename';
  purpose: NoTextPurpose | null;
  /** The 'look' purpose: pieces stay silent — empty sub/CTA by design. */
  silent: boolean;
}

const KNOWN_GENRES: PostGenre[] = ['soca', 'dancehall', 'gospel', 'realestate', 'business', 'caribbean'];

/** Genre from a confirmed site profile's own words — its name,
    tagline, services and offers. A profile whose words name no
    genre is a business (a website campaign is a business campaign)
    unless one of its offers is a dated event. */
export function genreFromSiteProfile(profile: SiteProfile): PostGenre {
  const haystack = [
    profile.name?.value ?? '',
    profile.tagline?.value ?? '',
    ...profile.services,
    ...profile.offers.flatMap((o) => [o.name, ...(o.services ?? [])]),
  ].join(' ');
  const detected = detectPostGenre(haystack);
  if (detected !== 'caribbean') return detected;
  return profile.offers.some((o) => o.date) ? 'caribbean' : 'business';
}

export function resolveCampaignContext(input: {
  siteProfile?: SiteProfile | null;
  purpose?: NoTextPurpose | null;
  artworkGenre?: string | null;
  suggestionCtx?: SuggestionContext | null;
}): CampaignContext {
  const purpose = input.purpose ?? input.suggestionCtx?.purpose ?? null;
  const silent = purpose === 'look';
  if (input.siteProfile) {
    return { genre: genreFromSiteProfile(input.siteProfile), source: 'site', purpose, silent };
  }
  if (purpose === 'product' || purpose === 'business') {
    return { genre: 'business', source: 'purpose', purpose, silent };
  }
  if (purpose === 'event' || purpose === 'look') {
    // The purpose steers the SHAPE (event series / silent pieces);
    // the genre still comes from the artwork, then the filename.
    const art = (KNOWN_GENRES as string[]).includes(input.artworkGenre ?? '')
      ? (input.artworkGenre as PostGenre)
      : null;
    if (art) return { genre: art, source: 'artwork', purpose, silent };
    if (input.suggestionCtx) return { genre: genreForContext(input.suggestionCtx), source: 'filename', purpose, silent };
    return { genre: 'caribbean', source: 'purpose', purpose, silent };
  }
  const art = (KNOWN_GENRES as string[]).includes(input.artworkGenre ?? '')
    ? (input.artworkGenre as PostGenre)
    : null;
  if (art) return { genre: art, source: 'artwork', purpose, silent };
  if (input.suggestionCtx) {
    return { genre: genreForContext(input.suggestionCtx), source: 'filename', purpose, silent };
  }
  return { genre: 'caribbean', source: 'filename', purpose, silent };
}

/** Split a headline into two punchy lines, balanced by words. */
export function splitHeadline(headline: string): [string, string] {
  const words = headline.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length === 0) return ['', ''];
  if (words.length === 1) return [words[0], ''];
  const mid = Math.ceil(words.length / 2);
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
}

/** The instant, offline suggestion — hook + CTA are never empty
    (except the explicit 'just the look' purpose, which fills the
    headline only and leaves the rest to the user). */
export function bankSuggestion(ctx: SuggestionContext): Pick<Required<PromoTexts>, 'hook1' | 'hook2' | 'sub' | 'cta'> {
  const genre = genreForContext(ctx);
  // R20 no-text purposes: product/business art gets the business
  // bank outright (a filename genre guess must not dress a product
  // photo in party copy); 'event' keeps the genre bank.
  const bank =
    ctx.purpose === 'business' || ctx.purpose === 'product' ? BANKS.business : BANKS[genre];
  const nameWords = cleanNameWords(ctx.fileName);
  const brandWords = (ctx.brandName ?? '').trim().split(/\s+/).filter(Boolean);
  if (ctx.purpose === 'look') {
    const [a, b] = splitHeadline((brandWords.length > 0 ? brandWords : nameWords).slice(0, 4).join(' ').toUpperCase());
    return { hook1: a, hook2: b, sub: '', cta: '' };
  }
  if (ctx.purpose && brandWords.length > 0 && ctx.kind === 'logo') {
    const [a, b] = splitHeadline(brandWords.slice(0, 4).join(' ').toUpperCase());
    if (a) {
      return {
        hook1: a,
        hook2: b || bank.hooks[0][1],
        sub: ctx.purpose === 'product' ? 'QUALITY YOU CAN FEEL' : bank.subs[0],
        cta: bank.ctas[0],
      };
    }
  }
  if (ctx.purpose === 'product') {
    return { hook1: bank.hooks[0][0], hook2: bank.hooks[0][1], sub: 'QUALITY YOU CAN FEEL', cta: bank.ctas[0] };
  }
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

/**
 * Alternates for one field (the ↻ cycle), bank order.
 *
 * R24 (WS-C2): the bank is keyed by the RESOLVED context, never the
 * filename alone — an explicit genre (from the resolved campaign
 * context) wins, then the user's stated purpose (a product/business
 * promo draws the business bank even when the filename sounds like
 * a party), and only then the filename genre.
 */
export function fieldAlternates(field: SuggestionField, ctx: SuggestionContext, genreOverride?: PostGenre): string[] {
  const genre =
    genreOverride ??
    (ctx.purpose === 'product' || ctx.purpose === 'business' ? 'business' : genreForContext(ctx));
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

// ---------------------------------------------------------------------------
// R23 WS3 — Headline Poster bank.
//
// Generic, user-facing poster copy for every Studio user: no
// RiddimRoom branding and no Caribbean-only slang (this bank ships
// to all users, unlike the genre banks above). Formula per pair: a
// stamped identity phrase as the headline (short, caps-ready, and —
// the bank's one punctuation convention — always ending with a
// period; the builder uppercases it) plus one scene line with a
// quiet claim as the sub, in sentence case.
//
// Context mapping onto the types that already exist in this file:
// the R20 `NoTextPurpose` ('event' | 'product' | 'business' |
// 'look') is the bank key when the user answered the purpose
// question. Without a purpose, the genre resolution decides:
// business / real-estate genres read as 'business', a portrait
// with no stated purpose reads as 'look', and everything else
// (flyers, logos, the party genres) reads as 'event'.
// ---------------------------------------------------------------------------

export interface PosterSuggestion {
  headline: string;
  sub: string;
}

interface PosterBank {
  pairs: PosterSuggestion[];
  extraHeadlines: string[];
  extraSubs: string[];
}

const POSTER_BANKS: Record<NoTextPurpose, PosterBank> = {
  event: {
    pairs: [
      { headline: 'ONE NIGHT ONLY.', sub: 'A single night, done properly, with everyone in the room.' },
      { headline: 'THE NIGHT IS SET.', sub: 'Good music, good people, and a real reason to be there.' },
      { headline: 'MAKE IT A NIGHT.', sub: 'Clear the calendar and bring someone who loves a night out.' },
      { headline: 'ALL IN ONE NIGHT.', sub: 'The performances, the people, and the moments in between.' },
    ],
    extraHeadlines: ['DOORS OPEN SOON.', 'SEE YOU THERE.'],
    extraSubs: ['Arrive early and stay for the whole thing.', 'Tickets and full details are in the link.'],
  },
  product: {
    pairs: [
      { headline: 'MADE TO BE USED.', sub: 'Built for everyday use and made to last.' },
      { headline: 'QUALITY YOU CAN FEEL.', sub: 'Every detail is finished with care, inside and out.' },
      { headline: 'YOUR NEW FAVORITE.', sub: 'Simple, reliable, and ready from day one.' },
      { headline: 'BUILT TO LAST.', sub: 'Strong materials and a finish that holds up.' },
    ],
    extraHeadlines: ['READY WHEN YOU ARE.', 'MADE WITH CARE.'],
    extraSubs: ['Designed to fit the way you already live.', 'Available now, while stock lasts.'],
  },
  business: {
    pairs: [
      { headline: 'OPEN FOR BUSINESS.', sub: 'Local service you can book with confidence.' },
      { headline: 'NOW BOOKING.', sub: 'Appointments are open for new and returning clients.' },
      { headline: 'DONE PROPERLY.', sub: 'Careful work, clear prices, and a finish we stand behind.' },
      { headline: 'TRUSTED LOCALLY.', sub: 'Serving our community with pride, every single week.' },
    ],
    extraHeadlines: ['BOOK WITH CONFIDENCE.', 'HERE TO HELP.'],
    extraSubs: ['Message us today to get started.', 'Walk-ins and appointments are both welcome.'],
  },
  look: {
    pairs: [
      { headline: 'THE LOOK.', sub: 'Clean lines, strong color, and a finish that photographs beautifully.' },
      { headline: 'OWN THE LOOK.', sub: 'A style that speaks before you say a word.' },
      { headline: 'MADE TO BE SEEN.', sub: 'Bold enough for the camera and easy enough for every day.' },
      { headline: 'SIMPLY STRIKING.', sub: 'No extra noise, just the look, exactly as it should be.' },
    ],
    extraHeadlines: ['FRESH LOOK.', 'STYLE, SIMPLIFIED.'],
    extraSubs: ['Shot in natural light, with nothing to hide.', 'Wear it your way, any day of the week.'],
  },
};

/** Which poster bank a suggestion context resolves to (see above). */
function posterBankKey(ctx: SuggestionContext): NoTextPurpose {
  if (ctx.purpose) return ctx.purpose;
  const genre = genreForContext(ctx);
  if (genre === 'business' || genre === 'realestate') return 'business';
  if (ctx.kind === 'portrait') return 'look';
  return 'event';
}

/** The instant, offline poster suggestion — the bank's lead pair. */
export function posterSuggestion(ctx: SuggestionContext): PosterSuggestion {
  const pair = POSTER_BANKS[posterBankKey(ctx)].pairs[0];
  return { headline: pair.headline, sub: pair.sub };
}

/**
 * Alternates for one poster field (the ↻ cycle, via
 * `cycleAlternate`): every paired value for that field in bank
 * order, then the field's standalone alternates.
 */
export function posterAlternates(field: 'headline' | 'sub', ctx: SuggestionContext): string[] {
  const bank = POSTER_BANKS[posterBankKey(ctx)];
  const paired = bank.pairs.map((p) => (field === 'headline' ? p.headline : p.sub));
  const extras = field === 'headline' ? bank.extraHeadlines : bank.extraSubs;
  return [...new Set([...paired, ...extras])];
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

/**
 * The design-suggested skin (R16): the readout's detected genre
 * picks the stage dressing the way a designer would — gospel art
 * gets light, trades and business get clean corporate, the party
 * genres keep their heat. Always a SUGGESTION: applied only until
 * the user picks a skin themselves.
 */
export interface PaletteHint {
  warmth: number;
  saturation: number;
  meanLuminance: number;
}

export function suggestedSkinFor(genre: string, kind?: string, palette?: PaletteHint | null): PromoSkinId {
  switch (genre) {
    case 'gospel':
      return 'gospel-light';
    case 'soca':
    case 'caribbean':
      return 'soca-shine';
    case 'trades':
    case 'realestate':
    case 'business':
      return 'corporate-clean';
    case 'dancehall':
      return 'dancehall-raw';
    default: {
      // R20: no genre read (a textless image, most often) — the
      // palette decides: vivid + warm reads party, dark reads raw,
      // washed-out reads corporate, bright + soft reads light.
      if (palette) {
        if (palette.saturation > 0.35 && palette.warmth > 0.02) return 'soca-shine';
        if (palette.meanLuminance < 80) return 'dancehall-raw';
        if (palette.saturation < 0.18) return 'corporate-clean';
        if (palette.meanLuminance > 170) return 'gospel-light';
      }
      return kind === 'portrait' ? 'soca-shine' : 'dancehall-raw';
    }
  }
}
