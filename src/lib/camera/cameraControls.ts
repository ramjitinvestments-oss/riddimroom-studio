/**
 * Pure premium-viewfinder control logic for the live camera
 * (R32 Phase 2 — viewfinder & locks).
 *
 * Kept separate from `CameraCapture.tsx` so the capability parsing,
 * the lock planning + read-back, the tap-to-focus maths, the
 * exposure-compensation clamp and the two-pass colour-continuity
 * plan are unit-testable without a DOM or a real camera — same split
 * as `captureQuality.ts` (R24/R32 Phase 1), which this module builds
 * on and never duplicates.
 *
 * THE HONESTY RULE (the whole phase in one line): a control renders
 * ONLY when the live track's `getCapabilities()` exposes it, and a
 * lock is only CLAIMED after `applyConstraints` succeeded AND
 * `getSettings()` reads the mode back as 'manual'. Anything the
 * platform does not expose parses to null here and renders nothing
 * in the component (desktop / iOS Safari expose almost none of this).
 *
 * Platform background: these are the W3C Image Capture / Media
 * Capture extensions Chrome on Android exposes per track —
 * `focusMode`, `exposureMode`, `whiteBalanceMode`, `focusDistance`,
 * `exposureTime`, `iso`, `exposureCompensation`, `colorTemperature`,
 * `torch`, and `pointsOfInterest` (the last via supported
 * constraints). Support is per-device and per-browser; every parse
 * below is defensive and malformed shapes degrade to null.
 *
 * $0 rule: no dependencies.
 */

/* ------------------------------------------------------------------ */
/* Capability model                                                    */
/* ------------------------------------------------------------------ */

/** A numeric capability range, e.g. `{ min: 0, max: 3, step: 0.1 }`. */
export interface CameraNumericRange {
  min: number;
  max: number;
  step?: number;
}

export interface FocusControlCaps {
  /** Modes the track offers, e.g. ['manual', 'single-shot', 'continuous']. */
  modes: string[];
  focusDistanceRange?: CameraNumericRange;
}

export interface ExposureControlCaps {
  modes: string[];
  exposureTimeRange?: CameraNumericRange;
  isoRange?: CameraNumericRange;
  compensationRange?: CameraNumericRange;
}

export interface WhiteBalanceControlCaps {
  modes: string[];
  colorTemperatureRange?: CameraNumericRange;
}

/**
 * Everything Phase 2 is allowed to render, derived from ONE track.
 * A null system means "not exposed — render nothing for it".
 */
export interface CameraControlCaps {
  /** Tap-to-focus/exposure is offered (pointsOfInterest constraint). */
  pointsOfInterest: boolean;
  focus: FocusControlCaps | null;
  exposure: ExposureControlCaps | null;
  whiteBalance: WhiteBalanceControlCaps | null;
  /** The rear light can be switched from the page (capabilities.torch). */
  torch: boolean;
}

/** The all-absent caps — what a track with no Phase 2 surface parses to. */
export const NO_CAMERA_CONTROL_CAPS: CameraControlCaps = {
  pointsOfInterest: false,
  focus: null,
  exposure: null,
  whiteBalance: null,
  torch: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numericValue(record: Record<string, unknown>, key: string): number | undefined {
  const v = record[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function stringValue(record: Record<string, unknown>, key: string): string | undefined {
  const v = record[key];
  return typeof v === 'string' ? v : undefined;
}

/** Parse a `{ min, max, step? }` capability range; null when malformed. */
export function cameraNumericRangeFrom(value: unknown): CameraNumericRange | null {
  if (!isRecord(value)) return null;
  const min = numericValue(value, 'min');
  const max = numericValue(value, 'max');
  if (min === undefined || max === undefined || max <= min) return null;
  const step = numericValue(value, 'step');
  return { min, max, ...(step !== undefined && step > 0 ? { step } : {}) };
}

/** Parse a mode list (array of strings); null when absent or empty. */
function modeListFrom(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const modes = value.filter((m): m is string => typeof m === 'string' && m.length > 0);
  return modes.length > 0 ? modes : null;
}

/**
 * Derive the Phase 2 capability model from a track's capabilities
 * object plus the browser's supported-constraints object.
 *
 * `pointsOfInterest` is accepted from EITHER source: the W3C shape
 * puts it in `getSupportedConstraints()`, and some browsers also
 * surface it on the capabilities object — either true is enough.
 * Every other field comes from capabilities only. Anything malformed
 * degrades that one field (or system) to absent — never a throw.
 */
export function cameraControlCapsFromTrack(
  capabilities: unknown,
  supportedConstraints?: unknown,
): CameraControlCaps {
  const caps = isRecord(capabilities) ? capabilities : {};
  const supported = isRecord(supportedConstraints) ? supportedConstraints : {};

  const focusModes = modeListFrom(caps.focusMode);
  const exposureModes = modeListFrom(caps.exposureMode);
  const whiteBalanceModes = modeListFrom(caps.whiteBalanceMode);

  const focusRange = cameraNumericRangeFrom(caps.focusDistance);
  const exposureTimeRange = cameraNumericRangeFrom(caps.exposureTime);
  const isoRange = cameraNumericRangeFrom(caps.iso);
  const compensationRange = cameraNumericRangeFrom(caps.exposureCompensation);
  const colorTemperatureRange = cameraNumericRangeFrom(caps.colorTemperature);

  return {
    pointsOfInterest: supported.pointsOfInterest === true || caps.pointsOfInterest === true,
    focus: focusModes
      ? { modes: focusModes, ...(focusRange ? { focusDistanceRange: focusRange } : {}) }
      : null,
    exposure: exposureModes
      ? {
          modes: exposureModes,
          ...(exposureTimeRange ? { exposureTimeRange } : {}),
          ...(isoRange ? { isoRange } : {}),
          ...(compensationRange ? { compensationRange } : {}),
        }
      : null,
    whiteBalance: whiteBalanceModes
      ? { modes: whiteBalanceModes, ...(colorTemperatureRange ? { colorTemperatureRange } : {}) }
      : null,
    torch: caps.torch === true,
  };
}

/* ------------------------------------------------------------------ */
/* Ranges + clamps                                                     */
/* ------------------------------------------------------------------ */

/**
 * Clamp `value` into a capability range, snapping to the range's
 * step (counted from `min`) when it declares one. A null range
 * returns the value unchanged — the caller only clamps against
 * ranges the track actually published.
 */
export function clampToRange(value: number, range: CameraNumericRange | null | undefined): number {
  if (!range) return value;
  let v = Math.min(Math.max(value, range.min), range.max);
  if (range.step !== undefined && range.step > 0) {
    v = range.min + Math.round((v - range.min) / range.step) * range.step;
    v = Math.min(Math.max(v, range.min), range.max);
    // Kill float dust from the step maths (0.30000000000000004).
    v = Math.round(v * 1e6) / 1e6;
  }
  return v;
}

/** Clamp an exposure-compensation slider value to its capability range. */
export function clampExposureCompensation(value: number, range: CameraNumericRange): number {
  return clampToRange(value, range);
}

/* ------------------------------------------------------------------ */
/* Tap-to-focus                                                        */
/* ------------------------------------------------------------------ */

/**
 * Normalise a tap/click on the preview into 0..1 pointsOfInterest
 * coordinates, relative to the preview element's box.
 *
 * `mirrored` flips x: the front preview is CSS-mirrored (R24 WS-P2),
 * so the point the user SEES at element-fraction x is image-fraction
 * 1−x — the tap must focus what they actually tapped. A degenerate
 * rect (zero size) reads as {0, 0} rather than NaN.
 */
export function normalisedTapPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  mirrored: boolean,
): { x: number; y: number } {
  if (!(rect.width > 0) || !(rect.height > 0)) return { x: 0, y: 0 };
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const x = clamp01((clientX - rect.left) / rect.width);
  const y = clamp01((clientY - rect.top) / rect.height);
  return { x: mirrored ? 1 - x : x, y };
}

/* ------------------------------------------------------------------ */
/* Locks                                                               */
/* ------------------------------------------------------------------ */

/** The three systems a user lock can cover. */
export type LockableSystem = 'focus' | 'exposure' | 'whiteBalance';

/** Canonical order for plans, chips and notes: focus, exposure, colour. */
export const LOCKABLE_SYSTEM_ORDER: readonly LockableSystem[] = ['focus', 'exposure', 'whiteBalance'];

/** Systems whose capability offers a 'manual' mode — the Lock button renders when this is non-empty. */
export function lockableSystems(caps: CameraControlCaps): LockableSystem[] {
  const out: LockableSystem[] = [];
  if (caps.focus?.modes.includes('manual')) out.push('focus');
  if (caps.exposure?.modes.includes('manual')) out.push('exposure');
  if (caps.whiteBalance?.modes.includes('manual')) out.push('whiteBalance');
  return out;
}

/** One system's constraint set for a lock/unlock pass. */
export interface LockPlanStep {
  system: LockableSystem;
  constraints: Record<string, unknown>;
}

/**
 * The lock plan: for EACH offered system independently, pin its mode
 * to 'manual' AT THE VALUE THE TRACK IS ALREADY RUNNING (read from
 * `getSettings()`), so locking freezes the current look instead of
 * jumping to some default. A value the settings don't expose is
 * simply left out of that system's constraint set — the mode alone
 * still locks on devices that report modes but not values.
 * Systems without a 'manual' mode get no step at all.
 */
export function buildLockPlan(caps: CameraControlCaps, settings: unknown): LockPlanStep[] {
  const s = isRecord(settings) ? settings : {};
  const steps: LockPlanStep[] = [];

  if (caps.focus?.modes.includes('manual')) {
    const constraints: Record<string, unknown> = { focusMode: 'manual' };
    const focusDistance = numericValue(s, 'focusDistance');
    if (focusDistance !== undefined) constraints.focusDistance = focusDistance;
    steps.push({ system: 'focus', constraints });
  }
  if (caps.exposure?.modes.includes('manual')) {
    const constraints: Record<string, unknown> = { exposureMode: 'manual' };
    const exposureTime = numericValue(s, 'exposureTime');
    if (exposureTime !== undefined) constraints.exposureTime = exposureTime;
    const iso = numericValue(s, 'iso');
    if (iso !== undefined) constraints.iso = iso;
    steps.push({ system: 'exposure', constraints });
  }
  if (caps.whiteBalance?.modes.includes('manual')) {
    const constraints: Record<string, unknown> = { whiteBalanceMode: 'manual' };
    const colorTemperature = numericValue(s, 'colorTemperature');
    if (colorTemperature !== undefined) constraints.colorTemperature = colorTemperature;
    steps.push({ system: 'whiteBalance', constraints });
  }
  return steps;
}

/** The unlock plan: hand each locked system back to 'continuous'. */
export function buildUnlockPlan(locked: readonly LockableSystem[]): LockPlanStep[] {
  const modeKey: Record<LockableSystem, string> = {
    focus: 'focusMode',
    exposure: 'exposureMode',
    whiteBalance: 'whiteBalanceMode',
  };
  return LOCKABLE_SYSTEM_ORDER.filter((system) => locked.includes(system)).map((system) => ({
    system,
    constraints: { [modeKey[system]]: 'continuous' },
  }));
}

/**
 * The ONLY way a lock may be claimed: read the settings back after
 * applying and report the attempted systems whose mode now reads
 * 'manual'. A system that was never attempted can never appear here,
 * however its settings happen to read.
 */
export function lockedSystemsFromSettings(
  settings: unknown,
  attempted: readonly LockableSystem[],
): LockableSystem[] {
  const s = isRecord(settings) ? settings : {};
  const modeOf: Record<LockableSystem, string | undefined> = {
    focus: stringValue(s, 'focusMode'),
    exposure: stringValue(s, 'exposureMode'),
    whiteBalance: stringValue(s, 'whiteBalanceMode'),
  };
  return LOCKABLE_SYSTEM_ORDER.filter((system) => attempted.includes(system) && modeOf[system] === 'manual');
}

/** Display names for the lock chip — product words, US spelling. */
const LOCKED_SYSTEM_LABELS: Record<LockableSystem, string> = {
  focus: 'Focus',
  exposure: 'Exposure',
  whiteBalance: 'Color',
};

/**
 * The lock chip's exact text, e.g. "Locked: Focus · Color" — it
 * names ONLY the systems the read-back proved locked. Null when
 * nothing locked (no chip renders at all).
 */
export function formatLockedChip(locked: readonly LockableSystem[]): string | null {
  if (locked.length === 0) return null;
  const names = LOCKABLE_SYSTEM_ORDER.filter((system) => locked.includes(system)).map(
    (system) => LOCKED_SYSTEM_LABELS[system],
  );
  return `Locked: ${names.join(' · ')}`;
}

/** The one-time note shown when exposure could not join a lock. */
export const EXPOSURE_LOCK_NOTE = "Exposure can't lock on this phone";

/**
 * Whether the exposure note is owed after a lock pass: exposure is
 * absent from the proved-locked list while at least one other system
 * DID lock. Both underlying causes land here — exposure's manual
 * mode was offered but the read-back shows it didn't take, or it was
 * never offered while the others were. Null in every other case
 * (nothing locked → no chip and no note; exposure locked → no note).
 */
export function exposureLockNote(
  caps: CameraControlCaps,
  locked: readonly LockableSystem[],
): string | null {
  void caps; // Both causes produce the same honest note; caps kept for call-site clarity.
  if (locked.length === 0) return null;
  if (locked.includes('exposure')) return null;
  return EXPOSURE_LOCK_NOTE;
}

/* ------------------------------------------------------------------ */
/* Two-pass colour continuity                                          */
/* ------------------------------------------------------------------ */

/**
 * The negotiated colour/exposure profile snapshotted from pass 1's
 * track settings, to be re-applied (clamped) to pass 2's front
 * track. Only values the settings actually carried are present.
 */
export interface ContinuityProfile {
  colorTemperature?: number;
  exposureTime?: number;
  iso?: number;
  exposureCompensation?: number;
}

/** Extract a continuity profile from a `getSettings()` object. */
export function extractContinuityProfile(settings: unknown): ContinuityProfile {
  const s = isRecord(settings) ? settings : {};
  const profile: ContinuityProfile = {};
  const colorTemperature = numericValue(s, 'colorTemperature');
  if (colorTemperature !== undefined) profile.colorTemperature = colorTemperature;
  const exposureTime = numericValue(s, 'exposureTime');
  if (exposureTime !== undefined) profile.exposureTime = exposureTime;
  const iso = numericValue(s, 'iso');
  if (iso !== undefined) profile.iso = iso;
  const exposureCompensation = numericValue(s, 'exposureCompensation');
  if (exposureCompensation !== undefined) profile.exposureCompensation = exposureCompensation;
  return profile;
}

/**
 * The continuity apply-plan for pass 2: pass 1's targets CLAMPED to
 * the front track's own capability ranges, as `advanced` constraint
 * sets ready for `applyConstraints`. Best-effort by construction —
 * a value is only planned when the front track offers the manual
 * mode (or, for compensation, the range) that makes it meaningful;
 * everything else is silently skipped. This is continuity, NOT a
 * user lock: nothing here feeds the lock chip.
 */
export function buildContinuityPlan(
  profile: ContinuityProfile,
  caps: CameraControlCaps,
): Array<Record<string, unknown>> {
  const plan: Array<Record<string, unknown>> = [];

  if (caps.whiteBalance?.modes.includes('manual') && profile.colorTemperature !== undefined) {
    plan.push({
      whiteBalanceMode: 'manual',
      colorTemperature: clampToRange(profile.colorTemperature, caps.whiteBalance.colorTemperatureRange),
    });
  }
  if (
    caps.exposure?.modes.includes('manual') &&
    (profile.exposureTime !== undefined || profile.iso !== undefined)
  ) {
    const constraints: Record<string, unknown> = { exposureMode: 'manual' };
    if (profile.exposureTime !== undefined) {
      constraints.exposureTime = clampToRange(profile.exposureTime, caps.exposure.exposureTimeRange);
    }
    if (profile.iso !== undefined) {
      constraints.iso = clampToRange(profile.iso, caps.exposure.isoRange);
    }
    plan.push(constraints);
  }
  if (caps.exposure?.compensationRange && profile.exposureCompensation !== undefined) {
    plan.push({
      exposureCompensation: clampToRange(profile.exposureCompensation, caps.exposure.compensationRange),
    });
  }
  return plan;
}
