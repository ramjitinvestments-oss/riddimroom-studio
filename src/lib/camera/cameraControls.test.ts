import { describe, it, expect } from 'vitest';
import {
  EXPOSURE_LOCK_NOTE,
  NO_CAMERA_CONTROL_CAPS,
  buildContinuityPlan,
  buildLockPlan,
  buildUnlockPlan,
  cameraControlCapsFromTrack,
  cameraNumericRangeFrom,
  clampExposureCompensation,
  clampToRange,
  exposureLockNote,
  extractContinuityProfile,
  formatLockedChip,
  lockableSystems,
  lockedSystemsFromSettings,
  normalisedTapPoint,
  type CameraControlCaps,
} from './cameraControls';

/** A full-featured Android-style capability set. */
const FULL_CAPS = {
  focusMode: ['manual', 'single-shot', 'continuous'],
  focusDistance: { min: 0, max: 10, step: 0.1 },
  exposureMode: ['manual', 'continuous'],
  exposureTime: { min: 0.1, max: 1000, step: 0.1 },
  iso: { min: 50, max: 3200 },
  exposureCompensation: { min: -3, max: 3, step: 0.5 },
  whiteBalanceMode: ['manual', 'continuous'],
  colorTemperature: { min: 2500, max: 8000, step: 100 },
  torch: true,
};

describe('cameraControlCapsFromTrack', () => {
  it('parses a full capability set into the control model', () => {
    const caps = cameraControlCapsFromTrack(FULL_CAPS, { pointsOfInterest: true });
    expect(caps.pointsOfInterest).toBe(true);
    expect(caps.focus?.modes).toEqual(['manual', 'single-shot', 'continuous']);
    expect(caps.focus?.focusDistanceRange).toEqual({ min: 0, max: 10, step: 0.1 });
    expect(caps.exposure?.modes).toEqual(['manual', 'continuous']);
    expect(caps.exposure?.exposureTimeRange).toEqual({ min: 0.1, max: 1000, step: 0.1 });
    expect(caps.exposure?.isoRange).toEqual({ min: 50, max: 3200 });
    expect(caps.exposure?.compensationRange).toEqual({ min: -3, max: 3, step: 0.5 });
    expect(caps.whiteBalance?.modes).toEqual(['manual', 'continuous']);
    expect(caps.whiteBalance?.colorTemperatureRange).toEqual({ min: 2500, max: 8000, step: 100 });
    expect(caps.torch).toBe(true);
  });

  it('accepts pointsOfInterest from the capabilities object alone', () => {
    expect(cameraControlCapsFromTrack({ pointsOfInterest: true }).pointsOfInterest).toBe(true);
    expect(cameraControlCapsFromTrack({}, { pointsOfInterest: true }).pointsOfInterest).toBe(true);
    expect(cameraControlCapsFromTrack({}, {}).pointsOfInterest).toBe(false);
    expect(cameraControlCapsFromTrack({}, { pointsOfInterest: 'yes' }).pointsOfInterest).toBe(false);
  });

  it('degrades absent / empty input to the all-absent model', () => {
    expect(cameraControlCapsFromTrack(null)).toEqual(NO_CAMERA_CONTROL_CAPS);
    expect(cameraControlCapsFromTrack(undefined)).toEqual(NO_CAMERA_CONTROL_CAPS);
    expect(cameraControlCapsFromTrack('junk')).toEqual(NO_CAMERA_CONTROL_CAPS);
    expect(cameraControlCapsFromTrack({})).toEqual(NO_CAMERA_CONTROL_CAPS);
    expect(cameraControlCapsFromTrack([])).toEqual(NO_CAMERA_CONTROL_CAPS);
  });

  it('drops malformed systems and ranges instead of throwing', () => {
    const caps = cameraControlCapsFromTrack({
      focusMode: 'manual', // not an array
      exposureMode: [], // empty
      whiteBalanceMode: ['manual', 42, ''], // junk entries filtered out
      colorTemperature: { min: 8000, max: 2500 }, // inverted range
      torch: 'true', // not a boolean
    });
    expect(caps.focus).toBeNull();
    expect(caps.exposure).toBeNull();
    expect(caps.whiteBalance?.modes).toEqual(['manual']);
    expect(caps.whiteBalance?.colorTemperatureRange).toBeUndefined();
    expect(caps.torch).toBe(false);
  });

  it('keeps a system whose modes parse even when its ranges do not', () => {
    const caps = cameraControlCapsFromTrack({
      exposureMode: ['manual', 'continuous'],
      exposureCompensation: { min: 'low', max: 3 },
    });
    expect(caps.exposure?.modes).toEqual(['manual', 'continuous']);
    expect(caps.exposure?.compensationRange).toBeUndefined();
  });
});

describe('cameraNumericRangeFrom / clamps', () => {
  it('rejects non-objects, non-numbers and inverted ranges', () => {
    expect(cameraNumericRangeFrom(null)).toBeNull();
    expect(cameraNumericRangeFrom({ min: 0 })).toBeNull();
    expect(cameraNumericRangeFrom({ min: 5, max: 5 })).toBeNull();
    expect(cameraNumericRangeFrom({ min: Number.NaN, max: 5 })).toBeNull();
    expect(cameraNumericRangeFrom({ min: 0, max: 5, step: -1 })).toEqual({ min: 0, max: 5 });
  });

  it('clampToRange clamps, snaps to step from min, and passes through with no range', () => {
    const range = { min: -3, max: 3, step: 0.5 };
    expect(clampToRange(-9, range)).toBe(-3);
    expect(clampToRange(9, range)).toBe(3);
    expect(clampToRange(1.3, range)).toBe(1.5);
    expect(clampToRange(1.24, range)).toBe(1);
    expect(clampToRange(7, null)).toBe(7);
    expect(clampToRange(7, undefined)).toBe(7);
  });

  it('clampExposureCompensation applies the capability range', () => {
    expect(clampExposureCompensation(2.6, { min: -2, max: 2, step: 1 })).toBe(2);
    expect(clampExposureCompensation(-0.4, { min: -2, max: 2, step: 1 })).toBe(0);
  });
});

describe('normalisedTapPoint', () => {
  const rect = { left: 100, top: 50, width: 400, height: 800 };

  it('normalises a tap relative to the preview box', () => {
    expect(normalisedTapPoint(300, 450, rect, false)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalisedTapPoint(100, 50, rect, false)).toEqual({ x: 0, y: 0 });
    expect(normalisedTapPoint(500, 850, rect, false)).toEqual({ x: 1, y: 1 });
  });

  it('clamps taps outside the box', () => {
    expect(normalisedTapPoint(-50, 9999, rect, false)).toEqual({ x: 0, y: 1 });
  });

  it('flips x for the mirrored front preview so the tapped point is the focused point', () => {
    expect(normalisedTapPoint(200, 450, rect, true)).toEqual({ x: 0.75, y: 0.5 });
    expect(normalisedTapPoint(200, 450, rect, false)).toEqual({ x: 0.25, y: 0.5 });
  });

  it('reads a degenerate rect as the origin, never NaN', () => {
    const p = normalisedTapPoint(10, 10, { left: 0, top: 0, width: 0, height: 0 }, false);
    expect(p).toEqual({ x: 0, y: 0 });
  });
});

describe('lock planning + read-back', () => {
  const caps = cameraControlCapsFromTrack(FULL_CAPS, { pointsOfInterest: true });
  const settings = {
    focusMode: 'continuous',
    focusDistance: 2.5,
    exposureMode: 'continuous',
    exposureTime: 12.5,
    iso: 400,
    whiteBalanceMode: 'continuous',
    colorTemperature: 5200,
  };

  it('lockableSystems lists only systems offering a manual mode', () => {
    expect(lockableSystems(caps)).toEqual(['focus', 'exposure', 'whiteBalance']);
    expect(lockableSystems(NO_CAMERA_CONTROL_CAPS)).toEqual([]);
    const partial = cameraControlCapsFromTrack({ whiteBalanceMode: ['manual', 'continuous'] });
    expect(lockableSystems(partial)).toEqual(['whiteBalance']);
  });

  it('buildLockPlan pins each offered system at its current settings values', () => {
    expect(buildLockPlan(caps, settings)).toEqual([
      { system: 'focus', constraints: { focusMode: 'manual', focusDistance: 2.5 } },
      { system: 'exposure', constraints: { exposureMode: 'manual', exposureTime: 12.5, iso: 400 } },
      { system: 'whiteBalance', constraints: { whiteBalanceMode: 'manual', colorTemperature: 5200 } },
    ]);
  });

  it('buildLockPlan omits values the settings do not expose, and skips unoffered systems', () => {
    expect(buildLockPlan(caps, {})).toEqual([
      { system: 'focus', constraints: { focusMode: 'manual' } },
      { system: 'exposure', constraints: { exposureMode: 'manual' } },
      { system: 'whiteBalance', constraints: { whiteBalanceMode: 'manual' } },
    ]);
    const partial = cameraControlCapsFromTrack({ focusMode: ['manual'] });
    expect(buildLockPlan(partial, settings)).toEqual([
      { system: 'focus', constraints: { focusMode: 'manual', focusDistance: 2.5 } },
    ]);
    expect(buildLockPlan(caps, null)).toHaveLength(3);
  });

  it('buildUnlockPlan returns continuous for exactly the locked systems, in canonical order', () => {
    expect(buildUnlockPlan(['whiteBalance', 'focus'])).toEqual([
      { system: 'focus', constraints: { focusMode: 'continuous' } },
      { system: 'whiteBalance', constraints: { whiteBalanceMode: 'continuous' } },
    ]);
    expect(buildUnlockPlan([])).toEqual([]);
  });

  it('lockedSystemsFromSettings claims only attempted systems reading back manual', () => {
    const after = { focusMode: 'manual', exposureMode: 'continuous', whiteBalanceMode: 'manual' };
    expect(lockedSystemsFromSettings(after, ['focus', 'exposure', 'whiteBalance'])).toEqual([
      'focus',
      'whiteBalance',
    ]);
    // White balance reads manual but was never attempted — not claimed.
    expect(lockedSystemsFromSettings(after, ['focus'])).toEqual(['focus']);
    expect(lockedSystemsFromSettings(null, ['focus'])).toEqual([]);
    expect(lockedSystemsFromSettings({}, ['focus', 'exposure'])).toEqual([]);
  });

  it('formatLockedChip names exactly the locked systems, US spelling', () => {
    expect(formatLockedChip([])).toBeNull();
    expect(formatLockedChip(['focus', 'whiteBalance'])).toBe('Locked: Focus · Color');
    expect(formatLockedChip(['exposure'])).toBe('Locked: Exposure');
    expect(formatLockedChip(['whiteBalance', 'exposure', 'focus'])).toBe('Locked: Focus · Exposure · Color');
  });

  it('exposureLockNote fires only when a lock landed but exposure is not in it', () => {
    expect(exposureLockNote(caps, [])).toBeNull();
    expect(exposureLockNote(caps, ['exposure'])).toBeNull();
    expect(exposureLockNote(caps, ['focus', 'exposure', 'whiteBalance'])).toBeNull();
    expect(exposureLockNote(caps, ['focus', 'whiteBalance'])).toBe(EXPOSURE_LOCK_NOTE);
    expect(exposureLockNote(caps, ['focus'])).toBe("Exposure can't lock on this phone");
  });
});

describe('two-pass colour continuity', () => {
  const caps: CameraControlCaps = cameraControlCapsFromTrack(FULL_CAPS, {});

  it('extractContinuityProfile picks only the numeric colour/exposure values', () => {
    expect(
      extractContinuityProfile({
        colorTemperature: 5600,
        exposureTime: 20,
        iso: 800,
        exposureCompensation: 1,
        width: 1920,
        focusMode: 'manual',
      }),
    ).toEqual({ colorTemperature: 5600, exposureTime: 20, iso: 800, exposureCompensation: 1 });
    expect(extractContinuityProfile({ colorTemperature: 'warm' })).toEqual({});
    expect(extractContinuityProfile(null)).toEqual({});
  });

  it('buildContinuityPlan clamps pass-1 targets into the front track ranges', () => {
    const plan = buildContinuityPlan(
      { colorTemperature: 9000, exposureTime: 5000, iso: 9999, exposureCompensation: 2.6 },
      caps,
    );
    expect(plan).toEqual([
      { whiteBalanceMode: 'manual', colorTemperature: 8000 },
      { exposureMode: 'manual', exposureTime: 1000, iso: 3200 },
      { exposureCompensation: 2.5 },
    ]);
  });

  it('buildContinuityPlan skips systems the front track does not offer manually', () => {
    const frontCaps = cameraControlCapsFromTrack({
      whiteBalanceMode: ['continuous'], // no manual — WB target skipped
      exposureMode: ['manual', 'continuous'],
      iso: { min: 50, max: 1600 },
      exposureCompensation: { min: -2, max: 2, step: 1 },
    });
    expect(
      buildContinuityPlan({ colorTemperature: 5000, iso: 400, exposureCompensation: -1 }, frontCaps),
    ).toEqual([{ exposureMode: 'manual', iso: 400 }, { exposureCompensation: -1 }]);
  });

  it('buildContinuityPlan is empty when nothing transfers', () => {
    expect(buildContinuityPlan({}, caps)).toEqual([]);
    expect(buildContinuityPlan({ colorTemperature: 5000 }, NO_CAMERA_CONTROL_CAPS)).toEqual([]);
    // Compensation alone still plans — it needs no manual mode.
    expect(buildContinuityPlan({ exposureCompensation: 1 }, caps)).toEqual([{ exposureCompensation: 1 }]);
  });
});
