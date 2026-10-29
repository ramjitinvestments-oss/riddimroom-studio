/**
 * Pure smooth-motion logic for the live camera (R32 Phase 3 —
 * smooth-motion kit).
 *
 * Everything decidable lives here, unit-tested from synthetic
 * inputs; `CameraCapture.tsx` owns the sensors (DeviceMotion /
 * DeviceOrientation listeners, preview sampling, the countdown and
 * the zoom ramp's animation frames) and hands this module plain
 * sample values — the injected-sampler split the rest of the camera
 * lib uses (`frameDrops.ts`, `lightMeter.ts`, `cameraControls.ts`).
 *
 * WHAT LIVES HERE
 * - Motion level: 'steady' | 'moving' | 'shaky' | 'unknown' from a
 *   rolling window of gyro samples (DeviceMotion `rotationRate`
 *   magnitudes), with a frame-difference estimate as the fallback
 *   when no gyro exists. Both absent → 'unknown', and the coach
 *   renders NOTHING for 'unknown' — no signal, no judgement.
 * - Steady-start decision: a pure scan of a level history.
 * - Coach pill state per level (exact text lives here, like the
 *   light meter's label, so components stay copy-thin).
 * - Horizon tilt conversion from DeviceOrientation beta/gamma, and
 *   the level bubble's offset for a tilt.
 * - The smooth-zoom ramp maths (eased value-at-time + retarget),
 *   built on the shared film easing curves in `lib/motion/easing` —
 *   the ramp is a camera move, so it uses the same velocity shaping
 *   as every other camera move in the app rather than a local curve.
 * - The steady-start toggle's localStorage (de)serialisation.
 *
 * GYRO THRESHOLDS (rotationRate magnitude, degrees/second, sampled
 * over a rolling ~1s window). A phone held still in a hand still
 * trembles: measured magnitudes sit around 1–6°/s with small jitter,
 * so 'steady' allows a mean up to 15°/s with a standard deviation
 * up to 10°/s — generous to real hands, well under any deliberate
 * move. A slow deliberate pan runs a fairly constant 20–60°/s: that
 * is 'moving' (the coach's "Slow down" — a slower pan is smoother
 * footage) as long as it stays even. 'shaky' is EITHER fast
 * (mean ≥ 60°/s — quicker than any careful pan at arm's length) OR
 * uneven (deviation ≥ 25°/s — the stop/start/jolt pattern that
 * reads as shake on screen even at modest speeds). The deviation
 * arm matters most: shake is a variance problem before it is a
 * speed problem, which is why both statistics are computed.
 *
 * FRAME-DIFFERENCE THRESHOLDS (mean absolute luma change between
 * successive low-res preview samples, 0..1 of full scale, samples
 * ~250ms apart as the component takes them). A still scene changes
 * only by sensor noise and auto-exposure breathing: under ~0.015.
 * A deliberate pan at that sampling interval moves the frame by
 * ~0.02–0.05. Shake / fast movement jumps past 0.06 on average, or
 * spikes unevenly (deviation ≥ 0.04). Frame-diff is the SECONDARY
 * signal — it cannot tell a moving SUBJECT from a moving CAMERA —
 * so it is only consulted when the gyro is absent.
 *
 * $0 rule: no dependencies.
 */

import { clamp01, lerp, smootherstep } from '../motion/easing';

/* ------------------------------------------------------------------ */
/* Motion level                                                        */
/* ------------------------------------------------------------------ */

export type MotionLevel = 'steady' | 'moving' | 'shaky' | 'unknown';

/** Mean angular speed (deg/s) at/below which a window can be 'steady'. */
export const GYRO_STEADY_MEAN_MAX = 15;
/** Deviation (deg/s) at/below which a window can be 'steady'. */
export const GYRO_STEADY_DEVIATION_MAX = 10;
/** Mean angular speed (deg/s) at/above which a window is 'shaky' outright. */
export const GYRO_SHAKY_MEAN_MIN = 60;
/** Deviation (deg/s) at/above which a window is 'shaky' however slow its mean. */
export const GYRO_SHAKY_DEVIATION_MIN = 25;

/** Mean frame diff (0..1) at/below which a window can be 'steady'. */
export const FRAME_STEADY_MEAN_MAX = 0.015;
/** Mean frame diff (0..1) at/above which a window is 'shaky' outright. */
export const FRAME_SHAKY_MEAN_MIN = 0.06;
/** Frame-diff deviation (0..1) at/above which a window is 'shaky'. */
export const FRAME_SHAKY_DEVIATION_MIN = 0.04;

/**
 * One DeviceMotion rotation sample, reduced to the three rate
 * components (degrees/second). Any component may be null — real
 * events routinely carry null rates on some axes/devices.
 */
export interface GyroSample {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
}

/** Reduce a raw `rotationRate`-shaped value to a `GyroSample` (null when it carries no usable axis at all). */
export function gyroSampleFromRotationRate(rotationRate: unknown): GyroSample | null {
  if (!rotationRate || typeof rotationRate !== 'object') return null;
  const raw = rotationRate as { alpha?: unknown; beta?: unknown; gamma?: unknown };
  const axis = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const sample: GyroSample = { alpha: axis(raw.alpha), beta: axis(raw.beta), gamma: axis(raw.gamma) };
  if (sample.alpha === null && sample.beta === null && sample.gamma === null) return null;
  return sample;
}

/** Angular speed of one sample: the magnitude of its rate vector (null axes count as 0). */
export function gyroSampleMagnitude(sample: GyroSample): number {
  const a = sample.alpha ?? 0;
  const b = sample.beta ?? 0;
  const g = sample.gamma ?? 0;
  return Math.sqrt(a * a + b * b + g * g);
}

function meanAndDeviation(values: readonly number[]): { mean: number; deviation: number } {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / values.length;
  return { mean, deviation: Math.sqrt(variance) };
}

function levelFromStats(
  mean: number,
  deviation: number,
  steadyMeanMax: number,
  steadyDeviationMax: number,
  shakyMeanMin: number,
  shakyDeviationMin: number,
): MotionLevel {
  if (mean >= shakyMeanMin || deviation >= shakyDeviationMin) return 'shaky';
  if (mean <= steadyMeanMax && deviation <= steadyDeviationMax) return 'steady';
  return 'moving';
}

/**
 * The motion level of a rolling gyro window. Fewer than two usable
 * samples cannot support a variance judgement → 'unknown'.
 */
export function motionLevelFromGyroSamples(samples: readonly GyroSample[]): MotionLevel {
  const magnitudes = samples
    .filter((s) => s && (s.alpha !== null || s.beta !== null || s.gamma !== null))
    .map(gyroSampleMagnitude)
    .filter((m) => Number.isFinite(m));
  if (magnitudes.length < 2) return 'unknown';
  const { mean, deviation } = meanAndDeviation(magnitudes);
  return levelFromStats(
    mean,
    deviation,
    GYRO_STEADY_MEAN_MAX,
    GYRO_STEADY_DEVIATION_MAX,
    GYRO_SHAKY_MEAN_MIN,
    GYRO_SHAKY_DEVIATION_MIN,
  );
}

/**
 * One low-res preview frame in the light meter's sample shape:
 * raw pixels + dimensions, `rgba` (4 bytes/px, canvas-style) by
 * default or `gray` (1 byte/px of pre-computed luma).
 */
export interface FrameSampleInput {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  format?: 'rgba' | 'gray';
}

function frameLumas(input: FrameSampleInput): number[] | null {
  const { data, width, height } = input;
  if (!data || width <= 0 || height <= 0) return null;
  const bytesPerPixel = input.format === 'gray' ? 1 : 4;
  const pixelCount = Math.min(width * height, Math.floor(data.length / bytesPerPixel));
  if (pixelCount <= 0) return null;
  const lumas = new Array<number>(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    if (bytesPerPixel === 1) {
      lumas[i] = data[i] / 255;
    } else {
      const o = i * 4;
      lumas[i] = (0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]) / 255;
    }
  }
  return lumas;
}

/**
 * Mean absolute luma difference between two preview samples of the
 * same shape, 0..1. Null when either sample is unusable or their
 * shapes differ — a diff across a resize is not motion.
 */
export function meanAbsFrameDiff(prev: FrameSampleInput, next: FrameSampleInput): number | null {
  if (prev.width !== next.width || prev.height !== next.height) return null;
  const a = frameLumas(prev);
  const b = frameLumas(next);
  if (!a || !b || a.length !== b.length || a.length === 0) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(b[i] - a[i]);
  return sum / a.length;
}

/**
 * The motion level of a rolling window of successive frame diffs.
 * Fewer than two diffs cannot support a variance judgement →
 * 'unknown'. Non-finite entries are ignored.
 */
export function motionLevelFromFrameDiffs(diffs: readonly number[]): MotionLevel {
  const usable = diffs.filter((d) => typeof d === 'number' && Number.isFinite(d) && d >= 0);
  if (usable.length < 2) return 'unknown';
  const { mean, deviation } = meanAndDeviation(usable);
  return levelFromStats(
    mean,
    deviation,
    FRAME_STEADY_MEAN_MAX,
    // No separate steady deviation gate for frame-diff: below the
    // shaky deviation arm, unevenness alone doesn't demote a calm
    // mean — a passing shadow spikes one diff without any shake.
    Number.POSITIVE_INFINITY,
    FRAME_SHAKY_MEAN_MIN,
    FRAME_SHAKY_DEVIATION_MIN,
  );
}

/**
 * Combine the two signals into one level: the gyro is primary
 * (it measures the CAMERA); frame-diff is consulted only when the
 * gyro has no answer; both silent → 'unknown'.
 */
export function combineMotionLevels(gyroLevel: MotionLevel, frameLevel: MotionLevel): MotionLevel {
  if (gyroLevel !== 'unknown') return gyroLevel;
  return frameLevel;
}

export interface MotionAssessment {
  level: MotionLevel;
  /** Which signal decided — 'none' when the level is 'unknown'. */
  source: 'gyro' | 'frame' | 'none';
}

/** Assess one rolling window of each signal into a single level + its source. */
export function assessMotion(input: {
  gyroSamples?: readonly GyroSample[];
  frameDiffs?: readonly number[];
}): MotionAssessment {
  const gyroLevel = motionLevelFromGyroSamples(input.gyroSamples ?? []);
  if (gyroLevel !== 'unknown') return { level: gyroLevel, source: 'gyro' };
  const frameLevel = motionLevelFromFrameDiffs(input.frameDiffs ?? []);
  if (frameLevel !== 'unknown') return { level: frameLevel, source: 'frame' };
  return { level: 'unknown', source: 'none' };
}

/* ------------------------------------------------------------------ */
/* Steady-start decision                                               */
/* ------------------------------------------------------------------ */

/** Consecutive 'steady' readings the steady-start countdown asks for before it may finish early. */
export const STEADY_START_REQUIRED_CONSECUTIVE = 2;

/**
 * "Still enough" for the steady-start countdown: the history ENDS
 * with at least `requiredConsecutive` (default 2) 'steady' readings
 * in a row. One calm reading proves nothing (a shake passes through
 * stillness twice per swing); two in a row at the coach's ~4Hz
 * sampling means the phone has actually settled for ~half a second.
 * An 'unknown' reading breaks the run like any other non-steady
 * level — no signal is not stillness.
 */
export function isStillEnough(
  levelHistory: readonly MotionLevel[],
  requiredConsecutive: number = STEADY_START_REQUIRED_CONSECUTIVE,
): boolean {
  const needed = Math.max(1, Math.floor(requiredConsecutive));
  if (levelHistory.length < needed) return false;
  for (let i = levelHistory.length - needed; i < levelHistory.length; i++) {
    if (levelHistory[i] !== 'steady') return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Coach pill                                                          */
/* ------------------------------------------------------------------ */

export interface MotionCoachState {
  /** The pill's exact text. */
  text: 'Smooth' | 'Slow down' | 'Too shaky';
  /** Colour intent for the pill: calm / caution / warning. */
  tone: 'good' | 'warn' | 'bad';
}

/** Coach state for a level — null for 'unknown' (no pill renders without a signal). */
export function coachStateForLevel(level: MotionLevel): MotionCoachState | null {
  switch (level) {
    case 'steady':
      return { text: 'Smooth', tone: 'good' };
    case 'moving':
      return { text: 'Slow down', tone: 'warn' };
    case 'shaky':
      return { text: 'Too shaky', tone: 'bad' };
    case 'unknown':
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Level / horizon indicator                                           */
/* ------------------------------------------------------------------ */

/**
 * The horizon tilt of the device, in degrees: how far the phone is
 * rolled away from level, signed (positive = rolled one way,
 * negative = the other; the component counter-rotates the horizon
 * line by the returned value and mirrors the bubble by it).
 *
 * Conversion: for the DeviceOrientation Z-X'-Y'' angles, the roll
 * of the screen plane is atan2(sin γ · sin β, cos γ). At the
 * everyday holding position (β ≈ 90°, phone upright) this reduces
 * to exactly γ — the left/right tilt — while a phone lying flat
 * (β ≈ 0) reads 0 rather than spinning (flat has no horizon to
 * show). Missing or non-finite angles → null (no indicator).
 * Result is normalised to −180..180.
 */
export function horizonTiltDegrees(
  beta: number | null | undefined,
  gamma: number | null | undefined,
): number | null {
  if (typeof beta !== 'number' || !Number.isFinite(beta)) return null;
  if (typeof gamma !== 'number' || !Number.isFinite(gamma)) return null;
  const betaRad = (beta * Math.PI) / 180;
  const gammaRad = (gamma * Math.PI) / 180;
  const tiltRad = Math.atan2(Math.sin(gammaRad) * Math.sin(betaRad), Math.cos(gammaRad));
  let degrees = (tiltRad * 180) / Math.PI;
  if (degrees > 180) degrees -= 360;
  if (degrees < -180) degrees += 360;
  return degrees;
}

/**
 * The level bubble's horizontal offset (px) for a tilt: the bubble
 * sits displaced AGAINST the roll (it slides toward the low side,
 * like a real spirit level's bubble rises to the high side — here
 * rendered as the dot that must be centred), proportional to
 * sin(tilt) and clamped to the track radius. 0 when level.
 */
export function levelBubbleOffsetPx(tiltDegrees: number, radiusPx: number): number {
  if (!Number.isFinite(tiltDegrees) || !(radiusPx > 0)) return 0;
  const offset = -Math.sin((tiltDegrees * Math.PI) / 180) * radiusPx;
  const clamped = Math.max(-radiusPx, Math.min(radiusPx, offset));
  return clamped === 0 ? 0 : clamped; // normalise -0
}

/* ------------------------------------------------------------------ */
/* Smooth zoom ramp                                                    */
/* ------------------------------------------------------------------ */

/** Default zoom ramp length — long enough to read as a glide, short enough to feel responsive. */
export const ZOOM_RAMP_DURATION_MS = 300;

export interface ZoomRamp {
  /** Zoom value the ramp starts from. */
  from: number;
  /** Zoom value the ramp lands on. */
  to: number;
  /** Ramp start time (any monotonic ms clock — the component uses performance.now()). */
  startMs: number;
  /** Ramp length in ms; 0 = jump straight to the target. */
  durationMs: number;
}

/** Start a ramp from the currently-applied zoom to `to`. Non-finite inputs collapse to a no-op ramp at `to`. */
export function createZoomRamp(
  from: number,
  to: number,
  startMs: number,
  durationMs: number = ZOOM_RAMP_DURATION_MS,
): ZoomRamp {
  const safeTo = Number.isFinite(to) ? to : Number.isFinite(from) ? from : 1;
  const safeFrom = Number.isFinite(from) ? from : safeTo;
  return {
    from: safeFrom,
    to: safeTo,
    startMs: Number.isFinite(startMs) ? startMs : 0,
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0,
  };
}

/**
 * The eased zoom value at `nowMs`: smootherstep-shaped between
 * `from` and `to` (zero velocity at both ends — the zoom glides
 * out of its start and settles onto its target instead of snapping
 * at either end). Before the start → `from`; at/after the end →
 * exactly `to`.
 */
export function zoomRampValueAt(ramp: ZoomRamp, nowMs: number): number {
  if (!(ramp.durationMs > 0)) return ramp.to;
  const t = clamp01((nowMs - ramp.startMs) / ramp.durationMs);
  if (t <= 0) return ramp.from;
  if (t >= 1) return ramp.to;
  return lerp(ramp.from, ramp.to, smootherstep(t));
}

/** True once `nowMs` is at/past the ramp's end. */
export function isZoomRampDone(ramp: ZoomRamp, nowMs: number): boolean {
  return !(ramp.durationMs > 0) || nowMs - ramp.startMs >= ramp.durationMs;
}

/**
 * Retarget a live ramp: the new ramp starts from the value the old
 * one has eased TO at `nowMs` (never from the old `to` — the slider
 * moved mid-glide, so the glide continues from where it visibly
 * is), and runs a fresh full duration to the new target.
 */
export function retargetZoomRamp(
  ramp: ZoomRamp,
  to: number,
  nowMs: number,
  durationMs: number = ZOOM_RAMP_DURATION_MS,
): ZoomRamp {
  return createZoomRamp(zoomRampValueAt(ramp, nowMs), to, nowMs, durationMs);
}

/* ------------------------------------------------------------------ */
/* Steady-start toggle persistence                                     */
/* ------------------------------------------------------------------ */

/** localStorage key for the steady-start toggle (plain key, same style as the device-profile key). */
export const STEADY_START_STORAGE_KEY = 'riddimroom.camera.steadyStart.v1';

/** The minimal storage slice the toggle needs (structurally `localStorage`). */
export interface SteadyStartStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** Serialise the toggle: '1' = on, '0' = off. */
export function serializeSteadyStartEnabled(enabled: boolean): string {
  return enabled ? '1' : '0';
}

/**
 * Parse the stored toggle. Steady-start is DEFAULT ON: a missing
 * key, unreadable storage or any unrecognised value reads as on;
 * only an explicit stored '0' turns it off.
 */
export function parseSteadyStartEnabled(raw: string | null | undefined): boolean {
  return raw !== '0';
}

/** Load the toggle from storage (default on when storage is absent/unreadable). */
export function loadSteadyStartEnabled(storage: SteadyStartStorage | null | undefined): boolean {
  if (!storage) return true;
  try {
    return parseSteadyStartEnabled(storage.getItem(STEADY_START_STORAGE_KEY));
  } catch {
    return true;
  }
}

/** Save the toggle. Best-effort: storage failures are swallowed. */
export function saveSteadyStartEnabled(
  storage: SteadyStartStorage | null | undefined,
  enabled: boolean,
): void {
  if (!storage) return;
  try {
    storage.setItem(STEADY_START_STORAGE_KEY, serializeSteadyStartEnabled(enabled));
  } catch {
    // Best-effort only — the toggle still works for this session.
  }
}
