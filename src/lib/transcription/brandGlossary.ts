/**
 * RiddimRoom Studio — brand-glossary correction layer (Pre-live build 1).
 *
 * Governing spec: rea-product-line/phase4l/captions/CORRECTION-SPEC.md (as
 * owner-corrected 2026-10-23 — brand glossary ONLY; the patois suggestion
 * layer was removed by the owner and is NOT implemented here).
 *
 * What this does: a deterministic post-processing pass over FRESH provider
 * output in the /api/transcribe response path. Speech-to-text renders the
 * brand name correctly 0% of the time on this niche's real content
 * (measured on the golden set — see CAPTION-ACCURACY-REPORT.md), in a small
 * set of closed, repetitive error forms. This layer restores the canonical
 * forms — **RiddimRoom** and **RiddimRoom.com** (owner-confirmed casing;
 * "Riddimroom" is never a valid output) — before the client ever sees the
 * words. The client stores the corrected words as the canonical captions,
 * so exports (MP4 burn-in, SRT, VTT) inherit them with no second
 * implementation anywhere.
 *
 * Hard limits (spec §e — these are requirements, not guidelines):
 * - Runs ONLY on fresh provider output at transcription time. It is called
 *   exactly once, in the transcribe handlers, on the provider result of
 *   that request. User-edited captions live in client-side project state
 *   and are never sent back through this code path — there is no route
 *   from stored/edited cues to this function, so it cannot touch them.
 * - Applies ONLY to caption word text. Nothing else (titles, filenames,
 *   search) is ever passed to it.
 * - Every entry carries golden-set clip evidence. No entry without an
 *   observed error behind it.
 * - Ambiguous/common words are NEVER rewritten. "rhythm" on its own stays
 *   exactly as transcribed (film-line3's "the rhythm" is a non-goal: it is
 *   a legitimate English word in music content).
 * - Shadow entries (mode: 'shadow') record what WOULD change and change
 *   nothing. New single-observation entries ship in shadow by default.
 *   G3 was promoted to deterministic on the owner's explicit direction
 *   (2026-10-23, "make it the correct premium way"): the brand is never
 *   left wrong on a technicality, "written room" has effectively nil
 *   collision risk in caption text, and the Stage B live-provider golden
 *   run still validates it — a misfire there demotes it with evidence.
 * - Never hides its work: applied corrections are returned in the response
 *   metadata and logged; shadow hits are logged server-side.
 *
 * Server-side only, like the rest of this folder.
 */

import type { TranscriptionWord } from './types.js';

export const BRAND_GLOSSARY_VERSION = '1.1.0';

export interface BrandGlossaryEntry {
  id: string;
  mode: 'deterministic' | 'shadow';
  /**
   * Wrong forms as sequences of normalized tokens (see normalizeTokenKey):
   * lowercase, punctuation folded to spaces. A form matches a run of
   * consecutive words whose keys, joined, equal the form joined — so both
   * ["Rhythm","Room,"] and a single word "Rhythm Room" can match.
   */
  wrongForms: string[][];
  /** Canonical replacement text (exact casing). */
  correct: string;
  /** Golden-set clip IDs where this error was actually observed. */
  evidence: string[];
  note: string;
}

/**
 * The glossary. Order in this array does not matter — matching always
 * prefers the longest form at each position, so the G2 URL merge wins
 * over the G1 plain merge wherever both could fire.
 */
export const BRAND_GLOSSARY: BrandGlossaryEntry[] = [
  {
    id: 'G1',
    mode: 'deterministic',
    wrongForms: [['rhythm', 'room']],
    correct: 'RiddimRoom',
    evidence: ['promo-line3', 'film-line2', 'film-line8'],
    note: 'The flagship error — "Rhythm Room" for RiddimRoom (also observed from the production Gemini path, promo cue 3). Case-insensitive; always emits canonical casing.',
  },
  {
    id: 'G2',
    mode: 'deterministic',
    wrongForms: [
      ['rhythm', 'room', 'com'],
      ['rhythm', 'room', 'come'],
    ],
    correct: 'RiddimRoom.com',
    evidence: ['promo-line4'],
    note: 'URL merge: applies only when a "com"/"come" token directly follows the brand error form (promo-line4 baseline; production Gemini rendered "Rhythm Room. com" as promo cue 5).',
  },
  {
    id: 'G3',
    mode: 'deterministic',
    wrongForms: [['written', 'room']],
    correct: 'RiddimRoom',
    evidence: ['film-line7'],
    note: 'Single observation ("put on written room"). Promoted from shadow to deterministic on the owner\u2019s explicit direction 2026-10-23 ("make it the correct premium way") — nil collision risk in caption text; the Stage B live-provider golden run remains its validation gate (demote with evidence if it misfires there).',
  },
];

export interface BrandCorrection {
  /** Index of the corrected word in the RETURNED words array. */
  wordIndex: number;
  /** The original word texts that were replaced, joined with a space (verbatim). */
  from: string;
  /** The canonical text emitted. */
  to: string;
  /** Glossary entry that fired (e.g. "G1"). */
  entryId: string;
}

export interface BrandShadowHit {
  /** Index of the first matched word in the returned (unchanged) words array. */
  wordIndex: number;
  /** The original word texts that WOULD have been replaced, joined with a space (verbatim). */
  from: string;
  /** The canonical text that WOULD have been emitted. Nothing was changed. */
  to: string;
  /** Glossary entry that matched (e.g. "G3"). */
  entryId: string;
}

export interface BrandGlossaryResult {
  words: TranscriptionWord[];
  corrections: BrandCorrection[];
  shadowHits: BrandShadowHit[];
}

/**
 * Matching key for one word's text, mirroring the golden-set scorer's
 * normalization (measure.py `toks`): lowercase, every non-alphanumeric
 * character becomes a space, whitespace collapsed. "Room," -> "room",
 * "Rhythm Room" (one word) -> "rhythm room".
 */
function normalizeTokenKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Trailing punctuation of a word's original text (e.g. "." in "Room."). */
function trailingPunctuation(text: string): string {
  const match = text.match(/[^A-Za-z0-9]+$/);
  return match ? match[0] : '';
}

interface Candidate {
  entry: BrandGlossaryEntry;
  form: string[];
  formKey: string;
  length: number;
}

// All (entry, form) pairs, longest first, so the URL merge (3 tokens) is
// always attempted before the plain merge (2 tokens) at any position.
const CANDIDATES: Candidate[] = BRAND_GLOSSARY.flatMap((entry) =>
  entry.wrongForms.map((form) => ({
    entry,
    form,
    formKey: form.join(' '),
    length: form.length,
  })),
).sort((a, b) => b.length - a.length);

/**
 * Apply the brand glossary to one fresh provider result.
 *
 * Pure: the input array and its words are never mutated; when nothing
 * matches, the input array is returned as-is (same reference).
 *
 * A match is a run of CONSECUTIVE words — the forms never fire on words
 * separated by other words, so nothing can merge across what the client
 * will later chunk into separate caption cues from non-adjacent words.
 * A merged deterministic match becomes one word whose timings span the
 * run (start of the first word, end of the last). Trailing punctuation of
 * the run's last word is preserved on the replacement ("Rhythm Room." ->
 * "RiddimRoom.") — only the wrong words change, never the sentence's
 * punctuation. Punctuation carried by earlier words in the run (the comma
 * in "Rhythm Room, come") was part of the error rendering and is dropped.
 */
export function applyBrandGlossary(words: TranscriptionWord[]): BrandGlossaryResult {
  const keys = words.map((w) => normalizeTokenKey(w.text));
  const corrections: BrandCorrection[] = [];
  const shadowHits: BrandShadowHit[] = [];
  const out: TranscriptionWord[] = [];

  let i = 0;
  while (i < words.length) {
    let matched: { candidate: Candidate; runEnd: number } | null = null;
    for (const candidate of CANDIDATES) {
      // Grow a run of consecutive words whose joined keys equal the form.
      let joined = '';
      let j = i;
      while (j < words.length) {
        joined = joined ? `${joined} ${keys[j]}` : keys[j];
        if (joined === candidate.formKey) {
          matched = { candidate, runEnd: j };
          break;
        }
        if (!candidate.formKey.startsWith(joined)) break;
        j += 1;
      }
      if (matched) break;
    }

    if (!matched) {
      out.push(words[i]);
      i += 1;
      continue;
    }

    const { candidate, runEnd } = matched;
    const run = words.slice(i, runEnd + 1);
    const from = run.map((w) => w.text).join(' ');

    if (candidate.entry.mode === 'shadow') {
      shadowHits.push({ wordIndex: out.length, from, to: candidate.entry.correct, entryId: candidate.entry.id });
      for (const w of run) out.push(w);
    } else {
      const punct = trailingPunctuation(run[run.length - 1].text);
      const to = punct && !candidate.entry.correct.endsWith(punct) ? candidate.entry.correct + punct : candidate.entry.correct;
      corrections.push({ wordIndex: out.length, from, to, entryId: candidate.entry.id });
      out.push({ text: to, start: run[0].start, end: run[run.length - 1].end });
    }
    i = runEnd + 1;
  }

  if (corrections.length === 0) {
    // Nothing applied (shadow hits do not alter the words): hand back the
    // input untouched so unchanged results are byte-identical by construction.
    return { words, corrections, shadowHits };
  }
  return { words: out, corrections, shadowHits };
}
