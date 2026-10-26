/**
 * RiddimRoom Studio — R26 song-part model + fitted-music fades.
 *
 * One pure model behind BOTH song-part surfaces (the Promo builder's
 * music start and the editor Music panel's trim window) and behind
 * the R26 fade rule, so the two surfaces can never drift apart:
 *
 * - The semantic value everywhere is "start seconds into the source
 *   track". Promo stores it as its `musicStart` state (null = auto:
 *   the detected hook); the editor stores it as the audio item's
 *   `trimStart`, with `trimEnd` shifted by the same amount so the
 *   window length never changes. `editorWindowForStart` and
 *   `promoStartForWindow` are the two adapters and are unit-tested to
 *   agree exactly.
 * - Fades (WS-A1): every fitted Promo music item gets fade-in 0s and
 *   fade-out 2s at the fitted end, clamped to
 *   `min(MAX_FADE_SECONDS, fitted length)` — `fittedPromoFade` is the
 *   ONE place that rule lives, and `clampFadeSeconds` is the ONE
 *   clamp the sliders (Promo results + editor) share.
 *
 * The module is import-safe outside the browser: the WebAudio peaks
 * decode is guarded and simply resolves null where no AudioContext
 * exists (tests exercise the math and the cache with synthetic peaks).
 */
import { MAX_FADE_SECONDS } from './constants';
import { clampWindowStart, maxWindowStart } from '../timeline/trimWindow';

export { clampWindowStart, maxWindowStart };

/** R26 default fade-out for fitted Promo music, in seconds. */
export const PROMO_FADE_OUT_SECONDS = 2;

/** R26 default fade-in for fitted Promo music, in seconds. */
export const PROMO_FADE_IN_SECONDS = 0;

/**
 * The ONE fade clamp: a fade may never be negative, never exceed
 * MAX_FADE_SECONDS (3s), and never exceed the item's fitted length
 * (a 1.2s clip gets at most a 1.2s fade). Non-finite input becomes 0.
 */
export function clampFadeSeconds(value: number, fittedLengthSeconds: number): number {
  if (!Number.isFinite(value)) return 0;
  const cap = Math.max(0, Math.min(MAX_FADE_SECONDS, Number.isFinite(fittedLengthSeconds) ? fittedLengthSeconds : 0));
  return Math.min(Math.max(0, value), cap);
}

/**
 * The R26 fitted-music fade defaults, defined ONCE: fade-in 0s,
 * fade-out 2s at the fitted end, both clamped to the fitted length
 * and the 3s cap. Returns the exact `fade` object an
 * AudioTimelineItem carries.
 */
export function fittedPromoFade(fittedLengthSeconds: number): { fadeInDuration: number; fadeOutDuration: number } {
  return {
    fadeInDuration: clampFadeSeconds(PROMO_FADE_IN_SECONDS, fittedLengthSeconds),
    fadeOutDuration: clampFadeSeconds(PROMO_FADE_OUT_SECONDS, fittedLengthSeconds),
  };
}

// ---------------------------------------------------------------------------
// Window math — "which part of the song" as pure seconds/px conversions
// ---------------------------------------------------------------------------

/** Seconds at a horizontal pixel offset inside a strip `widthPx` wide representing `durationSeconds`. */
export function pxToSeconds(px: number, widthPx: number, durationSeconds: number): number {
  if (!Number.isFinite(px) || !Number.isFinite(widthPx) || widthPx <= 0) return 0;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.min(Math.max(0, px / widthPx), 1) * durationSeconds;
}

/** Horizontal pixel offset of a time inside a strip `widthPx` wide representing `durationSeconds`. */
export function secondsToPx(seconds: number, widthPx: number, durationSeconds: number): number {
  if (!Number.isFinite(seconds) || !Number.isFinite(widthPx) || widthPx <= 0) return 0;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return (Math.min(Math.max(0, seconds), durationSeconds) / durationSeconds) * widthPx;
}

/** "0:42" readout for a start time. Negative/non-finite reads as 0:00. */
export function formatStartTime(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * The effective start when a surface is in "auto" mode: the user's
 * explicit start wins; a null start means the detected hook. This is
 * the hook-default semantic Promo has always had (`musicStart ??
 * hook`) — the picker displays this value until the user drags.
 */
export function effectiveStart(explicitStart: number | null, hookSeconds: number): number {
  if (explicitStart !== null && Number.isFinite(explicitStart)) return Math.max(0, explicitStart);
  return Number.isFinite(hookSeconds) ? Math.max(0, hookSeconds) : 0;
}

// ---------------------------------------------------------------------------
// Surface adapters — both write the SAME semantic value (start seconds
// into the source), each in its own surface's storage shape.
// ---------------------------------------------------------------------------

/**
 * Promo adapter: a dragged window start becomes the value stored in
 * Promo's `musicStart` state — plain start seconds, clamped so the
 * window of `windowSeconds` stays inside the track.
 */
export function promoStartForWindow(startSeconds: number, windowSeconds: number, trackDurationSeconds: number): number {
  return clampWindowStart(startSeconds, windowSeconds, trackDurationSeconds);
}

/**
 * Editor adapter: a dragged window start becomes the audio item's new
 * trim window — `trimStart` = the same clamped start the Promo
 * adapter produces, `trimEnd` shifted with it so the window length
 * (the field preview + export consume via the trim window) is
 * preserved exactly.
 */
export function editorWindowForStart(
  item: { trimStart: number; trimEnd: number },
  startSeconds: number,
  sourceDurationSeconds: number,
): { trimStart: number; trimEnd: number } {
  const length = Math.max(0, item.trimEnd - item.trimStart);
  const trimStart = clampWindowStart(startSeconds, length, sourceDurationSeconds);
  return { trimStart, trimEnd: trimStart + length };
}

// ---------------------------------------------------------------------------
// Waveform peaks — computed once per asset, cached, shared by surfaces
// ---------------------------------------------------------------------------

/** Normalised waveform peaks: one 0..1 max-abs value per bucket, plus the track duration they span. */
export interface SongPeaks {
  durationSeconds: number;
  peaks: number[];
}

/** Default number of waveform buckets rendered by the picker. */
export const PEAK_BUCKET_COUNT = 240;

/**
 * Pure peak extraction from decoded samples: max-abs per bucket,
 * normalised so the loudest bucket is 1. Unit-tested with synthetic
 * samples — no audio decode involved.
 */
export function peaksFromSamples(samples: ArrayLike<number>, sampleRate: number, bucketCount = PEAK_BUCKET_COUNT): SongPeaks {
  const durationSeconds = sampleRate > 0 ? samples.length / sampleRate : 0;
  const buckets = Math.max(1, Math.floor(bucketCount) || 1);
  const peaks = new Array<number>(buckets).fill(0);
  if (samples.length > 0) {
    const perBucket = samples.length / buckets;
    let max = 0;
    for (let b = 0; b < buckets; b++) {
      const from = Math.floor(b * perBucket);
      const to = Math.min(samples.length, Math.max(from + 1, Math.floor((b + 1) * perBucket)));
      let peak = 0;
      for (let i = from; i < to; i++) {
        const v = Math.abs(samples[i]);
        if (v > peak) peak = v;
      }
      peaks[b] = peak;
      if (peak > max) max = peak;
    }
    if (max > 0) {
      for (let b = 0; b < buckets; b++) peaks[b] = peaks[b] / max;
    }
  }
  return { durationSeconds, peaks };
}

/**
 * Per-asset peaks cache, keyed by asset id or content hash (the
 * caller picks the key — Promo passes the track file's identity, the
 * editor passes the media asset id). In-flight decodes are shared:
 * asking twice for the same key returns the same promise/result.
 */
const peaksCache = new Map<string, SongPeaks>();
const peaksInFlight = new Map<string, Promise<SongPeaks | null>>();

export function getCachedPeaks(key: string): SongPeaks | null {
  return peaksCache.get(key) ?? null;
}

export function setCachedPeaks(key: string, peaks: SongPeaks): void {
  peaksCache.set(key, peaks);
}

export function clearPeaksCache(): void {
  peaksCache.clear();
  peaksInFlight.clear();
}

/** Cache key for a source when the caller does not supply one. */
export function peaksKeyFor(source: File | string, key?: string): string {
  if (key) return key;
  return typeof source === 'string' ? `url:${source}` : `file:${source.name}:${source.size}`;
}

/**
 * Decode a track (File or URL) to waveform peaks via WebAudio,
 * cached per asset. Resolves null — never throws — when decoding is
 * impossible (non-browser/test environment, unreadable file), so
 * callers can fall back to a flat placeholder strip.
 */
export function computePeaks(source: File | string, key?: string): Promise<SongPeaks | null> {
  const cacheKey = peaksKeyFor(source, key);
  const cached = peaksCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);
  const inFlight = peaksInFlight.get(cacheKey);
  if (inFlight) return inFlight;
  const pending = (async (): Promise<SongPeaks | null> => {
    try {
      if (typeof window === 'undefined') return null;
      const Ctor =
        (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext ??
        (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
      if (!Ctor) return null;
      const buffer = typeof source === 'string' ? await (await fetch(source)).arrayBuffer() : await source.arrayBuffer();
      const ctx = new Ctor(1, 1, 44100);
      const audio = await ctx.decodeAudioData(buffer);
      if (audio.numberOfChannels === 0 || audio.length === 0) return null;
      const peaks = peaksFromSamples(audio.getChannelData(0), audio.sampleRate);
      peaksCache.set(cacheKey, peaks);
      return peaks;
    } catch {
      return null;
    } finally {
      peaksInFlight.delete(cacheKey);
    }
  })();
  peaksInFlight.set(cacheKey, pending);
  return pending;
}
