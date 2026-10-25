import { bankCtaForGenre, bankSuggestion, genreForContext, splitHeadline, type SuggestionContext } from './suggest';
import { buildSnapVocabulary, snapLines, type SnapCorrection } from './snap';
import type { PostGenre } from '../export/socialPosts';
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

export type FieldSource = 'art' | 'suggested';

export interface ReadoutResult {
  fields: Partial<PromoTexts>;
  /** Where each filled field came from — the artwork's own words
      ('art') or a suggestion the genre bank supplied ('suggested').
      The UI labels every field with this; no silent substitution. */
  sources: Partial<Record<'hook1' | 'hook2' | 'sub' | 'cta', FieldSource>>;
  genre: string;
  /** Every usable line the engine read, top to bottom. */
  lines: OcrLine[];
  headline: string;
  headlineLine?: OcrLine;
  /** R18: the printed second line of a stacked headline, when the
      design set the headline on two stacked lines. */
  stackedLine?: OcrLine;
  /** R18: every snap-to-truth repair applied to the working lines
      (shown to the user; the raw panel lines are never altered). */
  corrections: SnapCorrection[];
  ctaLine?: OcrLine;
  phoneLine?: OcrLine;
  /** The artwork's own phone number, when printed. */
  phone?: string;
}

const MIN_LINE_CONFIDENCE = 40;
const HEADLINE_MIN_CONFIDENCE = 55;
const PHONE_MIN_CONFIDENCE = 20;

const MONTHS = 'JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC';
const DAYS = 'MON|TUE|WED|THU|FRI|SAT|SUN';
const SUB_HINT = new RegExp(`\\b(${MONTHS}|${DAYS})\\b|\\d{1,2}[:.]\\d{2}|\\b[AP]M\\b|\\b(?:HALL|CENTRE|CENTER|ARENA|CLUB|STREET|AVENUE|ROAD|PARK)\\b|@[\\w.]+|\\.COM|\\.NET`, 'i');
const CTA_HINT = /TICKETS|OUT NOW|BOOK NOW|BOOK TODAY|CALL|DM (US|TO|FOR)|RSVP|ORDER NOW|BUY NOW|FREE ENTRY|TALK ABOUT|GET YOURS|SIGN UP|REGISTER/i;
const PHONE_RE = /\+?[\d][\d\s.()-]{7,}\d/;
const VERBATIM_CTA_MAX_CHARS = 32;

/**
 * A line clean enough to use VERBATIM as a field: word-cloud OCR
 * (proven on the owner's Ramjit art) interleaves real words with
 * symbol garble ("ELecTrICAL § g MN caLL vs") — such lines stay in
 * the readout panel for tap-to-assign but must never become a
 * headline or CTA on their own.
 */
export function isCleanLine(text: string): boolean {
  if (text.length === 0) return false;
  const symbols = (text.match(/[^A-Za-z0-9\s.,&'!%#@*+•·:\/-]/g) || []).length;
  if (symbols / text.length > 0.15) return false;
  // Case chaos is the word-cloud garble signature: real design type
  // is ALL-CAPS, Title Case, or lowercase — never "ELecTrICAL".
  const tokens = text.split(/\s+/).map((t) => t.replace(/[^A-Za-z]/g, '')).filter((t) => t.length >= 3);
  if (tokens.length === 0) return true;
  const chaotic = tokens.filter((t) => {
    const upper = t === t.toUpperCase();
    const lower = t === t.toLowerCase();
    const titled = t[0] === t[0].toUpperCase() && t.slice(1) === t.slice(1).toLowerCase();
    return !upper && !lower && !titled;
  }).length;
  return chaotic / tokens.length <= 0.25;
}

/** A verbatim CTA must also be CTA-SHAPED: it starts with the call
    itself ("TICKETS OUT NOW", "CALL US", "BOOK NOW"…) — a long line
    that merely CONTAINS the word "call" is prose or noise. */
const CTA_START = /^(CALL|DM|BOOK|ORDER|GET|SIGN UP|RSVP|BUY|FREE|TICKETS|LET'S|LETS)\b/i;

const TRADE_WORDS = ['ELECTRICAL', 'PLUMBING', 'FLOORING', 'TILE', 'CONCRETE', 'PAINTING', 'REMODELING', 'ROOFING', 'HVAC', 'HANDYMAN', 'CARPENTRY', 'DRYWALL'];

const GENRE_HINTS: Array<[string, RegExp]> = [
  ['trades', /ELECTRICAL|PLUMBING|FLOORING|REMODELING|ROOFING|\bHVAC\b|HANDYMAN|CONCRETE|PAINTING|CARPENTRY|DRYWALL|\bTILE\b/i],
  ['soca', /\bSOCA\b|CARNIVAL|FETE/i],
  ['dancehall', /DANCEHALL|REGGAE|DUB\b/i],
  ['gospel', /GOSPEL|CHURCH|PRAISE|WORSHIP|MINISTRY|\bGOD\b|JESUS|\bSAVED\b|\bFAITH\b|BLESSED|GRACE/i],
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


/**
 * Strip junk tokens from a line's EDGES for field use: OCR leaves
 * residue at line starts/ends ("5 SAVED MIND" from a misread glyph,
 * "=== -/J RIDDIMROOM ===" from brush flourishes). A token is junk
 * when it carries at most one letter and is short. The readout
 * panel always shows the RAW line; only field-bound text is
 * stripped.
 */
export function stripJunkEdges(text: string): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  const letters = (t: string) => t.replace(/[^A-Za-z]/g, '').length;
  // A bare number of 2+ digits is CONTENT (a day, a year, a price) —
  // a date line must never lose its day to the edge strip. A lone
  // digit ("5 SAVED MIND" from a misread glyph) is still junk.
  const isJunk = (t: string) => letters(t) <= 1 && t.length <= 3 && !/^\d{2,}$/.test(t);
  // Strip a RUN of junk tokens from either edge, as long as a real
  // word (3+ letters) survives somewhere in the line.
  while (tokens.length > 1 && isJunk(tokens[0]) && tokens.slice(1).some((t) => letters(t) >= 3)) tokens.shift();
  while (tokens.length > 1 && isJunk(tokens[tokens.length - 1]) && tokens.slice(0, -1).some((t) => letters(t) >= 3)) tokens.pop();
  // Trim symbol junk at the very edges (quotes, slashes, equals) —
  // sentence punctuation the designer printed (. ! ?) is content.
  return tokens.join(' ').replace(/^[\s="'<>\/\\|_=~#*\u2018\u2019\u201C\u201D\u00AB\u00BB-]+|[\s="'<>\/\\|_=~#*\u2018\u2019\u201C\u201D\u00AB\u00BB-]+$/g, '');
}

/**
 * Merge two OCR passes over the same image (the engine runs an
 * auto pass and a sparse-text pass — sparse finds scattered poster
 * words the auto pass misses). A sparse fragment whose box sits
 * inside an existing line's box and whose text repeats one of that
 * line's tokens is a duplicate and drops; genuinely new fragments
 * in a shared y-band join (x order) into a synthetic line.
 */
/** Squash for comparison: case, quotes and punctuation removed so
    "LET'S" in one pass matches "LETS" in the other. */
function squash(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

export function mergeLineSets(primary: OcrLine[], extra: OcrLine[]): OcrLine[] {
  const out = [...primary];
  const contained = (inner: OcrLine, outer: OcrLine) => {
    if (!inner.box || !outer.box) return false;
    const cx = inner.box.x + inner.box.w / 2;
    const cy = inner.box.y + inner.box.h / 2;
    return cx >= outer.box.x - 0.01 && cx <= outer.box.x + outer.box.w + 0.01 && cy >= outer.box.y - 0.01 && cy <= outer.box.y + outer.box.h + 0.01;
  };
  const fresh: OcrLine[] = [];
  for (const l of extra) {
    const parent = out.find(
      (o) => contained(l, o) && squash(o.text).includes(squash(l.text).split(' ')[0] || '\u0000'),
    );
    if (parent && squash(parent.text).includes(squash(l.text))) {
      // The sparse read found a phrase INSIDE a noisier auto line.
      const coverage = squash(l.text).length / Math.max(1, squash(parent.text).length);
      if (coverage >= 0.6 && l.confidence > parent.confidence) {
        // Mostly the same line, read better: the clean version wins
        // (the realtor banner's CTA line arrived garbled in the auto
        // pass and pristine in the sparse pass).
        parent.text = l.text;
        parent.confidence = l.confidence;
        continue;
      }
      if (l.text.trim().split(/\s+/).length >= 2) {
        // A clean multi-word phrase buried in noise: keep it as its
        // own line — it will outscore its noisy parent on merit.
        if (l.text.trim().length >= 2) fresh.push(l);
        continue;
      }
      // A single word that merely repeats a token of the parent
      // (G.S.Y.M.'s SAVED inside "5 SAVED MIND") is a true duplicate.
      continue;
    }
    if (!parent && l.text.trim().length >= 2) fresh.push(l);
  }
  // Join fresh fragments that share a y-band into synthetic lines.
  const used = new Set<OcrLine>();
  for (const l of fresh) {
    if (used.has(l)) continue;
    const band = fresh.filter((o) => {
      if (used.has(o)) return false;
      if (!l.box || !o.box) return Math.abs(o.y - l.y) < 0.055;
      const centerGap = Math.abs(o.box.y + o.box.h / 2 - (l.box.y + l.box.h / 2));
      const heightRatio = Math.max(o.box.h, l.box.h) / Math.max(0.004, Math.min(o.box.h, l.box.h));
      return centerGap <= 0.03 && heightRatio <= 2.5;
    });
    band.forEach((o) => used.add(o));
    if (band.length === 1) {
      out.push(band[0]);
    } else {
      const sorted = [...band].sort((a, b) => (a.box?.x ?? 0) - (b.box?.x ?? 0));
      const x0 = Math.min(...sorted.map((o) => o.box?.x ?? 0));
      const y0 = Math.min(...sorted.map((o) => o.box?.y ?? o.y));
      const x1 = Math.max(...sorted.map((o) => (o.box?.x ?? 0) + (o.box?.w ?? 0)));
      const y1 = Math.max(...sorted.map((o) => (o.box?.y ?? o.y) + (o.box?.h ?? 0)));
      out.push({
        text: sorted.map((o) => o.text).join(' '),
        confidence: Math.min(...sorted.map((o) => o.confidence)),
        y: y0,
        box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      });
    }
  }
  return out;
}

/** Visual weight: display type is TALL — a line's box height is the
    design's own statement of what matters. Height leads, area
    supports. Lines without boxes (legacy reads) weigh 0 and the
    confidence/position scoring decides, as before. */
function visualWeight(l: OcrLine): number {
  if (!l.box) return 0;
  return l.box.h * 220 + l.box.w * l.box.h * 60;
}

function headlineScore(l: OcrLine): number {
  return l.confidence + (1 - l.y) * 25 + uppercaseRatio(l.text) * 15 + visualWeight(l) - Math.abs(l.text.length - 18) * 0.5;
}

/** A headline is words, not numbers — digit-heavy lines (prices,
    phone fragments) never lead a promo. */
function isWordLine(l: OcrLine): boolean {
  const nonSpace = l.text.replace(/\s/g, '');
  return nonSpace.length > 0 && letterCount(l.text) * 2 >= nonSpace.length;
}

function realWordCount(l: OcrLine): number {
  return l.text.split(/\s+/).map((t) => t.replace(/[^A-Za-z]/g, '')).filter((t) => t.length >= 3).length;
}

/** A DESIGNED phrase: at least two real words and every token
    mostly letters. A word-cloud row ("TILE F333 PAINTING") fails —
    one garbled token disqualifies the phrase, though its clean
    words still compete as fragments. */
function isDesignedPhrase(l: OcrLine): boolean {
  if (realWordCount(l) < 2) return false;
  return l.text.split(/\s+/).every((t) => {
    const letters = t.replace(/[^A-Za-z]/g, '').length;
    const alnum = t.replace(/[^A-Za-z0-9]/g, '').length;
    return letters >= 2 && letters / Math.max(1, alnum) >= 0.8;
  });
}

export function classifyReadout(rawLines: OcrLine[], ctx: SuggestionContext, opts?: { brandName?: string }): ReadoutResult {
  // The phone hunt runs on ALL lines — digits read at lower
  // confidence than display type, and the number is the CTA gold.
  let phone: string | undefined;
  let phoneLine: OcrLine | undefined;
  for (const l of rawLines) {
    if (l.confidence < PHONE_MIN_CONFIDENCE) continue;
    const m = clean(l.text).match(PHONE_RE);
    if (!m) continue;
    const digits = m[0].replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    if (digits.length !== 10) continue; // a partial read is not a phone number
    phone = normalizePhone(digits);
    phoneLine = { ...l, text: clean(l.text) };
    break;
  }

  // Panel lines keep the RAW read (the panel's honesty contract);
  // classification works on index-aligned stripped copies, so the
  // fields never inherit edge junk while the panel shows the truth.
  const lines = rawLines
    .map((l) => ({ ...l, text: clean(l.text) }))
    .filter((l) => l.confidence >= MIN_LINE_CONFIDENCE && l.text.length >= 2 && letterCount(l.text) >= 2)
    .sort((a, b) => a.y - b.y)
    .filter((l, i, arr) => arr.findIndex((o) => o.text === l.text) === i);
  // R18 snap-to-truth: repair plausible one-letter misreads against
  // the flyer vocabulary + the user's brand name BEFORE anything is
  // classified. The panel keeps the raw read; the fields get the
  // corrected words, and every repair is reported.
  const stripped = lines.map((l) => ({ ...l, text: stripJunkEdges(l.text) }));
  const snapped = snapLines(stripped, buildSnapVocabulary(opts?.brandName));
  const work = snapped.lines;
  const corrections = snapped.corrections;
  const panelOf = (w: OcrLine) => lines[work.indexOf(w)];

  const fullText = work.map((l) => l.text).join(' ');
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
    genre = work.length > 0 ? 'business' : genreForContext(ctx);
  }

  // Fallbacks come from the DETECTED genre's bank — the filename
  // bank is only for wordless art (genre fell back to context).
  const POST_GENRES: PostGenre[] = ['soca', 'dancehall', 'gospel', 'realestate', 'business', 'caribbean'];
  const bank = bankSuggestion(ctx);
  const detectedCta = (POST_GENRES as string[]).includes(genre) ? bankCtaForGenre(genre as PostGenre) : bank.cta;

  const ctaLine = phone
    ? undefined
    : work.find(
        (l) => CTA_HINT.test(l.text) && CTA_START.test(l.text) && isCleanLine(l.text) && l.confidence >= 55 && l.text.length <= VERBATIM_CTA_MAX_CHARS,
      );
  let subLine = work.find((l) => l !== ctaLine && SUB_HINT.test(l.text));

  const headlineCandidates = work.filter(
    (l) => l !== ctaLine && l !== subLine && l.confidence >= HEADLINE_MIN_CONFIDENCE && isCleanLine(l.text) && isWordLine(l) && l.text.length >= 3 && l.text.length <= 42,
  );
  let headline = '';
  let headlineLine: OcrLine | undefined;
  {
    let bestPhrase: { l: OcrLine; score: number } | undefined;
    let bestOther: { l: OcrLine; score: number } | undefined;
    for (const l of headlineCandidates) {
      const score = headlineScore(l);
      if (isDesignedPhrase(l)) {
        if (!bestPhrase || score > bestPhrase.score) bestPhrase = { l, score };
      } else if (!bestOther || score > bestOther.score) {
        bestOther = { l, score };
      }
    }
    const pick = bestPhrase && (!bestOther || bestOther.score <= bestPhrase.score + 30) ? bestPhrase : bestOther ?? bestPhrase;
    if (pick) {
      headline = pick.l.text;
      headlineLine = pick.l;
    }
  }

  // R18 stacked-headline assembly: flyers set headlines on TWO
  // stacked printed lines ("MIDNIGHT" over "MADNESS"). When the
  // winning headline line doesn't split into two phrases itself,
  // the line printed directly beneath it — same visual weight,
  // adjacent band, no date/venue/CTA content, no separator joins —
  // is the headline's second line, not a sub.
  const [splitHook1, splitHook2] = headline ? splitHeadline(headline) : ['', ''];
  let stackedLine: OcrLine | undefined;
  if (headlineLine && !splitHook2) {
    const H = headlineLine;
    let bestScore = -Infinity;
    for (const l of work) {
      if (l === H || l === ctaLine || l === subLine || l === phoneLine) continue;
      if (l.confidence < 55 || !isCleanLine(l.text) || !isWordLine(l)) continue;
      if (l.text.length < 3 || l.text.length > 42) continue;
      if (SUB_HINT.test(l.text) || CTA_HINT.test(l.text)) continue;
      if (l.text.includes('•') || l.text.includes('·')) continue; // a services row, never a headline
      if (realWordCount(l) < 1) continue;
      let stacked = false;
      if (H.box && l.box) {
        const gap = l.box.y - (H.box.y + H.box.h);
        const heightRatio = Math.max(H.box.h, l.box.h) / Math.max(0.004, Math.min(H.box.h, l.box.h));
        const overlap = Math.min(H.box.x + H.box.w, l.box.x + l.box.w) - Math.max(H.box.x, l.box.x);
        stacked = gap >= -0.01 && gap <= H.box.h * 1.1 && heightRatio <= 1.5 && overlap >= Math.min(H.box.w, l.box.w) * 0.4;
      } else {
        const dy = l.y - H.y;
        stacked = dy >= 0.03 && dy <= 0.16;
      }
      // A lone word under a lone word is a headline pair ONLY when
      // the pair stands alone at that size — a word cloud stacks a
      // dozen same-size words (ELECTRICAL over FLOORING over TILE)
      // and none of them is the other's second line.
      if (stacked && H.box && l.box && realWordCount(H) < 2 && realWordCount(l) < 2) {
        const neighbors = work.filter(
          (o) =>
            o !== H && o !== l && o.box && o.confidence >= 55 && isCleanLine(o.text) &&
            Math.max(o.box.h, H.box!.h) / Math.max(0.004, Math.min(o.box.h, H.box!.h)) <= 1.5 &&
            o.box.y >= H.box!.y - 0.05 && o.box.y <= l.box!.y + l.box!.h + H.box!.h * 3,
        );
        if (neighbors.length > 0) stacked = false;
      }
      if (stacked && headlineScore(l) > bestScore) {
        bestScore = headlineScore(l);
        stackedLine = l;
      }
    }
  }

  // Trades art: the services themselves are the details line.
  let servicesSub: string | undefined;
  if (genre === 'trades' && !subLine) {
    const found: string[] = [];
    for (const l of work) {
      for (const w of TRADE_WORDS) {
        if (new RegExp(`\\b${w}\\b`, 'i').test(l.text) && !found.includes(w)) found.push(w);
      }
    }
    const withoutHeadline = found.filter((w) => !headline.toUpperCase().includes(w));
    const picks = (withoutHeadline.length >= 2 ? withoutHeadline : found).slice(0, 3);
    if (picks.length >= 2) servicesSub = picks.join(' • ');
  }

  // Secondary line as the details line: when the art prints no
  // date/venue (designs, logos, statements), the strongest other
  // clean line IS the supporting message — a tagline, a brand
  // sign-off, a punchline. Better the art's own second line than
  // an empty gap or a borrowed bank line.
  let secondary: OcrLine | undefined;
  if (!subLine && !servicesSub && headline) {
    const eligible = work.filter(
      (l) =>
        l !== headlineLine && l !== stackedLine && l !== ctaLine && l !== phoneLine &&
        l.confidence >= 55 && isCleanLine(l.text) && isWordLine(l) &&
        l.text.length >= 3 && l.text.length <= 42 &&
        l.text.toUpperCase() !== headline.toUpperCase(),
    );
    // A details line is a PHRASE first: designed phrases, then any
    // multi-word line, and only then a lone fragment (a brand
    // sign-off like RIDDIMROOM still lands when nothing else read).
    const tiers = [
      eligible.filter(isDesignedPhrase),
      eligible.filter((l) => realWordCount(l) >= 2),
      eligible,
    ];
    for (const tier of tiers) {
      let best = -Infinity;
      for (const l of tier) {
        const score = headlineScore(l);
        if (score > best) {
          best = score;
          secondary = l;
        }
      }
      if (secondary) break;
    }
  }

  const fields: Partial<PromoTexts> = {};
  const sources: ReadoutResult['sources'] = {};
  if (headline) {
    fields.hook1 = splitHook1;
    sources.hook1 = 'art';
    if (splitHook2) {
      fields.hook2 = splitHook2;
      sources.hook2 = 'art';
    } else if (stackedLine) {
      fields.hook2 = stackedLine.text;
      sources.hook2 = 'art';
    }
  }
  if (subLine) {
    fields.sub = subLine.text;
    sources.sub = 'art';
  } else if (servicesSub) {
    fields.sub = servicesSub;
    sources.sub = 'art';
  } else if (secondary) {
    fields.sub = secondary.text;
    sources.sub = 'art';
  }
  if (phone) {
    fields.cta = `CALL ${phone}`;
    sources.cta = 'art';
  } else if (ctaLine) {
    fields.cta = ctaLine.text;
    sources.cta = 'art';
  } else if (genre === 'trades') {
    fields.cta = 'CALL US TODAY';
    sources.cta = 'suggested';
  } else {
    fields.cta = detectedCta;
    sources.cta = 'suggested';
  }

  return {
    fields,
    sources,
    genre,
    lines,
    headline,
    headlineLine: headlineLine ? panelOf(headlineLine) : undefined,
    stackedLine: stackedLine ? panelOf(stackedLine) : undefined,
    corrections,
    ctaLine: ctaLine ? panelOf(ctaLine) : undefined,
    phoneLine,
    phone,
  };
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
