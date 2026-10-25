import { bankSuggestion, genreForContext, splitHeadline, type SuggestionContext } from './suggest';
import type { PromoTexts } from './recipes';

/**
 * The readout classifier — turns raw on-device OCR lines into the
 * promo's fields. Pure and deterministic, tested against the REAL
 * OCR output captured from the owner's own uploads.
 *
 * R12 — PROVENANCE LOCK (owner's word-cloud test: a trades graphic
 * shipped with soca party captions). The rules now:
 *  - genre is derived from the READ TEXT first (trades included),
 *    never from the filename when real words exist;
 *  - a phone number printed in the art becomes the CTA
 *    ("CALL 407-616-2569") — the artwork's own number, never a
 *    borrowed line;
 *  - when a real headline was read, `mergeReadoutFields` REPLACES
 *    every untouched field with the readout's own fields (empty
 *    where the art said nothing) — bank copy from another world
 *    can no longer survive in the gaps.
 */

export interface OcrLine {
  text: string;
  /** 0..100 engine confidence. */
  confidence: number;
  /** Relative top position in the image, 0..1. */
  y: number;
  /** Normalized bounding box in artwork space (R12, camera tours). */
  box?: { x: number; y: number; w: number; h: number };
}

export interface ReadoutResult {
  fields: Partial<PromoTexts>;
  genre: string;
  /** Every usable line the engine read, top to bottom. */
  lines: OcrLine[];
  headline: string;
  headlineLine?: OcrLine;
  ctaLine?: OcrLine;
  phoneLine?: OcrLine;
  /** The artwork's own phone number, when printed. */
  phone?: string;
}

const MIN_LINE_CONFIDENCE = 40;
const HEADLINE_MIN_CONFIDENCE = 55;
const PHONE_MIN_CONFIDENCE = 25;

const MONTHS = 'JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC';
const DAYS = 'MON|TUE|WED|THU|FRI|SAT|SUN';
const SUB_HINT = new RegExp(`\\b(${MONTHS}|${DAYS})\\b|\\d{1,2}[:.]\\d{2}|\\b[AP]M\\b|\\b(?:HALL|CENTRE|CENTER|ARENA|CLUB|STREET|AVENUE|ROAD|PARK)\\b|@[\\w.]+|\\.COM|\\.NET`, 'i');
const CTA_HINT = /TICKETS|OUT NOW|BOOK NOW|BOOK TODAY|CALL|DM (US|TO|FOR)|RSVP|ORDER NOW|BUY NOW|FREE ENTRY|TALK ABOUT|GET YOURS|SIGN UP|REGISTER/i;
const PHONE_RE = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/;

const TRADE_WORDS = ['ELECTRICAL', 'PLUMBING', 'FLOORING', 'TILE', 'CONCRETE', 'PAINTING', 'REMODELING', 'ROOFING', 'HVAC', 'HANDYMAN', 'CARPENTRY', 'DRYWALL'];

const GENRE_HINTS: Array<[string, RegExp]> = [
  ['trades', /ELECTRICAL|PLUMBING|FLOORING|REMODELING|ROOFING|\bHVAC\b|HANDYMAN|CONCRETE|PAINTING|CARPENTRY|DRYWALL|\bTILE\b/i],
  ['soca', /\bSOCA\b|CARNIVAL|FETE/i],
  ['dancehall', /DANCEHALL|REGGAE|DUB\b/i],
  ['gospel', /GOSPEL|CHURCH|PRAISE|WORSHIP|MINISTRY/i],
  ['realestate', /REALTOR|REAL ESTATE|REALTY|PROPERTIES|LISTING/i],
  ['business', /PRODUCTION|SOLUTIONS|ENTERPRISE|BOOKINGS|STAGE|LIGHTING/i],
];

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function letterCount(text: string): number {
  return (text.match(/[A-Za-z]/g) || []).length;
}

function uppercaseRatio(text: string): number {
  const letters = text.match(/[A-Za-z]/g) || [];
  if (letters.length === 0) return 0;
  return letters.filter((c) => c === c.toUpperCase()).length / letters.length;
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '').replace(/^1(?=\d{10})/, '');
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
}

export function classifyReadout(rawLines: OcrLine[], ctx: SuggestionContext): ReadoutResult {
  // The phone hunt runs on ALL lines — digits read at lower
  // confidence than display type, and the number is the CTA gold.
  let phone: string | undefined;
  let phoneLine: OcrLine | undefined;
  for (const l of rawLines) {
    if (l.confidence < PHONE_MIN_CONFIDENCE) continue;
    const m = clean(l.text).match(PHONE_RE);
    if (m) {
      phone = normalizePhone(m[0]);
      phoneLine = { ...l, text: clean(l.text) };
      break;
    }
  }

  const lines = rawLines
    .map((l) => ({ ...l, text: clean(l.text) }))
    .filter((l) => l.confidence >= MIN_LINE_CONFIDENCE && l.text.length >= 2 && letterCount(l.text) >= 2)
    .sort((a, b) => a.y - b.y)
    .filter((l, i, arr) => arr.findIndex((o) => o.text === l.text) === i);

  const fullText = lines.map((l) => l.text).join(' ');
  let genre = '';
  for (const [name, hint] of GENRE_HINTS) {
    if (hint.test(fullText)) {
      genre = name;
      break;
    }
  }
  if (!genre) {
    // Real words exist but match no domain: stay NEUTRAL (business),
    // never borrow a party voice. Only wordless art falls back to
    // the filename/kind context.
    genre = lines.length > 0 ? 'business' : genreForContext(ctx);
  }

  const bank = bankSuggestion(ctx);

  const ctaLine = lines.find((l) => CTA_HINT.test(l.text));
  let subLine = lines.find((l) => l !== ctaLine && SUB_HINT.test(l.text));

  // Trades art: the services themselves are the details line.
  let servicesSub: string | undefined;
  if (genre === 'trades' && !subLine) {
    const found: string[] = [];
    for (const l of lines) {
      for (const w of TRADE_WORDS) {
        if (new RegExp(`\\b${w}\\b`, 'i').test(l.text) && !found.includes(w)) found.push(w);
      }
    }
    if (found.length >= 2) servicesSub = found.slice(0, 3).join(' • ');
  }

  const headlineCandidates = lines.filter(
    (l) => l !== ctaLine && l !== subLine && l.confidence >= HEADLINE_MIN_CONFIDENCE && l.text.length >= 3 && l.text.length <= 42,
  );
  let headline = '';
  let headlineLine: OcrLine | undefined;
  let bestScore = -Infinity;
  for (const l of headlineCandidates) {
    const score = l.confidence + (1 - l.y) * 25 + uppercaseRatio(l.text) * 15 - Math.abs(l.text.length - 18) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      headline = l.text;
      headlineLine = l;
    }
  }

  const fields: Partial<PromoTexts> = {};
  if (headline) {
    const [hook1, hook2] = splitHeadline(headline);
    fields.hook1 = hook1;
    if (hook2) fields.hook2 = hook2;
  }
  if (subLine) fields.sub = subLine.text;
  else if (servicesSub) fields.sub = servicesSub;
  if (phone) fields.cta = `CALL ${phone}`;
  else if (ctaLine) fields.cta = ctaLine.text;
  else if (genre === 'trades') fields.cta = 'CALL US TODAY';
  else fields.cta = bank.cta;

  return { fields, genre, lines, headline, headlineLine, ctaLine, phoneLine, phone };
}

/**
 * The provenance lock at merge time. When the readout carries a
 * real headline, it is AUTHORITATIVE: every untouched field takes
 * the readout's value — including EMPTY where the art said nothing —
 * so bank copy placed moments earlier cannot survive in a gap.
 * Without a headline the readout only ADDS what it knows (the
 * additive path), and fields the user typed in are never touched
 * either way.
 */
export function mergeReadoutFields(
  current: PromoTexts,
  touched: ReadonlySet<string>,
  result: ReadoutResult,
): PromoTexts {
  const next: PromoTexts = { ...current };
  const fields = ['hook1', 'hook2', 'sub', 'cta'] as const;
  if (result.headline) {
    for (const f of fields) {
      if (!touched.has(f)) next[f] = result.fields[f] ?? '';
    }
  } else {
    for (const f of fields) {
      if (!touched.has(f) && result.fields[f]) next[f] = result.fields[f] as string;
    }
  }
  return next;
}
