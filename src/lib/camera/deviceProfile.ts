/**
 * Per-device proven camera settings (R32 Phase 1).
 *
 * After a recording succeeds, the settings that ACTUALLY worked on
 * this phone — facing, negotiated size class, frame rate and the
 * recorder mimeType that constructed — are remembered in
 * localStorage. On a later session the camera prefers those proven
 * fps/mime choices when ordering its ladder, instead of re-deriving
 * them from defaults every time.
 *
 * KEYING IS COARSE ON PURPOSE: a profile is keyed by facing mode +
 * negotiated size class only. Raw deviceIds are never stored — they
 * are unstable across browsers and permission states, and a stored
 * identifier is exactly what this feature does not need.
 *
 * The (de)serialisation is pure and unit-tested; storage access goes
 * through a minimal injected shape so tests use a fake.
 *
 * $0 rule: no dependencies.
 */

import type { CaptureFacingMode, CaptureQualityChoice } from './captureQuality';
import { shouldWarnAboutDroppedFrames } from './frameDrops';

/** Negotiated size classes, from the achieved short side. */
export type CaptureShortSideClass = '2160' | '1440' | '1080' | '720' | 'low' | 'unknown';

/** One proven-settings record. Exactly the fields the camera reuses. */
export interface DeviceProfile {
  facing: CaptureFacingMode;
  shortSideClass: CaptureShortSideClass;
  fps: number;
  mimeType: string;
  /**
   * R36 WS-4 — the quality choice the last take at this profile was
   * recorded with, when the caller knew it (optional: profiles saved
   * before R36, and dual takes, may not carry one).
   */
  lastQuality?: CaptureQualityChoice;
  /**
   * R36 WS-4 — whether the last take at this profile was SMOOTH by
   * the shared drop advisory (`shouldWarnAboutDroppedFrames` — the
   * one existing threshold, reused, never a second one). Absent =
   * the last take had no drop estimate, so nothing is claimed.
   */
  lastTakeSmooth?: boolean;
  /** R36 WS-4 — the last take's measured dropped-frame count, when measured. */
  lastDroppedFrames?: number;
  /** R36 WS-4 — the last take's expected-frame count for the same window, when measured. */
  lastExpectedFrames?: number;
}

/** Map of profile key → profile, as persisted. */
export type DeviceProfileMap = Record<string, DeviceProfile>;

export const DEVICE_PROFILE_STORAGE_KEY = 'riddimroom.camera.deviceProfiles.v1';

/** The size class of an achieved short side (0 / unknown sizes → 'unknown'). */
export function shortSideClassFor(shortSide: number): CaptureShortSideClass {
  if (typeof shortSide !== 'number' || !Number.isFinite(shortSide) || shortSide <= 0) return 'unknown';
  if (shortSide >= 2000) return '2160';
  if (shortSide >= 1300) return '1440';
  if (shortSide >= 1000) return '1080';
  if (shortSide >= 700) return '720';
  return 'low';
}

const SHORT_SIDE_CLASSES: readonly string[] = ['2160', '1440', '1080', '720', 'low', 'unknown'];

/** The storage key for one profile: facing + size class. Never a deviceId. */
export function deviceProfileKey(facing: CaptureFacingMode, shortSideClass: CaptureShortSideClass): string {
  return `${facing}:${shortSideClass}`;
}

function isValidProfile(value: unknown): value is DeviceProfile {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<DeviceProfile>;
  return (
    (p.facing === 'user' || p.facing === 'environment') &&
    typeof p.shortSideClass === 'string' &&
    SHORT_SIDE_CLASSES.includes(p.shortSideClass) &&
    typeof p.fps === 'number' &&
    Number.isFinite(p.fps) &&
    p.fps > 0 &&
    typeof p.mimeType === 'string'
  );
}

const QUALITY_CHOICES: readonly string[] = ['auto', '4k', 'hd'];

/**
 * Copy the OPTIONAL R36 smoothness fields of a parsed profile,
 * keeping only well-typed values — a malformed optional field is
 * dropped on its own and never costs the (valid) core profile, so
 * stores written by older builds parse exactly as before.
 */
function optionalProfileFields(value: DeviceProfile): Partial<DeviceProfile> {
  const out: Partial<DeviceProfile> = {};
  if (typeof value.lastQuality === 'string' && QUALITY_CHOICES.includes(value.lastQuality)) {
    out.lastQuality = value.lastQuality;
  }
  if (typeof value.lastTakeSmooth === 'boolean') out.lastTakeSmooth = value.lastTakeSmooth;
  if (
    typeof value.lastDroppedFrames === 'number' &&
    Number.isFinite(value.lastDroppedFrames) &&
    value.lastDroppedFrames >= 0
  ) {
    out.lastDroppedFrames = Math.round(value.lastDroppedFrames);
  }
  if (
    typeof value.lastExpectedFrames === 'number' &&
    Number.isFinite(value.lastExpectedFrames) &&
    value.lastExpectedFrames > 0
  ) {
    out.lastExpectedFrames = Math.round(value.lastExpectedFrames);
  }
  return out;
}

/** Serialise a profile map for localStorage. Key order is insertion order (most recent last). */
export function serializeDeviceProfiles(profiles: DeviceProfileMap): string {
  return JSON.stringify(profiles);
}

/**
 * Parse a stored profile map. Anything malformed — bad JSON, a
 * non-object root, entries that fail validation, keys that do not
 * match their profile's facing + class — is dropped, never thrown:
 * a corrupt store must cost the feature, not the camera.
 */
export function parseDeviceProfiles(json: string | null | undefined): DeviceProfileMap {
  if (!json) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: DeviceProfileMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isValidProfile(value)) continue;
    if (key !== deviceProfileKey(value.facing, value.shortSideClass)) continue;
    out[key] = {
      facing: value.facing,
      shortSideClass: value.shortSideClass,
      fps: value.fps,
      mimeType: value.mimeType,
      ...optionalProfileFields(value),
    };
  }
  return out;
}

/**
 * Insert/replace a profile in a map, returning a NEW map. The entry
 * is re-inserted last so iteration order reads oldest → newest,
 * which is what `deviceProfileForFacing` relies on.
 */
export function upsertDeviceProfile(profiles: DeviceProfileMap, profile: DeviceProfile): DeviceProfileMap {
  const key = deviceProfileKey(profile.facing, profile.shortSideClass);
  const next: DeviceProfileMap = { ...profiles };
  delete next[key];
  next[key] = { ...profile };
  return next;
}

/** The exact profile for one facing + size class, or null. */
export function deviceProfileFor(
  profiles: DeviceProfileMap,
  facing: CaptureFacingMode,
  shortSideClass: CaptureShortSideClass,
): DeviceProfile | null {
  return profiles[deviceProfileKey(facing, shortSideClass)] ?? null;
}

/**
 * The most recently saved profile for a facing, any size class — the
 * lookup the camera uses at stream start, before it knows which size
 * this session will negotiate.
 */
export function deviceProfileForFacing(profiles: DeviceProfileMap, facing: CaptureFacingMode): DeviceProfile | null {
  let found: DeviceProfile | null = null;
  for (const profile of Object.values(profiles)) {
    if (profile.facing === facing) found = profile;
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* R36 WS-4 — proven-smooth outcomes + one-step-down suggestion        */
/* ------------------------------------------------------------------ */

/** A finished take's measured drop outcome — the receipt's own numbers. */
export interface TakeDropOutcome {
  droppedFrames: number;
  expectedFrames?: number | null;
}

/**
 * Return a copy of `profile` carrying one take's smoothness outcome.
 * Smoothness is judged by the EXISTING drop advisory
 * (`shouldWarnAboutDroppedFrames` from frameDrops — >2% of expected
 * or >30 absolute): a take that would earn the review advisory is
 * not smooth; one that would not is. A null/unusable outcome (the
 * tracker could not measure) CLEARS any previous verdict rather
 * than leaving a stale one standing — no measurement, no claim.
 */
export function withTakeOutcome(
  profile: DeviceProfile,
  quality: CaptureQualityChoice | null | undefined,
  outcome: TakeDropOutcome | null | undefined,
): DeviceProfile {
  const next: DeviceProfile = { ...profile };
  if (quality) next.lastQuality = quality;
  const dropped = outcome?.droppedFrames;
  if (typeof dropped !== 'number' || !Number.isFinite(dropped) || dropped < 0) {
    delete next.lastTakeSmooth;
    delete next.lastDroppedFrames;
    delete next.lastExpectedFrames;
    return next;
  }
  const expected =
    typeof outcome?.expectedFrames === 'number' && Number.isFinite(outcome.expectedFrames) && outcome.expectedFrames > 0
      ? Math.round(outcome.expectedFrames)
      : undefined;
  next.lastTakeSmooth = !shouldWarnAboutDroppedFrames(dropped, expected ?? null);
  next.lastDroppedFrames = Math.round(dropped);
  if (expected !== undefined) next.lastExpectedFrames = expected;
  else delete next.lastExpectedFrames;
  return next;
}

/**
 * The quality step directly below `quality`, or null when already
 * at the lowest step. The steps are the camera's own quality
 * choices in ladder order: '4k' and 'auto' both open the ladder at
 * 2160, so their one step down is 'hd' (the ladder pinned to 1080);
 * 'hd' is the bottom step.
 */
export function qualityStepDown(quality: CaptureQualityChoice): CaptureQualityChoice | null {
  return quality === 'hd' ? null : 'hd';
}

/** The suggestion's plain line, shown where quality is chosen. */
export const SMOOTHNESS_SUGGESTION_TEXT =
  'The last take dropped frames at this quality — the one below may record smoother.';

/** The short display name of a quality choice, for the suggestion's apply button. */
export function qualityChoiceLabel(quality: CaptureQualityChoice): string {
  switch (quality) {
    case '4k':
      return '4K';
    case 'hd':
      return 'HD';
    case 'auto':
      return 'Auto';
  }
}

export interface SmoothnessSuggestion {
  /** The quality the rough take used. */
  fromQuality: CaptureQualityChoice;
  /** The one step down the user can apply with one tap. */
  suggestedQuality: CaptureQualityChoice;
  /** `SMOOTHNESS_SUGGESTION_TEXT`, carried for the UI to render verbatim. */
  text: string;
  /** The apply button's label, naming the suggested quality. */
  applyLabel: string;
}

/**
 * The one-step-down suggestion for a facing, derived from its most
 * recently saved profile: a suggestion exists ONLY when that
 * profile's last take was measured NOT smooth and a step below its
 * quality exists. A smooth take, an unmeasured take, an unknown
 * quality, or a take already at the lowest step all yield null.
 * This is a suggestion the user sees and can ignore — nothing here
 * (or in any caller) applies it automatically.
 */
export function provenSmoothnessSuggestion(
  profiles: DeviceProfileMap,
  facing: CaptureFacingMode,
): SmoothnessSuggestion | null {
  const profile = deviceProfileForFacing(profiles, facing);
  if (!profile) return null;
  if (profile.lastTakeSmooth !== false) return null;
  if (!profile.lastQuality) return null;
  const suggested = qualityStepDown(profile.lastQuality);
  if (!suggested) return null;
  return {
    fromQuality: profile.lastQuality,
    suggestedQuality: suggested,
    text: SMOOTHNESS_SUGGESTION_TEXT,
    applyLabel: `Use ${qualityChoiceLabel(suggested)}`,
  };
}

/* ------------------------------------------------------------------ */
/* Storage (thin wrappers over the pure helpers)                       */
/* ------------------------------------------------------------------ */

/** The structural slice of `Storage` this module needs. */
export interface DeviceProfileStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** Load all stored profiles ({} when storage is missing/corrupt/unreadable). */
export function loadDeviceProfiles(storage: DeviceProfileStorage | null | undefined): DeviceProfileMap {
  if (!storage) return {};
  try {
    return parseDeviceProfiles(storage.getItem(DEVICE_PROFILE_STORAGE_KEY));
  } catch {
    return {};
  }
}

/** Save one proven profile. Best-effort: storage failures are swallowed. */
export function saveDeviceProfile(
  storage: DeviceProfileStorage | null | undefined,
  profile: DeviceProfile,
): void {
  if (!storage) return;
  try {
    const next = upsertDeviceProfile(loadDeviceProfiles(storage), profile);
    storage.setItem(DEVICE_PROFILE_STORAGE_KEY, serializeDeviceProfiles(next));
  } catch {
    // Private-mode / quota failures must never break recording.
  }
}
