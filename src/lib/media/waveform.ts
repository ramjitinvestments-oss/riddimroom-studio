/**
 * R44 Phase D (PL-3) — audio waveforms for timeline audio clips.
 *
 * Audio clips used to render as a flat colour block with a filename —
 * no shape at all (AUDIT-R43 §2.2). This module decodes each audio
 * asset ONCE (Web Audio `decodeAudioData`), reduces it to a fixed
 * number of peak buckets, and session-caches the result per asset id;
 * TimelinePanel draws the trim window's slice of the peaks on a small
 * canvas. Every failure path resolves `null` and the clip keeps its
 * flat rendering — the graceful silence state. The idle/import CPU
 * spend is the CapCut pattern the owner accepted for this phase.
 */

import type { MediaAsset } from '../../types/timeline';

/** Peak buckets per asset — enough resolution to draw at any timeline zoom. */
export const WAVEFORM_PEAK_COUNT = 1024;
/** Decode ceiling: past 30 minutes the decode memory isn't worth timeline dressing. */
export const MAX_WAVEFORM_SECONDS = 1800;

/**
 * Reduce channel data to `bucketCount` peak values (max absolute sample
 * per bucket, max across channels). Pure — the testable heart of the
 * module. Empty input or a non-positive bucket count yields zeros.
 */
export function computePeaks(channels: ArrayLike<number>[], bucketCount: number): Float32Array {
  const peaks = new Float32Array(Math.max(0, bucketCount));
  if (bucketCount <= 0) return peaks;
  let length = 0;
  for (const ch of channels) length = Math.max(length, ch.length);
  if (length === 0) return peaks;
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = Math.floor((bucket / bucketCount) * length);
    const end = Math.max(start + 1, Math.floor(((bucket + 1) / bucketCount) * length));
    let max = 0;
    for (const ch of channels) {
      const stop = Math.min(end, ch.length);
      for (let i = start; i < stop; i++) {
        const v = Math.abs(ch[i]);
        if (v > max) max = v;
      }
    }
    peaks[bucket] = max;
  }
  return peaks;
}

/**
 * Bar heights (0..1) for drawing `columns` bars across the
 * [startFrac, endFrac) slice of a peaks array — the trim window's
 * slice, so zooming/trimming redraws from the same cached peaks.
 */
export function waveformBarHeights(peaks: ArrayLike<number>, startFrac: number, endFrac: number, columns: number): number[] {
  const heights: number[] = [];
  if (columns <= 0 || peaks.length === 0) return heights;
  const start = Math.max(0, Math.min(1, startFrac));
  const end = Math.max(start, Math.min(1, endFrac));
  for (let col = 0; col < columns; col++) {
    const from = Math.floor((start + (col / columns) * (end - start)) * peaks.length);
    const to = Math.max(from + 1, Math.floor((start + ((col + 1) / columns) * (end - start)) * peaks.length));
    let max = 0;
    for (let i = from; i < Math.min(to, peaks.length); i++) {
      if (peaks[i] > max) max = peaks[i];
    }
    heights.push(max);
  }
  return heights;
}

const waveformCache = new Map<string, Float32Array | null>();
const inflightWaveforms = new Map<string, Promise<Float32Array | null>>();

async function decodeAssetPeaks(asset: MediaAsset): Promise<Float32Array | null> {
  const Ctor: typeof AudioContext | undefined =
    typeof window !== 'undefined' ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext : undefined;
  if (!Ctor) return null;
  const response = await fetch(asset.storageUrl);
  if (!response.ok) return null;
  const bytes = await response.arrayBuffer();
  const ctx = new Ctor();
  try {
    const buffer = await ctx.decodeAudioData(bytes);
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) channels.push(buffer.getChannelData(ch));
    return computePeaks(channels, WAVEFORM_PEAK_COUNT);
  } finally {
    void ctx.close().catch(() => {});
  }
}

/**
 * Peaks for an audio asset, or null (non-audio asset, over the duration
 * ceiling, or any fetch/decode failure). Session-cached per asset id;
 * concurrent calls share one decode.
 */
export function getAssetWaveform(asset: MediaAsset): Promise<Float32Array | null> {
  if (asset.kind !== 'audio') return Promise.resolve(null);
  if (asset.durationSeconds !== undefined && asset.durationSeconds > MAX_WAVEFORM_SECONDS) {
    return Promise.resolve(null);
  }
  if (waveformCache.has(asset.id)) {
    return Promise.resolve(waveformCache.get(asset.id) ?? null);
  }
  const existing = inflightWaveforms.get(asset.id);
  if (existing) return existing;
  const promise = decodeAssetPeaks(asset)
    .catch(() => null)
    .then((peaks) => {
      waveformCache.set(asset.id, peaks);
      inflightWaveforms.delete(asset.id);
      return peaks;
    });
  inflightWaveforms.set(asset.id, promise);
  return promise;
}
