import { describe, it, expect, beforeEach } from 'vitest';
import {
  PROMO_FADE_IN_SECONDS,
  PROMO_FADE_OUT_SECONDS,
  clampFadeSeconds,
  clampWindowStart,
  clearPeaksCache,
  computePeaks,
  editorWindowForStart,
  effectiveStart,
  fittedPromoFade,
  formatStartTime,
  getCachedPeaks,
  maxWindowStart,
  peaksFromSamples,
  promoStartForWindow,
  pxToSeconds,
  secondsToPx,
  setCachedPeaks,
} from './songPart';
import { MAX_FADE_SECONDS } from './constants';

describe('R26 fitted Promo music fades (WS-A1)', () => {
  it('defaults: fade-in 0s, fade-out 2s at the fitted end', () => {
    expect(PROMO_FADE_IN_SECONDS).toBe(0);
    expect(PROMO_FADE_OUT_SECONDS).toBe(2);
    expect(fittedPromoFade(12)).toEqual({ fadeInDuration: 0, fadeOutDuration: 2 });
  });

  it('fade-out never exceeds the 3s cap', () => {
    expect(MAX_FADE_SECONDS).toBe(3);
    expect(clampFadeSeconds(10, 60)).toBe(3);
    expect(fittedPromoFade(600).fadeOutDuration).toBeLessThanOrEqual(MAX_FADE_SECONDS);
  });

  it('fades clamp to the fitted length — a 1.2s clip gets at most a 1.2s fade-out', () => {
    expect(fittedPromoFade(1.2)).toEqual({ fadeInDuration: 0, fadeOutDuration: 1.2 });
    expect(clampFadeSeconds(2, 1.2)).toBe(1.2);
    expect(clampFadeSeconds(0.5, 1.2)).toBe(0.5);
  });

  it('degenerate lengths and values floor at 0', () => {
    expect(fittedPromoFade(0)).toEqual({ fadeInDuration: 0, fadeOutDuration: 0 });
    expect(clampFadeSeconds(-1, 12)).toBe(0);
    expect(clampFadeSeconds(Number.NaN, 12)).toBe(0);
  });
});

describe('song-part window math (WS-A3)', () => {
  it('clamps the window inside the track', () => {
    expect(maxWindowStart(12, 180)).toBe(168);
    expect(clampWindowStart(42, 12, 180)).toBe(42);
    expect(clampWindowStart(175, 12, 180)).toBe(168);
    expect(clampWindowStart(-5, 12, 180)).toBe(0);
    // Window at least as long as the track is pinned to 0.
    expect(clampWindowStart(30, 200, 180)).toBe(0);
  });

  it('px <-> seconds conversions round-trip and clamp to the strip', () => {
    expect(pxToSeconds(250, 1000, 180)).toBe(45);
    expect(secondsToPx(45, 1000, 180)).toBe(250);
    expect(secondsToPx(pxToSeconds(333, 777, 95), 777, 95)).toBeCloseTo(333, 6);
    expect(pxToSeconds(-10, 1000, 180)).toBe(0);
    expect(pxToSeconds(5000, 1000, 180)).toBe(180);
    expect(pxToSeconds(10, 0, 180)).toBe(0);
  });

  it('formats the start readout as m:ss', () => {
    expect(formatStartTime(0)).toBe('0:00');
    expect(formatStartTime(42)).toBe('0:42');
    expect(formatStartTime(75)).toBe('1:15');
    expect(formatStartTime(600)).toBe('10:00');
  });
});

describe('surface adapters write the same semantic value', () => {
  it('Promo musicStart and editor trimStart agree on the dragged start', () => {
    const item = { trimStart: 0, trimEnd: 12 };
    const promoStart = promoStartForWindow(42, 12, 180);
    const editorWindow = editorWindowForStart(item, 42, 180);
    expect(promoStart).toBe(42);
    expect(editorWindow.trimStart).toBe(promoStart);
    // The window length preview + export consume never changes.
    expect(editorWindow.trimEnd - editorWindow.trimStart).toBe(12);
  });

  it('both adapters clamp identically at the track end', () => {
    const item = { trimStart: 100, trimEnd: 112 };
    expect(promoStartForWindow(175, 12, 180)).toBe(168);
    expect(editorWindowForStart(item, 175, 180)).toEqual({ trimStart: 168, trimEnd: 180 });
  });

  it('re-dragging from a shifted editor window keeps its length', () => {
    const item = { trimStart: 42, trimEnd: 54 };
    expect(editorWindowForStart(item, 10, 180)).toEqual({ trimStart: 10, trimEnd: 22 });
  });
});

describe('hook default (auto) stays intact', () => {
  it('no drag -> the effective start IS the hook', () => {
    expect(effectiveStart(null, 42)).toBe(42);
    expect(effectiveStart(null, 0)).toBe(0);
  });

  it('an explicit drag wins over the hook', () => {
    expect(effectiveStart(10, 42)).toBe(10);
    expect(effectiveStart(0, 42)).toBe(0);
  });
});

describe('peaks: synthetic extraction + per-asset cache', () => {
  beforeEach(() => clearPeaksCache());

  it('peaksFromSamples normalises bucket max-abs to 1 and reports duration', () => {
    const sampleRate = 100;
    const samples = new Float32Array(1000).fill(0);
    samples[550] = 0.5; // lands in bucket 5 of 10
    const { durationSeconds, peaks } = peaksFromSamples(samples, sampleRate, 10);
    expect(durationSeconds).toBe(10);
    expect(peaks).toHaveLength(10);
    expect(peaks[5]).toBe(1); // loudest bucket normalises to 1
    expect(peaks[0]).toBe(0); // silence stays 0
  });

  it('the cache stores and returns peaks per asset key', () => {
    const peaks = { durationSeconds: 30, peaks: [0.1, 0.9] };
    setCachedPeaks('asset-1', peaks);
    expect(getCachedPeaks('asset-1')).toBe(peaks);
    expect(getCachedPeaks('asset-2')).toBeNull();
  });

  it('computePeaks serves a seeded cache entry without decoding', async () => {
    const peaks = { durationSeconds: 30, peaks: [0.2, 0.4] };
    setCachedPeaks('asset-9', peaks);
    await expect(computePeaks('https://example.invalid/track.mp3', 'asset-9')).resolves.toBe(peaks);
  });

  it('computePeaks resolves null (never throws) outside a browser env', async () => {
    await expect(computePeaks('https://example.invalid/track.mp3', 'asset-uncached')).resolves.toBeNull();
  });
});
