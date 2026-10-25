import type { OcrLine } from './readout';

/**
 * Snap-to-truth (R18) — the correction layer between the raw OCR
 * read and the classifier. OCR's characteristic failure is the
 * PLAUSIBLE misread: one letter wrong in a word it otherwise saw
 * clearly ("RUTENBERGE", "TICKETZ"). Those pass every garble guard
 * because they look clean. Snapping compares each read token
 * against a vocabulary of words that legitimately appear on flyers
 * — plus the user's own brand name from their brand kit, the one
 * spelling that must be exact — and repairs a token only when it is
 * within a small edit distance of exactly one vocabulary word.
 * Every repair is RECORDED and shown to the user ("Corrected to
 * your spelling"), never silent. Panel lines stay raw; only the
 * classifier's working copies are snapped.
 */

export interface SnapCorrection {
  from: string;
  to: string;
}

const BASE_VOCAB = [
  // Calendar
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
  'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY',
  // Flyer language
  'TICKETS', 'ADMISSION', 'FEATURING', 'PRESENTS', 'PRESENT', 'LIVE', 'MUSIC', 'CONCERT', 'PARTY', 'FETE',
  'SOCA', 'DANCEHALL', 'REGGAE', 'GOSPEL', 'CARNIVAL', 'NIGHT', 'DOORS', 'ENTRY', 'FREE', 'LADIES', 'GENTS',
  'VENUE', 'HALL', 'CENTER', 'CENTRE', 'ARENA', 'CALL', 'BOOK', 'BOOKING', 'BOOKINGS', 'TODAY', 'INFO',
  'CONTACT', 'SERVICES', 'SERVICE', 'WELCOME', 'EXCELLENCE', 'STANDARD', 'PRODUCTION', 'PRODUCTIONS',
  'ELECTRICAL', 'PLUMBING', 'FLOORING', 'REMODELING', 'ROOFING', 'PAINTING', 'TILE', 'CONCRETE',
  'MINISTRY', 'CHURCH', 'PRAISE', 'WORSHIP', 'SAVED', 'GRACE', 'FAITH',
  'REALTY', 'REALTOR', 'ESTATE', 'PROPERTIES', 'LISTING', 'LISTINGS',
  'EVENT', 'EVENTS', 'SPECIAL', 'ANNUAL', 'GRAND', 'OPENING', 'CELEBRATION',
];

/** Classic Levenshtein with an early exit above the cap. */
export function editDistance(a: string, b: string, cap = 2): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const prev = new Array(b.length + 1).fill(0).map((_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let best = i;
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > cap) return cap + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/** Put `word` in the casing pattern of `pattern` (ALL-CAPS design
    type stays caps; a Title-case read takes the title form). */
function applyCase(pattern: string, word: string): string {
  const letters = pattern.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 2 && letters === letters.toUpperCase()) return word.toUpperCase();
  if (letters.length >= 2 && letters === letters.toLowerCase()) return word.toLowerCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function lettersOf(token: string): string {
  return token.replace(/[^A-Za-z]/g, '');
}

/**
 * The snap vocabulary: the base flyer vocabulary plus the user's
 * brand name — the full phrase and each of its words — stored with
 * the user's own casing for phrase repairs.
 */
export function buildSnapVocabulary(brandName?: string): { vocab: Set<string>; brandTokens: string[]; brandName: string } {
  const vocab = new Set(BASE_VOCAB);
  const name = (brandName ?? '').trim().replace(/\s+/g, ' ');
  const brandTokens = name ? name.split(' ').map((t) => t.toUpperCase()).filter((t) => lettersOf(t).length >= 2) : [];
  for (const t of brandTokens) vocab.add(t);
  return { vocab, brandTokens, brandName: name };
}

function snapToken(
  token: string,
  vocab: Set<string>,
  corrections: Map<string, SnapCorrection>,
  brandTokens: Set<string> = new Set(),
): string {
  const core = lettersOf(token);
  // Digits, short tokens and already-true words are never touched.
  if (!core || core.length < 4 || /\d/.test(token)) return token;
  const upper = core.toUpperCase();
  if (vocab.has(upper)) return token;
  // Distance discipline (learned on the owner's Powerline logo:
  // LIGHTING is distance 2 from LISTING — a two-letter interior
  // change is not an OCR slip, it's a different word). Base
  // vocabulary repairs are distance-1 ONLY. The user's own brand
  // tokens — a tiny, specific vocabulary — may repair distance 2
  // on long words when the first and last letters agree.
  const maxDist = 1;
  let best: string | null = null;
  let bestDist = maxDist + 1;
  let ties = 0;
  for (const word of vocab) {
    const wordMax = brandTokens.has(word) && upper.length >= 8 && word[0] === upper[0] && word[word.length - 1] === upper[upper.length - 1] ? 2 : maxDist;
    if (Math.abs(word.length - upper.length) > wordMax) continue;
    const d = editDistance(upper, word, wordMax);
    if (d < bestDist) {
      bestDist = d;
      best = word;
      ties = 1;
    } else if (d === bestDist) {
      ties += 1;
    }
  }
  // Ambiguous repairs are worse than none — snap only on a unique win.
  if (!best || ties > 1 || bestDist > 2) return token;
  const repaired = token.replace(core, applyCase(core, best));
  if (repaired !== token) {
    const key = `${token}→${repaired}`;
    if (!corrections.has(key)) corrections.set(key, { from: token, to: repaired });
  }
  return repaired;
}

/**
 * Snap a set of working lines. Returns NEW line objects (the raw
 * panel lines are never mutated) plus every correction made.
 * Brand-phrase snapping runs first: a multi-word brand name whose
 * words all read within one edit is restored as the exact phrase.
 */
export function snapLines(
  lines: OcrLine[],
  brand: { vocab: Set<string>; brandTokens: string[]; brandName: string },
): { lines: OcrLine[]; corrections: SnapCorrection[] } {
  const corrections = new Map<string, SnapCorrection>();
  const out = lines.map((line) => {
    let tokens = line.text.split(/\s+/).filter(Boolean);
    // Brand phrase snap.
    if (brand.brandTokens.length >= 2 && tokens.length >= brand.brandTokens.length) {
      for (let i = 0; i + brand.brandTokens.length <= tokens.length; i++) {
        const span = tokens.slice(i, i + brand.brandTokens.length);
        const near = span.every((t, j) => {
          const u = lettersOf(t).toUpperCase();
          return u === brand.brandTokens[j] || editDistance(u, brand.brandTokens[j], 1) <= 1;
        });
        const differs = span.some((t, j) => lettersOf(t).toUpperCase() !== brand.brandTokens[j]);
        if (near && differs) {
          const from = span.join(' ');
          // The DESIGN's casing wins: an all-caps span takes the
          // brand name in caps; otherwise the user's own casing.
          const spanLetters = span.map((t) => lettersOf(t)).join('');
          const replacement =
            spanLetters.length >= 2 && spanLetters === spanLetters.toUpperCase()
              ? brand.brandName.toUpperCase()
              : spanLetters === spanLetters.toLowerCase()
                ? brand.brandName.toLowerCase()
                : brand.brandName;
          tokens = [...tokens.slice(0, i), replacement, ...tokens.slice(i + brand.brandTokens.length)];
          const key = `${from}→${replacement}`;
          if (!corrections.has(key)) corrections.set(key, { from, to: replacement });
          break;
        }
      }
    }
    const text = tokens.map((t) => snapToken(t, brand.vocab, corrections, new Set(brand.brandTokens))).join(' ');
    return text === line.text ? line : { ...line, text };
  });
  return { lines: out, corrections: [...corrections.values()] };
}
