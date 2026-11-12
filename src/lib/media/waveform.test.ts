/**
 * R44 Phase D (PL-3) — waveform peaks: the pure reduction + slicing.
 * The decode itself (fetch + decodeAudioData) is browser-only and
 * failure-null by design; what's pinned here is the math the timeline
 * draws from.
 */
import { describe, expect, it } from 'vitest';
import { computePeaks, waveformBarHeights, WAVEFORM_PEAK_COUNT } from './waveform';

/** Float32 storage makes exact decimal equality the wrong assertion. */
function expectCloseArray(actual: ArrayLike<number>, expected: number[]) {
  expect(actual.length).toBe(expected.length);
  expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 6));
}

describe('computePeaks', () => {
  it('takes the max absolute sample per bucket', () => {
    const data = new Float32Array([0.1, -0.5, 0.2, 0.9, -0.3, 0.4, 0.05, -0.05]);
    const peaks = computePeaks([data], 4);
    expectCloseArray(peaks, [0.5, 0.9, 0.4, 0.05]);
  });

  it('takes the max across channels', () => {
    const left = new Float32Array([0.1, 0.1, 0.1, 0.1]);
    const right = new Float32Array([0.2, -0.8, 0.3, 0.05]);
    const peaks = computePeaks([left, right], 2);
    expect(peaks[0]).toBeCloseTo(0.8, 6);
    expect(peaks[1]).toBeCloseTo(0.3, 6);
  });

  it('handles more buckets than samples and empty input without NaN', () => {
    const peaks = computePeaks([new Float32Array([0.25])], 4);
    expect(peaks.length).toBe(4);
    expect(Array.from(peaks).every((v) => Number.isFinite(v))).toBe(true);
    expect(Math.max(...peaks)).toBeCloseTo(0.25, 6);
    expect(Array.from(computePeaks([], 8))).toEqual(new Array(8).fill(0));
    expect(computePeaks([new Float32Array([1])], 0).length).toBe(0);
  });

  it('produces the fixed bucket count the cache contract promises', () => {
    const data = new Float32Array(44100).fill(0.5);
    expect(computePeaks([data], WAVEFORM_PEAK_COUNT).length).toBe(WAVEFORM_PEAK_COUNT);
  });
});

describe('waveformBarHeights', () => {
  const peaks = new Float32Array([0, 0.2, 0.4, 0.6, 0.8, 1, 0.5, 0.25]);

  it('slices the requested window: the full range reads every peak', () => {
    expectCloseArray(waveformBarHeights(peaks, 0, 1, 8), [0, 0.2, 0.4, 0.6, 0.8, 1, 0.5, 0.25]);
  });

  it('a trim window reads only its slice, resampled to the column count', () => {
    // Window = second half (peaks 4..7), 2 columns → max of each half.
    expectCloseArray(waveformBarHeights(peaks, 0.5, 1, 2), [1, 0.5]);
    // Window = first quarter (peaks 0..1), 2 columns.
    expectCloseArray(waveformBarHeights(peaks, 0, 0.25, 2), [0, 0.2]);
  });

  it('clamps out-of-range fractions and guards degenerate inputs', () => {
    expect(waveformBarHeights(peaks, -1, 2, 4).length).toBe(4);
    expect(waveformBarHeights(peaks, 0, 1, 0)).toEqual([]);
    expect(waveformBarHeights(new Float32Array(0), 0, 1, 4)).toEqual([]);
  });
});
