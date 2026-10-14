import { describe, it, expect } from 'vitest';
import { computeFadeOpacity, interpolateTransform } from './compositor';
import type { Transform } from '../../types/timeline';

/**
 * "Universal 30-second media standard" focused tests — spec item 9 ("Add
 * focused tests for: fade clamping"). `computeFadeOpacity` is the single
 * shared function driving both visual opacity fades (video/image/text) AND
 * audio gain fades (standalone AudioTimelineItem, and — after this same
 * pass's fix — a video's own embedded audio in both PreviewPane.tsx and
 * canvas2dRenderer.ts), so these tests exercise the pure math once rather
 * than duplicating it per call site. `sinceStart + untilEnd` always equals
 * the item's own duration in real call sites (see the function's own doc
 * comment for why), so tests below construct that relationship explicitly.
 */

describe('computeFadeOpacity — clamped to min(3s, clip duration)', () => {
  it('returns full opacity when no fade is configured', () => {
    expect(computeFadeOpacity(undefined, 5, 5)).toBe(1);
  });

  it('ramps in normally when the configured fade is within both caps', () => {
    // 10s clip, 1s in, 2s fade-in configured -> half-way through the ramp.
    const opacity = computeFadeOpacity({ fadeInDuration: 2, fadeOutDuration: 0 }, 1, 9);
    expect(opacity).toBeCloseTo(0.5, 5);
  });

  it('reaches full opacity by the END of a short clip even if the configured fade-in is longer than the clip (the original bug)', () => {
    // 2s clip, fade-in configured at 5s (exceeds both MAX_FADE_SECONDS=3 and
    // the clip's own 2s length). Before this fix, an unclamped ramp would
    // give sinceStart/fadeInDuration = 2/5 = 0.4 at the very end of the clip
    // — i.e. the clip would NEVER reach full volume/opacity, even briefly.
    const opacity = computeFadeOpacity({ fadeInDuration: 5, fadeOutDuration: 0 }, 2, 0);
    expect(opacity).toBeCloseTo(1, 5);
  });

  it('clamps the effective fade duration to MAX_FADE_SECONDS (3s) even on a long clip', () => {
    // 20s clip, fade-in configured at 10s. Effective cap is min(10, 3, 20) = 3s,
    // so by sinceStart=3 the ramp should already be complete (opacity 1),
    // not 3/10 = 0.3 as an unclamped 10s ramp would give.
    const opacity = computeFadeOpacity({ fadeInDuration: 10, fadeOutDuration: 0 }, 3, 17);
    expect(opacity).toBeCloseTo(1, 5);
  });

  it('applies the fade-OUT ramp with the same clamping, symmetrically', () => {
    // 20s clip, 1s from the end, fade-out configured at 10s.
    // Effective cap is min(10, 3, 20) = 3s, so opacity should be 1/3, not 1/10.
    const opacity = computeFadeOpacity({ fadeInDuration: 0, fadeOutDuration: 10 }, 19, 1);
    expect(opacity).toBeCloseTo(1 / 3, 5);
  });

  it('never returns a negative or >1 opacity for pathological (e.g. negative) fade values', () => {
    const opacity = computeFadeOpacity({ fadeInDuration: -5, fadeOutDuration: -5 }, 1, 1);
    expect(opacity).toBeGreaterThanOrEqual(0);
    expect(opacity).toBeLessThanOrEqual(1);
  });
});

describe('interpolateTransform — keyframe-lite (Phase 2.3)', () => {
  const base: Transform = { position: { x: 20, y: 30 }, scale: 1, rotation: 15, opacity: 1 };

  it('returns the base transform itself when no end transform is set', () => {
    expect(interpolateTransform(base, undefined, 0.5)).toBe(base);
  });

  it('hits the base at progress 0 and the end state at progress 1', () => {
    const end = { position: { x: 80, y: 70 }, scale: 2, opacity: 0.4 };
    const atStart = interpolateTransform(base, end, 0);
    expect(atStart.position).toEqual({ x: 20, y: 30 });
    expect(atStart.scale).toBe(1);
    expect(atStart.opacity).toBe(1);
    const atEnd = interpolateTransform(base, end, 1);
    expect(atEnd.position).toEqual({ x: 80, y: 70 });
    expect(atEnd.scale).toBe(2);
    expect(atEnd.opacity).toBeCloseTo(0.4, 5);
  });

  it('lerps linearly at the midpoint and holds base rotation throughout', () => {
    const end = { position: { x: 80, y: 70 }, scale: 2, opacity: 0.4 };
    const mid = interpolateTransform(base, end, 0.5);
    expect(mid.position).toEqual({ x: 50, y: 50 });
    expect(mid.scale).toBeCloseTo(1.5, 5);
    expect(mid.opacity).toBeCloseTo(0.7, 5);
    expect(mid.rotation).toBe(15);
  });

  it('eased mode is smoothstep: slower than linear early, and clamps out-of-range progress', () => {
    const end = { position: { x: 80, y: 70 }, scale: 2, opacity: 0.4, eased: true };
    const quarter = interpolateTransform(base, end, 0.25);
    // smoothstep(0.25) = 0.15625 < 0.25
    expect(quarter.position.x).toBeCloseTo(20 + 60 * 0.15625, 5);
    expect(interpolateTransform(base, end, 2).position).toEqual({ x: 80, y: 70 });
    expect(interpolateTransform(base, end, -1).position).toEqual({ x: 20, y: 30 });
  });
});
