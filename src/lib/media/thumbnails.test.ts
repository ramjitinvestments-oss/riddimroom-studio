/**
 * R44 Phase D (PL-2) — filmstrip sampling times. The video-element
 * sampling itself is browser-only and failure-null by design (same
 * contract as getAssetPoster); the pinned part is WHICH frames a strip
 * samples: the centre of each even slice of the asset's duration.
 */
import { describe, expect, it } from 'vitest';
import { filmstripFrameTimes, FILMSTRIP_FRAME_COUNT } from './thumbnails';

describe('filmstripFrameTimes', () => {
  it('samples the centre of each even slice', () => {
    expect(filmstripFrameTimes(12, 6)).toEqual([1, 3, 5, 7, 9, 11]);
    expect(filmstripFrameTimes(10, 4)).toEqual([1.25, 3.75, 6.25, 8.75]);
  });

  it('defaults to the strip frame count', () => {
    expect(filmstripFrameTimes(60).length).toBe(FILMSTRIP_FRAME_COUNT);
  });

  it('never samples at or past the ends, and rejects invalid durations', () => {
    const times = filmstripFrameTimes(7, 6);
    expect(Math.min(...times)).toBeGreaterThan(0);
    expect(Math.max(...times)).toBeLessThan(7);
    expect(filmstripFrameTimes(0)).toEqual([]);
    expect(filmstripFrameTimes(-5)).toEqual([]);
    expect(filmstripFrameTimes(Number.NaN)).toEqual([]);
    expect(filmstripFrameTimes(10, 0)).toEqual([]);
  });
});
