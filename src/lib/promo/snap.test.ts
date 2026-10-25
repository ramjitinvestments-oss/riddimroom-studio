import { describe, expect, it } from 'vitest';
import { buildSnapVocabulary, editDistance, snapLines } from './snap';
import type { OcrLine } from './readout';

const line = (text: string): OcrLine => ({ text, confidence: 90, y: 0.1 });

describe('snap-to-truth', () => {
  it('edit distance basics', () => {
    expect(editDistance('RUTENBERG', 'RUTENBERGE')).toBe(1);
    expect(editDistance('TICKETS', 'TICKETS')).toBe(0);
    expect(editDistance('ABC', 'XYZ')).toBe(3);
  });

  it('repairs a one-letter brand misread to the kit spelling', () => {
    const { lines, corrections } = snapLines([line('RUTENBERGE REALTY')], buildSnapVocabulary('Rutenberg Realty'));
    expect(lines[0].text).toBe('RUTENBERG REALTY');
    expect(corrections).toContainEqual({ from: 'RUTENBERGE REALTY', to: 'RUTENBERG REALTY' });
  });

  it('restores a multi-word brand phrase exactly as the user spells it', () => {
    const { lines, corrections } = snapLines([line('HELEM CINTRON REALTOR')], buildSnapVocabulary('Helen Cintron'));
    // Letters restored exactly; casing follows the artwork (all caps here).
    expect(lines[0].text).toContain('HELEN CINTRON');
    expect(corrections.some((c) => c.to === 'HELEN CINTRON')).toBe(true);
  });

  it('repairs flyer vocabulary misreads', () => {
    const { lines } = snapLines([line('TICKETZ OUT NOW')], buildSnapVocabulary(''));
    expect(lines[0].text).toBe('TICKETS OUT NOW');
  });

  it('never touches true words, numbers, or short tokens', () => {
    const input = [line('ONE NIGHT ONLY'), line('DEC 20 2026'), line('CALL 727-623-8398')];
    const { lines, corrections } = snapLines(input, buildSnapVocabulary('Rutenberg Realty'));
    expect(lines.map((l) => l.text)).toEqual(['ONE NIGHT ONLY', 'DEC 20 2026', 'CALL 727-623-8398']);
    expect(corrections).toHaveLength(0);
  });

  it('a two-letter interior difference is a different word, never a repair (LIGHTING stays)', () => {
    const { lines, corrections } = snapLines([line('SOUND LIGHTING STAGE TRUSS')], buildSnapVocabulary(''));
    expect(lines[0].text).toBe('SOUND LIGHTING STAGE TRUSS');
    expect(corrections).toHaveLength(0);
  });

  it('an ambiguous repair is left alone (two vocab words equally near)', () => {
    // "HALLS" is distance 1 from HALL — fine; "CALLS" vs CALL is also 1 —
    // use a token equidistant to two vocab words: 'BOCK' is near BOOK only.
    // 'MALL' vs HALL/CALL? MALL is not vocab; dist to HALL=1, CALL=2 → snaps HALL? 'MALL' length 4 snaps allowed.
    const { lines } = snapLines([line('THE GRAND BALL')], buildSnapVocabulary(''));
    // BALL is distance 1 from CALL and HALL? B->C and B->H both 1, rest equal → tie → untouched.
    expect(lines[0].text).toBe('THE GRAND BALL');
  });
});
