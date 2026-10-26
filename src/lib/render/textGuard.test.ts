import { describe, it, expect } from 'vitest';
import { boxesOverlap, claimTextBox, estimateTextBox, type TextBox } from './textGuard';

const W = 1080;
const H = 1920;

describe('R22 text occupancy guard', () => {
  it('boxesOverlap respects padding', () => {
    const a: TextBox = { x: 0, y: 0, w: 100, h: 50 };
    const touching: TextBox = { x: 0, y: 54, w: 100, h: 50 };
    expect(boxesOverlap(a, touching)).toBe(false);
    expect(boxesOverlap(a, touching, 6)).toBe(true);
    expect(boxesOverlap(a, { x: 10, y: 10, w: 50, h: 20 })).toBe(true);
  });

  it('a free box is claimed exactly as authored', () => {
    const claimed: TextBox[] = [];
    const res = claimTextBox(claimed, { x: 100, y: 100, w: 400, h: 80 }, W, H);
    expect(res.box).toEqual({ x: 100, y: 100, w: 400, h: 80 });
    expect(res.shiftedByPx).toBe(0);
    expect(claimed).toHaveLength(1);
  });

  it('a colliding box is shifted clear, never overlapping', () => {
    const claimed: TextBox[] = [{ x: 100, y: 900, w: 880, h: 120 }];
    const res = claimTextBox(claimed, { x: 140, y: 950, w: 800, h: 120 }, W, H);
    expect(res.box).not.toBeNull();
    expect(boxesOverlap(res.box!, claimed[0], 6)).toBe(false);
    expect(res.shiftedByPx).not.toBe(0);
  });

  it('a frame with no room left refuses the box instead of overlapping', () => {
    const claimed: TextBox[] = [{ x: 0, y: 0, w: W, h: H }];
    const res = claimTextBox(claimed, { x: 100, y: 100, w: 400, h: 80 }, W, H);
    expect(res.box).toBeNull();
  });

  it('estimateTextBox is centered and conservative', () => {
    const box = estimateTextBox('HELLO', 100, 540, 960);
    expect(box.x + box.w / 2).toBeCloseTo(540, 6);
    expect(box.y + box.h / 2).toBeCloseTo(960, 6);
    expect(box.w).toBeGreaterThan(5 * 100 * 0.58); // wider than the true average advance
    expect(box.h).toBeCloseTo(118, 6);
  });
});
