import { describe, it, expect } from 'vitest';
import { isThinRead, paddleResultsToLines } from './paddleEngine';
import type { OcrLine } from './readout';

const line = (confidence: number): OcrLine => ({ text: 'X', confidence, y: 0 });

describe('isThinRead (R20 rescue trigger)', () => {
  it('fewer than four lines is thin', () => {
    expect(isThinRead([line(95), line(95), line(95)])).toBe(true);
    expect(isThinRead([])).toBe(true);
  });
  it('a confident multi-line read is not thin', () => {
    expect(isThinRead([line(90), line(88), line(92), line(85), line(80)])).toBe(false);
  });
  it('many lines at low mean confidence is thin', () => {
    expect(isThinRead([line(40), line(50), line(45), line(60), line(52)])).toBe(true);
  });
});

describe('paddleResultsToLines (R20)', () => {
  it('maps px boxes to fractions and confidence to percent', () => {
    const out = paddleResultsToLines(
      [{ text: ' GOD SAVED YOUR MIND ', confidence: 0.93, box: { x: 200, y: 100, width: 600, height: 50 } }],
      1000,
      500,
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('GOD SAVED YOUR MIND');
    expect(out[0].confidence).toBe(93);
    expect(out[0].box).toEqual({ x: 0.2, y: 0.2, w: 0.6, h: 0.1 });
    expect(out[0].y).toBe(0.2);
  });
  it('drops empty text and degenerate geometry', () => {
    expect(paddleResultsToLines([{ text: '  ', confidence: 0.9, box: { x: 0, y: 0, width: 5, height: 5 } }], 100, 100)).toHaveLength(0);
    expect(paddleResultsToLines([{ text: 'A', confidence: 0.9, box: { x: 0, y: 0, width: 5, height: 5 } }], 0, 100)).toHaveLength(0);
  });
});
