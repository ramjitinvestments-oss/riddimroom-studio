import { describe, it, expect } from 'vitest';
import { bump, cineInOut, cineOut, returnBlend, smootherstep } from './easing';

describe('R22 easing library', () => {
  it('smootherstep pins its ends and has ~zero velocity at both', () => {
    expect(smootherstep(0)).toBe(0);
    expect(smootherstep(1)).toBe(1);
    expect(smootherstep(0.5)).toBeCloseTo(0.5, 6);
    const eps = 0.001;
    const vStart = (smootherstep(eps) - smootherstep(0)) / eps;
    const vEnd = (smootherstep(1) - smootherstep(1 - eps)) / eps;
    expect(Math.abs(vStart)).toBeLessThan(0.01);
    expect(Math.abs(vEnd)).toBeLessThan(0.01);
  });

  it('cine curves pin their ends and stay monotonic', () => {
    for (const f of [cineInOut, cineOut]) {
      expect(f(0)).toBe(0);
      expect(f(1)).toBe(1);
      let prev = -1;
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const v = f(Math.min(1, t));
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
    // ease-in-out symmetry: slow start, slow end, fast middle
    expect(cineInOut(0.25)).toBeLessThan(0.25);
    expect(cineInOut(0.75)).toBeGreaterThan(0.75);
  });

  it('bump leaves home and comes home', () => {
    expect(bump(0)).toBe(0);
    expect(bump(1)).toBe(0);
    expect(bump(0.5)).toBeCloseTo(1, 6);
  });

  it('returnBlend is 0 before the return stretch and 1 at the end', () => {
    expect(returnBlend(0.5)).toBe(0);
    expect(returnBlend(0.8)).toBe(0);
    expect(returnBlend(1)).toBe(1);
    expect(returnBlend(0.9)).toBeGreaterThan(0);
    expect(returnBlend(0.9)).toBeLessThan(1);
  });
});
