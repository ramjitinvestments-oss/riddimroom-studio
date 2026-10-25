/**
 * Viral Promo — client-side artwork analysis (the "Director").
 *
 * Mirrors the method proven in the offline proof pipeline: measure the
 * actual file, never guess. From raw pixels we derive:
 *  - row "content bands" (for logos/artwork on dark grounds: the stacked
 *    elements — emblem, wordmark, pills, feature rows), and
 *  - a suggested artwork kind, which the page maps to a recipe.
 *
 * Everything here is pure functions over pixel buffers so it is unit
 * testable without a DOM.
 */

export interface Band {
  /** Fractions of image height, 0..1. */
  y0: number;
  y1: number;
}

export interface PaletteSummary {
  /** Dominant colours (hex), largest first, with their pixel share. */
  colors: Array<{ hex: string; share: number }>;
  /** Mean red-minus-blue, -1..1 — positive reads warm/golden. */
  warmth: number;
  /** Mean saturation 0..1 — high reads vivid/party, low reads muted/corporate. */
  saturation: number;
}

export interface ArtworkAnalysis {
  width: number;
  height: number;
  /** Fraction of near-black pixels (0..1). */
  darkFraction: number;
  /** 0..255 mean of per-pixel max channel. */
  meanLuminance: number;
  /** Content row bands, top to bottom. */
  bands: Band[];
  suggestedKind: 'logo' | 'flyer' | 'portrait';
  /** R20: the image's colour story — drives skin suggestion and the
      no-text caption fit when an image carries no words at all. */
  palette: PaletteSummary;
}

/**
 * Dominant-colour summary over a pixel buffer (sampled, quantized to
 * 4 bits per channel). Pure — unit-testable without a DOM.
 */
export function summarizePalette(data: Uint8ClampedArray, width: number, height: number): PaletteSummary {
  const total = width * height;
  if (total <= 0) return { colors: [], warmth: 0, saturation: 0 };
  const step = Math.max(1, Math.floor(total / 20000));
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  let sampled = 0;
  let warmthSum = 0;
  let satSum = 0;
  for (let px = 0; px < total; px += step) {
    const i = px * 4;
    if (data[i + 3] < 200) continue; // skip (near-)transparent
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    sampled++;
    warmthSum += (r - b) / 255;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    satSum += mx > 0 ? (mx - mn) / mx : 0;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else {
      buckets.set(key, { count: 1, r, g, b });
    }
  }
  if (sampled === 0) return { colors: [], warmth: 0, saturation: 0 };
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  const colors = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((bucket) => ({
      hex: `#${hex(bucket.r / bucket.count)}${hex(bucket.g / bucket.count)}${hex(bucket.b / bucket.count)}`,
      share: +(bucket.count / sampled).toFixed(3),
    }));
  return { colors, warmth: +(warmthSum / sampled).toFixed(3), saturation: +(satSum / sampled).toFixed(3) };
}

/** Per-row content score: sum of per-pixel max-channel values in the row. */
export function rowContentScores(data: Uint8ClampedArray, width: number, height: number): number[] {
  const scores = new Array<number>(height).fill(0);
  for (let y = 0; y < height; y++) {
    let s = 0;
    const rowStart = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = rowStart + x * 4;
      s += Math.max(data[i], data[i + 1], data[i + 2]);
    }
    scores[y] = s;
  }
  return scores;
}

/**
 * Group content rows into bands. A row counts as content when its score
 * exceeds `rowThreshold` (in units of "average max-channel per pixel").
 * Bands separated by gaps of at most `maxGap` rows merge.
 */
export function detectBands(
  scores: number[],
  width: number,
  opts?: { rowThreshold?: number; maxGap?: number; minBandPx?: number },
): Band[] {
  const height = scores.length;
  if (height === 0 || width <= 0) return [];
  const threshold = (opts?.rowThreshold ?? 6) * width;
  const maxGap = opts?.maxGap ?? Math.max(4, Math.round(height * 0.006));
  const minBandPx = opts?.minBandPx ?? 6;
  const bands: Band[] = [];
  let start = -1;
  let lastContent = -1;
  for (let y = 0; y < height; y++) {
    if (scores[y] > threshold) {
      if (start < 0) start = y;
      lastContent = y;
    } else if (start >= 0 && y - lastContent > maxGap) {
      if (lastContent - start + 1 >= minBandPx) bands.push({ y0: start / height, y1: (lastContent + 1) / height });
      start = -1;
    }
  }
  if (start >= 0 && lastContent - start + 1 >= minBandPx) {
    bands.push({ y0: start / height, y1: (lastContent + 1) / height });
  }
  return bands;
}

/** Even tiling bands (the Kinetic Build fallback when content bands are unusable). */
export function tilingBands(count: number): Band[] {
  const out: Band[] = [];
  for (let i = 0; i < count; i++) out.push({ y0: i / count, y1: (i + 1) / count });
  return out;
}

/**
 * Choose the bands a recipe should animate: detected content bands when
 * there are 2..9 of them, otherwise even tiles.
 */
export function recipeBands(analysis: ArtworkAnalysis, tileCount = 7): Band[] {
  if (analysis.bands.length >= 2 && analysis.bands.length <= 9) return analysis.bands;
  return tilingBands(tileCount);
}

export function analyzePixels(data: Uint8ClampedArray, width: number, height: number): ArtworkAnalysis {
  let dark = 0;
  let lumSum = 0;
  const total = width * height;
  for (let i = 0; i < data.length; i += 4) {
    const m = Math.max(data[i], data[i + 1], data[i + 2]);
    lumSum += m;
    if (m < 26) dark++;
  }
  const scores = rowContentScores(data, width, height);
  const bands = detectBands(scores, width);
  const darkFraction = total > 0 ? dark / total : 0;
  const aspect = height > 0 ? width / height : 1;
  const suggestedKind: ArtworkAnalysis['suggestedKind'] =
    darkFraction > 0.5 && aspect > 1.15 ? 'logo' : aspect < 0.92 ? 'portrait' : 'flyer';
  return {
    width,
    height,
    darkFraction,
    meanLuminance: total > 0 ? lumSum / total : 0,
    bands,
    suggestedKind,
    palette: summarizePalette(data, width, height),
  };
}

/** Load a File into an ImageBitmap-backed canvas and analyze it (browser only). */
export async function analyzeImageFile(file: File): Promise<{ analysis: ArtworkAnalysis; bitmap: ImageBitmap }> {
  const bitmap = await createImageBitmap(file);
  const maxSide = 640;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  ctx.drawImage(bitmap, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  const analysis = analyzePixels(imageData.data, w, h);
  // Report the true source dimensions, not the downscaled analysis size.
  return { analysis: { ...analysis, width: bitmap.width, height: bitmap.height }, bitmap };
}

/**
 * Slice the source image into one PNG File per band (full width strips),
 * for upload as separate media assets. Browser only.
 *
 * `featherPx` softens each band's top/bottom alpha edge (except the outer
 * edges of the first/last band): a band sliding in over the ambient plate
 * then has no hard rectangular seam — the join defect the offline proofs
 * recorded, fixed in the slice itself so the compositor needs no masks.
 */
export async function sliceBandFiles(
  bitmap: ImageBitmap,
  bands: Band[],
  baseName: string,
  opts?: { featherPx?: number },
): Promise<File[]> {
  const feather = opts?.featherPx ?? 0;
  const files: File[] = [];
  for (let i = 0; i < bands.length; i++) {
    const y0 = Math.floor(bands[i].y0 * bitmap.height);
    const y1 = Math.max(y0 + 1, Math.ceil(bands[i].y1 * bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = y1 - y0;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available in this browser.');
    ctx.drawImage(bitmap, 0, y0, bitmap.width, y1 - y0, 0, 0, bitmap.width, y1 - y0);
    if (feather > 0) {
      const f = Math.min(feather, (y1 - y0) / 2);
      ctx.globalCompositeOperation = 'destination-out';
      if (i > 0) {
        const g = ctx.createLinearGradient(0, 0, 0, f);
        g.addColorStop(0, 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, bitmap.width, f);
      }
      if (i < bands.length - 1) {
        const g = ctx.createLinearGradient(0, canvas.height, 0, canvas.height - f);
        g.addColorStop(0, 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, canvas.height - f, bitmap.width, f);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Could not slice the artwork into bands.');
    files.push(new File([blob], `${baseName}-band-${i + 1}.png`, { type: 'image/png' }));
  }
  return files;
}
