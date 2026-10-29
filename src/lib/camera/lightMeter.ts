/**
 * Pure light-meter logic for the live camera preview
 * (R32 Phase 2 — light meter + zebra).
 *
 * The component samples the live <video> into a tiny offscreen
 * canvas (<= 96px wide) a few times a second and hands the pixels
 * here; everything decidable — the light state, the numbers behind
 * it, and which grid cells are clipping hard enough to zebra — is
 * computed in this module so it is unit-testable from synthetic
 * buffers without a DOM or a camera.
 *
 * THRESHOLDS (chosen for gamma-encoded preview luma, 0..1):
 * - Clip level 250/255: only pixels at sensor saturation count as
 *   clipped — a merely bright pixel (240s) is detail, not loss.
 * - 'blowing-out' at >= 2% of the frame clipped: below that, specks
 *   (a small lamp, a specular glint) are normal in a good shot; at
 *   2%+ a real highlight area (sky, window, white shirt) is losing
 *   detail. Checked FIRST — clipping matters even in a bright frame.
 * - 'too-dark' below mean luma 0.18: an encoded mean under ~46/255
 *   means most of the frame sits in the noisy bottom of the sensor's
 *   range, where high resolutions and high frame rates hurt most
 *   (smaller effective pixels, shorter exposures) — exactly when
 *   the "1080p will look cleaner" advice applies.
 * - 'bright' at mean luma >= 0.62: a genuinely light-filled frame
 *   that is not clipping — worth naming so the user knows they have
 *   light to spare, distinct from 'good'.
 * - Zebra cells flag at > 25% of a cell's pixels clipped: a cell
 *   must be substantially blown before it earns stripes, so single
 *   hot pixels never speckle the preview.
 *
 * $0 rule: no dependencies.
 */

/** Zebra / analysis grid dimensions over the sample. */
export const LIGHT_GRID_COLS = 24;
export const LIGHT_GRID_ROWS = 24;

/** Luma (0..255 scale) at/above which a pixel counts as clipped. */
export const LIGHT_CLIP_LUMA = 250;
/** Frame clipped fraction at/above which the state is 'blowing-out'. */
export const LIGHT_BLOWING_OUT_FRACTION = 0.02;
/** Mean luma (0..1) below which the state is 'too-dark'. */
export const LIGHT_TOO_DARK_MEAN = 0.18;
/** Mean luma (0..1) below which a dark frame counts as VERY dark. */
export const LIGHT_VERY_DARK_MEAN = 0.1;
/** Mean luma (0..1) at/above which the state is 'bright'. */
export const LIGHT_BRIGHT_MEAN = 0.62;
/** Per-cell clipped fraction above which a zebra cell flags. */
export const LIGHT_ZEBRA_CELL_FRACTION = 0.25;

export type LightState = 'too-dark' | 'good' | 'bright' | 'blowing-out';

export interface LightMeterResult {
  state: LightState;
  /** Mean frame luma, 0..1 (gamma-encoded, Rec. 709 weights). */
  meanLuma: number;
  /** Fraction of pixels at/above the clip level, 0..1. */
  clippedFraction: number;
  /**
   * Row-major grid over the sample (`LIGHT_GRID_COLS` x
   * `LIGHT_GRID_ROWS`): true = that cell's highlights are clipping
   * hard enough to draw zebra stripes over it.
   */
  zebraCells: boolean[];
}

/**
 * The minimal sample input: raw pixels + dimensions. `rgba` (the
 * default) reads 4 bytes per pixel as canvas ImageData does; `gray`
 * reads 1 byte per pixel as pre-computed luma. Bytes beyond
 * width*height pixels are ignored; a short buffer just analyses
 * the pixels it actually has.
 */
export interface LightSampleInput {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  format?: 'rgba' | 'gray';
}

const NO_SIGNAL_RESULT: LightMeterResult = {
  state: 'good',
  meanLuma: 0,
  clippedFraction: 0,
  zebraCells: new Array(LIGHT_GRID_COLS * LIGHT_GRID_ROWS).fill(false),
};

/**
 * Analyse one preview sample. Invalid input (no size, no pixels)
 * returns the no-signal result — 'good' state, zeros, no zebra —
 * so a failed sample never invents a warning.
 */
export function analyzeLightSample(input: LightSampleInput): LightMeterResult {
  const { data, width, height } = input;
  if (!data || width <= 0 || height <= 0) return { ...NO_SIGNAL_RESULT, zebraCells: [...NO_SIGNAL_RESULT.zebraCells] };
  const bytesPerPixel = input.format === 'gray' ? 1 : 4;
  const pixelCount = Math.min(width * height, Math.floor(data.length / bytesPerPixel));
  if (pixelCount <= 0) return { ...NO_SIGNAL_RESULT, zebraCells: [...NO_SIGNAL_RESULT.zebraCells] };

  const cellCount = LIGHT_GRID_COLS * LIGHT_GRID_ROWS;
  const cellPixels = new Array<number>(cellCount).fill(0);
  const cellClipped = new Array<number>(cellCount).fill(0);
  let lumaSum = 0;
  let clippedTotal = 0;

  for (let i = 0; i < pixelCount; i++) {
    let luma: number;
    if (bytesPerPixel === 1) {
      luma = data[i];
    } else {
      const o = i * 4;
      // Rec. 709 luma weights on the encoded preview pixels.
      luma = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
    }
    lumaSum += luma;
    const px = i % width;
    const py = Math.floor(i / width);
    const col = Math.min(LIGHT_GRID_COLS - 1, Math.floor((px / width) * LIGHT_GRID_COLS));
    const row = Math.min(LIGHT_GRID_ROWS - 1, Math.floor((py / height) * LIGHT_GRID_ROWS));
    const cell = row * LIGHT_GRID_COLS + col;
    cellPixels[cell] += 1;
    if (luma >= LIGHT_CLIP_LUMA) {
      clippedTotal += 1;
      cellClipped[cell] += 1;
    }
  }

  const meanLuma = lumaSum / pixelCount / 255;
  const clippedFraction = clippedTotal / pixelCount;
  const zebraCells = cellPixels.map((count, idx) =>
    count > 0 ? cellClipped[idx] / count > LIGHT_ZEBRA_CELL_FRACTION : false,
  );

  const state: LightState =
    clippedFraction >= LIGHT_BLOWING_OUT_FRACTION
      ? 'blowing-out'
      : meanLuma < LIGHT_TOO_DARK_MEAN
        ? 'too-dark'
        : meanLuma >= LIGHT_BRIGHT_MEAN
          ? 'bright'
          : 'good';

  return { state, meanLuma, clippedFraction, zebraCells };
}

/** The meter pill's exact text per state. */
export function lightStateLabel(state: LightState): string {
  switch (state) {
    case 'too-dark':
      return 'Too dark';
    case 'good':
      return 'Good light';
    case 'bright':
      return 'Very bright';
    case 'blowing-out':
      return 'Highlights blowing out';
  }
}

/**
 * The plain advice line under the meter, in context — or null when
 * the light is simply good and there is nothing worth saying.
 *
 * - Too dark while a demanding capture is chosen (4K-class quality
 *   or 60fps): name the cleaner trade honestly. This NEVER changes
 *   the user's choice — it only says what would look cleaner.
 * - Too dark, very dark, with a light available on the rear camera:
 *   append the flashlight prompt.
 * - Blowing out: say what is happening and the two honest fixes.
 */
export function lightAdvice(
  result: LightMeterResult,
  opts: { demandingCapture: boolean; torchAvailable: boolean },
): string | null {
  switch (result.state) {
    case 'too-dark': {
      let advice = opts.demandingCapture
        ? 'Too dark — 1080p will look cleaner than 4K here'
        : 'Too dark — add light if you can, or face a window';
      if (result.meanLuma < LIGHT_VERY_DARK_MEAN && opts.torchAvailable) {
        advice += '. Or try the flashlight.';
      }
      return advice;
    }
    case 'blowing-out':
      return 'The brightest parts are washing out — a little less light, or turn down the exposure, will help.';
    case 'bright':
      return 'Plenty of light here — you are good to record.';
    case 'good':
      return null;
  }
}
