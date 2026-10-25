import { bankSuggestion, genreForContext, splitHeadline, type SuggestionContext } from './suggest';
import type { PromoTexts } from './recipes';

/**
 * The readout classifier — turns raw on-device OCR lines into the
 * promo's fields. Pure and deterministic, tested against the REAL
 * OCR output captured from the owner's own uploads (the 2026-10-25
 * proof run): the concert flyer read perfectly, the banner and logo
 * partially — which is exactly why the classification prefers high-
 * confidence lines and the UI shows every read line for one-tap
 * assignment.
 */

export interface OcrLine {
  text: string;
  /** 0..100 engine confidence. */
  confidence: number;
  /** Relative top position in the image, 0..1. */
  y: number;
}

export interface ReadoutResult {
  fields: Partial<PromoTexts>;
  genre: string;
  /** Every usable line the engine read, top to bottom. */
  lines: OcrLine[];
  headline: string;
}

const MIN_LINE_CONFIDENCE = 40;
const HEADLINE_MIN_CONFIDENCE = 55;

const MONTHS = 'JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC';
const DAYS = 'MON|TUE|WED|THU|FRI|SAT|SUN';
const SUB_HINT = new RegExp(`\\b(${MONTHS}|${DAYS})\\b|\\d{1,2}[:.]\\d{2}|\\b[AP]M\\b|\\b(?:HALL|CENTRE|CENTER|ARENA|CLUB|STREET|AVENUE|ROAD|PARK)\\b|@[\\w.]+|\\.COM|\\.NET`, 'i');
const CTA_HINT = /TICKETS|OUT NOW|BOOK NOW|BOOK TODAY|CALL NOW|CALL TODAY|DM (US|TO|FOR)|RSVP|ORDER NOW|BUY NOW|FREE ENTRY|TALK ABOUT|GET YOURS|SIGN UP|REGISTER/i;

const GENRE_HINTS: Array<[string, RegExp]> = [
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

export function classifyReadout(rawLines: OcrLine[], ctx: SuggestionContext): ReadoutResult {
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
  if (!genre) genre = genreForContext(ctx);

  const bank = bankSuggestion(ctx);

  const ctaLine = lines.find((l) => CTA_HINT.test(l.text));
  const subLine = lines.find((l) => l !== ctaLine && SUB_HINT.test(l.text));

  const headlineCandidates = lines.filter(
    (l) => l !== ctaLine && l !== subLine && l.confidence >= HEADLINE_MIN_CONFIDENCE && l.text.length >= 3 && l.text.length <= 42,
  );
  let headline = '';
  let bestScore = -Infinity;
  for (const l of headlineCandidates) {
    const score = l.confidence + (1 - l.y) * 25 + uppercaseRatio(l.text) * 15 - Math.abs(l.text.length - 18) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      headline = l.text;
    }
  }

  const fields: Partial<PromoTexts> = {};
  if (headline) {
    const [hook1, hook2] = splitHeadline(headline);
    fields.hook1 = hook1;
    if (hook2) fields.hook2 = hook2;
  }
  if (subLine) fields.sub = subLine.text;
  fields.cta = ctaLine ? ctaLine.text : bank.cta;

  return { fields, genre, lines, headline };
}
