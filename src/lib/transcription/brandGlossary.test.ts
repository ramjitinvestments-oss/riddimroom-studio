import { describe, it, expect } from 'vitest';
import { applyBrandGlossary, BRAND_GLOSSARY } from './brandGlossary';
import type { TranscriptionWord } from './types';

/** Build words with simple increasing timings from raw token strings. */
function words(...texts: string[]): TranscriptionWord[] {
  return texts.map((text, i) => ({ text, start: i, end: i + 0.4 }));
}

function texts(result: { words: TranscriptionWord[] }): string {
  return result.words.map((w) => w.text).join(' ');
}

describe('glossary data carries its evidence (spec §a/§e)', () => {
  it('every entry has golden-set evidence clip IDs and a valid mode', () => {
    expect(BRAND_GLOSSARY.length).toBe(3);
    for (const entry of BRAND_GLOSSARY) {
      expect(entry.evidence.length).toBeGreaterThan(0);
      expect(['deterministic', 'shadow']).toContain(entry.mode);
      expect(entry.correct === 'RiddimRoom' || entry.correct === 'RiddimRoom.com').toBe(true);
    }
  });

  it('all entries are deterministic (G3 promoted by owner direction 2026-10-23)', () => {
    const byId = Object.fromEntries(BRAND_GLOSSARY.map((e) => [e.id, e.mode]));
    expect(byId).toEqual({ G1: 'deterministic', G2: 'deterministic', G3: 'deterministic' });
  });
});

describe('G1 — "Rhythm Room" -> "RiddimRoom"', () => {
  it('fires on the observed verbatim form and merges timings across the run', () => {
    const input = words('Rhythm', 'Room', 'creates');
    const result = applyBrandGlossary(input);
    expect(texts(result)).toBe('RiddimRoom creates');
    expect(result.words[0]).toEqual({ text: 'RiddimRoom', start: 0, end: 1.4 });
    expect(result.corrections).toEqual([{ wordIndex: 0, from: 'Rhythm Room', to: 'RiddimRoom', entryId: 'G1' }]);
    expect(result.shadowHits).toEqual([]);
  });

  it('is case-insensitive and always emits canonical casing', () => {
    for (const [a, b] of [
      ['rhythm', 'room'],
      ['RHYTHM', 'ROOM'],
      ['Rhythm', 'room'],
    ]) {
      const result = applyBrandGlossary(words(a, b, 'tonight'));
      expect(texts(result)).toBe('RiddimRoom tonight');
    }
  });

  it('preserves the run-final punctuation instead of eating the sentence end', () => {
    const result = applyBrandGlossary(words('at', 'the', 'Rhythm', 'Room.'));
    expect(texts(result)).toBe('at the RiddimRoom.');
    expect(result.corrections[0].to).toBe('RiddimRoom.');
  });

  it('leaves every other word (text and timings) untouched', () => {
    const input = words('From', 'Trinidad', 'Rhythm', 'Room', 'carries');
    const result = applyBrandGlossary(input);
    expect(result.words[0]).toEqual(input[0]);
    expect(result.words[1]).toEqual(input[1]);
    expect(result.words[3]).toEqual(input[4]);
  });
});

describe('G2 — URL merge -> "RiddimRoom.com"', () => {
  it('fires on the whisper-observed form "Rhythm Room, come"', () => {
    const result = applyBrandGlossary(words('Go', 'to', 'Rhythm', 'Room,', 'come', 'and'));
    expect(texts(result)).toBe('Go to RiddimRoom.com and');
    expect(result.corrections).toEqual([
      { wordIndex: 2, from: 'Rhythm Room, come', to: 'RiddimRoom.com', entryId: 'G2' },
    ]);
  });

  it('fires on the Gemini-observed form "Rhythm Room. com"', () => {
    const result = applyBrandGlossary(words('Go', 'to', 'Rhythm', 'Room.', 'com', 'today'));
    expect(texts(result)).toBe('Go to RiddimRoom.com today');
    expect(result.corrections[0].entryId).toBe('G2');
  });

  it('wins over G1 where both could fire (longest match first)', () => {
    const result = applyBrandGlossary(words('Rhythm', 'Room', 'come'));
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0].entryId).toBe('G2');
  });

  it('does NOT merge when "come" is not directly after the brand form', () => {
    const result = applyBrandGlossary(words('come', 'to', 'the', 'Rhythm', 'Room'));
    expect(texts(result)).toBe('come to the RiddimRoom');
    expect(result.corrections[0].entryId).toBe('G1');
  });

  it('does NOT merge non-adjacent tokens (no cross-cue merging)', () => {
    const result = applyBrandGlossary(words('Rhythm', 'of', 'the', 'Room'));
    expect(texts(result)).toBe('Rhythm of the Room');
    expect(result.corrections).toEqual([]);
  });
});

describe('G3 — "written room" -> "RiddimRoom" (promoted by owner direction 2026-10-23)', () => {
  it('applies deterministically, preserving trailing punctuation', () => {
    const input = words('put', 'on', 'written', 'room,', 'and');
    const result = applyBrandGlossary(input);
    expect(texts(result)).toBe('put on RiddimRoom, and');
    expect(result.corrections).toEqual([
      { wordIndex: 2, from: 'written room,', to: 'RiddimRoom,', entryId: 'G3' },
    ]);
    expect(result.shadowHits).toEqual([]);
  });
});

describe('non-goals — the layer must never touch these (spec §a/§e)', () => {
  it('a control sentence with legitimate "rhythm" passes byte-identical', () => {
    const input = words('feel', 'the', 'rhythm', 'of', 'the', 'night');
    const result = applyBrandGlossary(input);
    expect(result.words).toBe(input); // same reference — untouched by construction
    expect(texts(result)).toBe('feel the rhythm of the night');
    expect(result.corrections).toEqual([]);
    expect(result.shadowHits).toEqual([]);
  });

  it('film-line3\'s "the rhythm" stays exactly as transcribed', () => {
    const input = words('begins', 'with', 'the', 'rhythm,', 'the', 'heartbeat');
    const result = applyBrandGlossary(input);
    expect(result.words).toBe(input);
    expect(result.corrections).toEqual([]);
  });

  it('an already-correct "RiddimRoom" passes through untouched', () => {
    const input = words('RiddimRoom', 'creates');
    const result = applyBrandGlossary(input);
    expect(result.words).toBe(input);
    expect(result.corrections).toEqual([]);
  });

  it('a lone "room" or lone "rhythm" never fires', () => {
    const input = words('Plenty', 'room', 'in', 'here', 'rhythm');
    const result = applyBrandGlossary(input);
    expect(result.words).toBe(input);
  });
});

describe('purity and shape', () => {
  it('never mutates the input words', () => {
    const input = words('Rhythm', 'Room', 'creates');
    const snapshot = JSON.parse(JSON.stringify(input));
    applyBrandGlossary(input);
    expect(input).toEqual(snapshot);
  });

  it('handles an empty words array', () => {
    const result = applyBrandGlossary([]);
    expect(result).toEqual({ words: [], corrections: [], shadowHits: [] });
  });

  it('correction wordIndex addresses the returned array after earlier merges shift positions', () => {
    const result = applyBrandGlossary(words('Rhythm', 'Room', 'and', 'Rhythm', 'Room'));
    expect(texts(result)).toBe('RiddimRoom and RiddimRoom');
    expect(result.corrections.map((c) => c.wordIndex)).toEqual([0, 2]);
    expect(result.words[2].text).toBe('RiddimRoom');
  });
});
