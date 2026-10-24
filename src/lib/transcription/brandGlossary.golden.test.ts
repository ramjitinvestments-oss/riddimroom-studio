import { describe, it, expect } from 'vitest';
import { applyBrandGlossary } from './brandGlossary';
import type { TranscriptionWord } from './types';
import testset from './fixtures/brand-golden-testset.json';
import whisperOutputs from './fixtures/brand-golden-whisper.json';

/**
 * Golden run (spec §d.3): the correction layer over the stored baseline
 * outputs of the 12-clip golden set must fix the flagship brand failure
 * without touching anything else. Fixtures + provenance: ./fixtures/README.md.
 *
 * ACCOUNTING: the spec's expected-effect figures are brand 5/6 applied and
 * brand-clip needs-edit 3/8. Those require G3 ("written room") to apply
 * deterministically. G3 originally shipped in shadow/log-only mode under
 * the spec's rollout rule (single observation), which yielded 4/6 applied
 * + 1 shadow (= 5/6 coverage) and 4/8. On 2026-10-23 the owner directed
 * the promotion ("make it the correct premium way"), so the asserted
 * figures below are the spec's headline ones: 5/6 applied, 3/8, overall
 * 10/12 -> 7/12. film-line3 ("riddim") remains the one untouchable
 * occurrence — a stated non-goal.
 */

interface GoldenClip {
  id: string;
  category: string;
  ground_truth: string;
  baseline: string;
}

const raw = whisperOutputs as unknown as Record<string, { category: string; ground_truth: string; whisper_small_en: string }>;
const clips: GoldenClip[] = testset.clips.map((c) => ({
  id: c.id,
  category: c.category,
  ground_truth: c.ground_truth,
  baseline: raw[c.id].whisper_small_en,
}));

// --- Scoring ported from the golden-set scorer (phase4l/captions/measure.py):
// normalized tokens = lowercase, non-alphanumerics -> spaces, digit-words unified.
const DIGITS: Record<string, string> = {
  '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
  '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine', '10': 'ten',
};

function toks(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => DIGITS[w] ?? w);
}

function wordEditCount(ref: string[], hyp: string[]): number {
  const n = ref.length;
  const m = hyp.length;
  const dp: number[][] = Array.from({ length: n + 1 }, (_, i) => {
    const row = new Array<number>(m + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
  }
  return dp[n][m];
}

const needsEdit = (clip: GoldenClip, hypothesis: string) => wordEditCount(toks(clip.ground_truth), toks(hypothesis)) > 0;

// Brand occurrence truth table, copied from measure.py's brand_gt.
const BRAND_GT: Record<string, string> = {
  'promo-line3': 'RiddimRoom',
  'promo-line4': 'riddimroom.com',
  'film-line2': 'RiddimRoom',
  'film-line3': 'riddim',
  'film-line7': 'RiddimRoom',
  'film-line8': 'RiddimRoom',
};

function brandCorrect(tokenName: string, hypothesis: string): boolean {
  const hyp = toks(hypothesis);
  if (tokenName === 'RiddimRoom') return hyp.includes('riddimroom');
  if (tokenName === 'riddimroom.com') return (hyp.includes('riddimroom') && hyp.includes('com')) || hyp.includes('riddimroomcom');
  return hyp.includes('riddim'); // standalone "riddim" (film-line3)
}

/** Split a baseline transcript string into pseudo-words with dummy timings. */
function pseudoWords(text: string): TranscriptionWord[] {
  return text.split(/\s+/).filter(Boolean).map((t, i) => ({ text: t, start: i, end: i + 0.4 }));
}

const joined = (words: TranscriptionWord[]) => words.map((w) => w.text).join(' ');

function runLayer(clip: GoldenClip) {
  const input = pseudoWords(clip.baseline);
  const result = applyBrandGlossary(input);
  return { input, result, after: joined(result.words) };
}

const brand = clips.filter((c) => c.category === 'brand');
const patois = clips.filter((c) => c.category === 'patois');

describe('golden run — per-clip corrected output', () => {
  const expectedAfter: Record<string, string> = {
    'promo-line1': 'Your brand has 3 seconds to stop the scroll or it is gone forever.',
    'promo-line3': 'RiddimRoom creates cinematic brand films and premium Caribbean-style people remember.',
    'promo-line4': 'Go to RiddimRoom.com and get created different today, your brand deserves it.',
    'film-line1-control': 'This is not fast fashion, this is Caribbean culture worn with pride.',
    'film-line2': 'from Trinidad and Tobago to the world. RiddimRoom carries the sound of the color and the soul of home.',
    'film-line3': 'Every D sound begins with the rhythm, the heartbeat you feel before the music even starts.',
    'film-line7': 'put on RiddimRoom, and home is never far. The people, the party, the culture that raised you.',
    'film-line8': 'RiddimRoom this caribbean culture created different and this is already beginning of a story',
  };

  for (const clip of brand) {
    it(`${clip.id}: baseline -> expected corrected text`, () => {
      expect(runLayer(clip).after).toBe(expectedAfter[clip.id]);
    });
  }

  it('film-line7: "written room" is corrected via G3 (owner-promoted), nothing shadow-logged', () => {
    const clip = clips.find((c) => c.id === 'film-line7')!;
    const { result } = runLayer(clip);
    expect(result.corrections).toEqual([
      { wordIndex: 2, from: 'written room,', to: 'RiddimRoom,', entryId: 'G3' },
    ]);
    expect(result.shadowHits).toEqual([]);
  });
});

describe('golden run — controls byte-identical (spec §d.3)', () => {
  for (const id of ['promo-line1', 'film-line1-control']) {
    it(`${id}: words untouched, joined text identical to baseline`, () => {
      const clip = clips.find((c) => c.id === id)!;
      const { input, result, after } = runLayer(clip);
      expect(result.words).toEqual(input);
      expect(after).toBe(clip.baseline);
      expect(result.corrections).toEqual([]);
      expect(result.shadowHits).toEqual([]);
    });
  }
});

describe('golden run — patois clips are never touched (owner correction)', () => {
  for (const clip of patois) {
    it(`${clip.id}: unchanged`, () => {
      const { input, result } = runLayer(clip);
      expect(result.words).toEqual(input);
      expect(result.corrections).toEqual([]);
      expect(result.shadowHits).toEqual([]);
    });
  }
});

describe('golden run — headline numbers', () => {
  it('baseline sanity: before the layer, brand is 0/6 and 10/12 clips need edits', () => {
    const correct = Object.entries(BRAND_GT).filter(([id, tok]) => brandCorrect(tok, clips.find((c) => c.id === id)!.baseline));
    expect(correct).toHaveLength(0);
    expect(clips.filter((c) => needsEdit(c, c.baseline))).toHaveLength(10);
    expect(brand.filter((c) => needsEdit(c, c.baseline))).toHaveLength(6);
  });

  it('after the layer: brand 5/6 applied (G3 promoted by owner direction)', () => {
    const runs = new Map(clips.map((c) => [c.id, runLayer(c)]));
    const applied = Object.entries(BRAND_GT).filter(([id, tok]) => brandCorrect(tok, runs.get(id)!.after));
    const shadowFixed = Object.keys(BRAND_GT).filter((id) => runs.get(id)!.result.shadowHits.length > 0);
    // film-line3 ("riddim") is the one occurrence no entry may touch — a stated non-goal.
    expect(applied.map(([id]) => id).sort()).toEqual(['film-line2', 'film-line7', 'film-line8', 'promo-line3', 'promo-line4']);
    expect(shadowFixed).toEqual([]);
    expect(applied.length).toBe(5); // of 6 — the spec's 5/6, applied outright
  });

  it('after the layer: brand-clip needs-edit is 3/8 (G3 promoted)', () => {
    const stillNeeding = brand.filter((c) => needsEdit(c, runLayer(c).after)).map((c) => c.id).sort();
    expect(stillNeeding).toEqual(['film-line2', 'film-line3', 'film-line8']);
    // Overall: 10/12 -> 7/12 (promo-line3, promo-line4 and film-line7 become fully clean).
    expect(clips.filter((c) => needsEdit(c, runLayer(c).after))).toHaveLength(7);
  });
});
