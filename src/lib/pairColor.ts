/**
 * RiddimRoom Studio — R32 Phase 4 "Match clips" colour matching.
 *
 * Samples one representative frame from each member of a pair,
 * computes the luma/warmth offsets between them, and turns those
 * into a CLAMPED colour-grade patch for the SECOND item, so the
 * second clip is pulled toward the main clip's look.
 *
 * GRADE MAPPING (the existing `ColorGradeSettings` shape has exactly
 * three fields — brightness / contrast / saturation, -100..100):
 * - Luma offset (main mean luma − second mean luma, 0..255 scale)
 *   maps to BRIGHTNESS, capped at ±12: delta = offset × 0.24, so a
 *   50-point luma gap reaches the cap and a typical 10–25 point gap
 *   lands at a visible-but-safe 2.4–6.
 * - Warmth offset (each sample's R−B, differenced main − second)
 *   has NO temperature field to land on — the grade model has none.
 *   It maps conservatively to SATURATION, capped at ±10: a warmer
 *   target nudges saturation up (warm scenes read more saturated),
 *   a cooler target pulls it down. This is an approximation and is
 *   documented as one; inventing a temperature field the renderer
 *   does not consume would be a dead control.
 * - CONTRAST is left exactly as the second item already has it — two
 *   frame MEANS say nothing honest about a clip's contrast.
 * The deltas apply ON TOP of the second item's existing grade (each
 * field then clamped to -100..100). Applying stores that prior grade
 * in the pair bookkeeping (`pair.preMatchGrade`, null = no grade);
 * turning Match off restores it exactly — the toggle is the
 * mechanism, not undo.
 *
 * The sampling helper follows the poster machinery's pattern
 * (`lib/media/thumbnails.ts`): a scratch element, CORS-clean attempt,
 * best-effort null on any failure. A video is sampled near 25% of
 * its duration; an image is itself. Pixels are averaged on a tiny
 * 16×16 canvas by the pure `averageFramePixels`, which the tests
 * exercise directly.
 */

import type { ColorGradeSettings, MediaAsset, Project } from '../types/timeline';
import { updateItem } from './timeline/utils';
import { getPairContext, type PairContext, type PairVisualItem } from './pairLayout';

/** Mean colour of one sampled frame (channels on the 0..255 scale). */
export interface FrameSample {
  meanLuma: number;
  meanR: number;
  meanG: number;
  meanB: number;
}

export const MATCH_MAX_BRIGHTNESS_DELTA = 12;
export const MATCH_MAX_SATURATION_DELTA = 10;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Rec. 709 luma of an RGB triple (0..255 scale in and out). */
export function lumaOf(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The clamped grade deltas that pull `second` toward `main`:
 * brightness from the luma offset, saturation from the warmth
 * offset (see header). Pure maths; the tests pin the mapping and
 * both caps.
 */
export function matchGradeDeltas(main: FrameSample, second: FrameSample): { brightness: number; saturation: number } {
  const lumaOffset = main.meanLuma - second.meanLuma;
  const warmthOffset = (main.meanR - main.meanB) - (second.meanR - second.meanB);
  return {
    brightness: clamp(lumaOffset * 0.24, -MATCH_MAX_BRIGHTNESS_DELTA, MATCH_MAX_BRIGHTNESS_DELTA),
    saturation: clamp(warmthOffset * 0.2, -MATCH_MAX_SATURATION_DELTA, MATCH_MAX_SATURATION_DELTA),
  };
}

/**
 * The full grade the second item gets when Match is applied: its
 * prior grade (absent = all-zero) plus the clamped deltas, each
 * field clamped to the grade model's -100..100 range. Contrast
 * passes through untouched.
 */
export function matchedGradeFor(
  prior: ColorGradeSettings | undefined,
  main: FrameSample,
  second: FrameSample,
): ColorGradeSettings {
  const deltas = matchGradeDeltas(main, second);
  const base = prior ?? { brightness: 0, contrast: 0, saturation: 0 };
  return {
    brightness: clamp(base.brightness + deltas.brightness, -100, 100),
    contrast: base.contrast,
    saturation: clamp(base.saturation + deltas.saturation, -100, 100),
  };
}

/** Average an RGBA pixel buffer into a FrameSample (alpha ignored). */
export function averageFramePixels(data: ArrayLike<number>): FrameSample {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i + 2 < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count += 1;
  }
  if (count === 0) return { meanLuma: 0, meanR: 0, meanG: 0, meanB: 0 };
  const meanR = r / count;
  const meanG = g / count;
  const meanB = b / count;
  return { meanLuma: lumaOf(meanR, meanG, meanB), meanR, meanG, meanB };
}

// ---------------------------------------------------------------------------
// Apply / restore (the toggle)
// ---------------------------------------------------------------------------

function withPairFlags(item: PairVisualItem, matchOn: boolean, preMatchGrade?: ColorGradeSettings | null): object {
  if (!item.pair) return {};
  const pair = { ...item.pair, matchOn };
  if (preMatchGrade !== undefined) pair.preMatchGrade = preMatchGrade;
  else if (!matchOn) delete pair.preMatchGrade;
  return { pair };
}

/**
 * Apply Match clips: the second item's grade becomes
 * `matchedGradeFor(its prior grade, samples)` and the prior grade is
 * stored in its pair bookkeeping for exact restore. No-op without
 * pair bookkeeping (the panel adopts a legacy pair first) or when
 * the second item cannot carry a grade.
 */
export function applyPairMatch(
  project: Project,
  context: PairContext,
  mainSample: FrameSample,
  secondSample: FrameSample,
): Project {
  const second = context.second;
  if (!second.pair) return project;
  const prior = second.colorGrade;
  const grade = matchedGradeFor(prior, mainSample, secondSample);
  let next = updateItem(project, second.id, {
    colorGrade: grade,
    ...withPairFlags(second, true, prior ?? null),
  });
  const main = next.items.find((i) => i.id === context.main.id);
  if (main && (main.type === 'video' || main.type === 'image') && main.pair) {
    next = updateItem(next, main.id, { pair: { ...main.pair, matchOn: true } });
  }
  return next;
}

/**
 * Turn Match clips off: the second item's grade is restored EXACTLY
 * from the bookkeeping (a stored null restores "no grade"), and the
 * stored prior is cleared. If roles were swapped while match was on,
 * the stored prior is honoured on whichever member carries it.
 */
export function removePairMatch(project: Project, context: PairContext): Project {
  let next = project;
  for (const member of [context.main, context.second]) {
    const current = next.items.find((i) => i.id === member.id);
    if (!current || (current.type !== 'video' && current.type !== 'image') || !current.pair) continue;
    const patch: Record<string, unknown> = {
      pair: { ...current.pair, matchOn: false, preMatchGrade: undefined },
    };
    if (current.pair.preMatchGrade !== undefined) {
      patch.colorGrade = current.pair.preMatchGrade ?? undefined;
    } else if (member.id === context.second.id && current.pair.matchOn) {
      // Match was on but no prior was stored (should not happen) —
      // the safest restore is the second item's pre-match state
      // being unknown, so leave its grade alone rather than guess.
    }
    next = updateItem(next, current.id, patch);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Frame sampling (browser, best-effort — follows the poster pattern)
// ---------------------------------------------------------------------------

const SAMPLE_SIZE = 16;
const SAMPLE_TIMEOUT_MS = 5000;

function sampleFromDrawable(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): FrameSample | null {
  if (!sourceWidth || !sourceHeight || typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    // Throws on a tainted canvas (non-CORS media) — caught below.
    const data = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
    return averageFramePixels(data);
  } catch {
    return null;
  }
}

function sampleImageAsset(asset: MediaAsset): Promise<FrameSample | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let settled = false;
    const finish = (value: FrameSample | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), SAMPLE_TIMEOUT_MS);
    img.onload = () => finish(sampleFromDrawable(img, img.naturalWidth, img.naturalHeight));
    img.onerror = () => finish(null);
    img.src = asset.storageUrl;
  });
}

function sampleVideoAsset(asset: MediaAsset): Promise<FrameSample | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.style.position = 'fixed';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    video.tabIndex = -1;
    document.body.appendChild(video);
    let settled = false;
    const finish = (value: FrameSample | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch {
        // Best-effort teardown only.
      }
      if (video.parentNode) video.parentNode.removeChild(video);
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), SAMPLE_TIMEOUT_MS);
    video.addEventListener('loadedmetadata', () => {
      const duration = video.duration;
      // Near 25% of the duration — representative, past any leader.
      const target = Number.isFinite(duration) && duration > 0 ? duration * 0.25 : 0.5;
      try {
        video.currentTime = target;
      } catch {
        finish(null);
      }
    });
    video.addEventListener('seeked', () => {
      finish(sampleFromDrawable(video, video.videoWidth, video.videoHeight));
    });
    video.addEventListener('error', () => finish(null));
    video.src = asset.storageUrl;
  });
}

/**
 * A representative frame sample for an asset, or null when none can
 * be produced (audio, decode failure, tainted canvas). Video = a
 * frame near 25% of its duration; image = the image itself.
 */
export function sampleAssetFrame(asset: MediaAsset): Promise<FrameSample | null> {
  if (asset.kind === 'image') return sampleImageAsset(asset);
  if (asset.kind === 'video') return sampleVideoAsset(asset);
  return Promise.resolve(null);
}

/** Convenience for the panel: resolve a pair context from any member item id. */
export function pairContextForItem(project: Project, itemId: string): PairContext | null {
  const item = project.items.find((i) => i.id === itemId);
  return item ? getPairContext(project, item) : null;
}
