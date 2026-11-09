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

import { PROVEN_FPS_CEILING_MIN_SHORT_SIDE } from './captureQuality';
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
  /**
   * R41 WS-A — the per-facing capability census captured from this
   * facing's live track (`getCapabilities()` ranges), when one was
   * measured. Ranges only — never a deviceId.
   */
  census?: FacingCensus;
  /**
   * R41 Step 3 Rung A: the fps a high-resolution grant actually delivered
   * when a higher fps was asked and refused — learned from a completed
   * take's negotiation; absent = nothing proven.
   */
  provenFpsCeiling?: number;
}

/**
 * R41 WS-A — one facing's capability census: the RANGES the browser
 * exposes for the live track (width / height / frame rate min–max),
 * plus how many video inputs the browser listed at capture time.
 * Counts and ranges only — deviceIds are never stored, matching
 * this store's privacy posture.
 */
export interface FacingCensus {
  widthMin: number;
  widthMax: number;
  heightMin: number;
  heightMax: number;
  frameRateMin: number;
  frameRateMax: number;
  /** How many video-input devices the browser listed (a count, never ids). */
  deviceCount: number;
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

function usableRangeNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Validate + sanitise a stored census. Returns null when the shape
 * is unusable (no readable maximum at all) — a malformed census is
 * dropped on its own and never costs the core profile it rode on.
 */
export function sanitiseFacingCensus(value: unknown): FacingCensus | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Partial<FacingCensus>;
  const widthMax = usableRangeNumber(c.widthMax);
  const heightMax = usableRangeNumber(c.heightMax);
  const frameRateMax = usableRangeNumber(c.frameRateMax);
  if ((widthMax === null || widthMax <= 0) && (heightMax === null || heightMax <= 0) && (frameRateMax === null || frameRateMax <= 0)) {
    return null;
  }
  const num = (v: unknown) => {
    const n = usableRangeNumber(v);
    return n === null ? 0 : Math.round(n * 100) / 100;
  };
  return {
    widthMin: num(c.widthMin),
    widthMax: num(c.widthMax),
    heightMin: num(c.heightMin),
    heightMax: num(c.heightMax),
    frameRateMin: num(c.frameRateMin),
    frameRateMax: num(c.frameRateMax),
    deviceCount:
      typeof c.deviceCount === 'number' && Number.isFinite(c.deviceCount) && c.deviceCount >= 0
        ? Math.round(c.deviceCount)
        : 0,
  };
}

/**
 * Copy the OPTIONAL fields of a parsed profile (R36 smoothness +
 * R41 census), keeping only well-typed values — a malformed
 * optional field is dropped on its own and never costs the (valid)
 * core profile, so stores written by older builds parse exactly as
 * before.
 */
function optionalProfileFields(value: DeviceProfile): Partial<DeviceProfile> {
  const out: Partial<DeviceProfile> = {};
  const census = sanitiseFacingCensus((value as { census?: unknown }).census);
  if (census) out.census = census;
  if (
    typeof value.provenFpsCeiling === 'number' &&
    Number.isFinite(value.provenFpsCeiling) &&
    value.provenFpsCeiling > 0
  ) {
    out.provenFpsCeiling = Math.round(value.provenFpsCeiling);
  }
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
/* R41 WS-A — per-facing capability census                             */
/* ------------------------------------------------------------------ */

/** One capability value as `getCapabilities()` may expose it: a range, a bare number, or absent. */
type CapabilityRangeLike = { min?: unknown; max?: unknown } | number | undefined | null;

function rangeOf(value: CapabilityRangeLike): { min: number; max: number } {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return { min: value, max: value };
  if (value && typeof value === 'object') {
    const min = usableRangeNumber((value as { min?: unknown }).min);
    const max = usableRangeNumber((value as { max?: unknown }).max);
    return { min: min ?? 0, max: max ?? 0 };
  }
  return { min: 0, max: 0 };
}

/**
 * Build a facing census from a live track's `getCapabilities()`
 * RANGES. Returns null when the browser exposes no usable range at
 * all (no width, height or frame-rate maximum) — the honest "this
 * browser doesn't share the range" case, never a guessed census.
 * `deviceCount` is the caller's video-input COUNT (labels/count
 * only — no deviceId ever enters this shape).
 */
export function censusFromCapabilities(capabilities: unknown, deviceCount: number): FacingCensus | null {
  if (!capabilities || typeof capabilities !== 'object') return null;
  const caps = capabilities as { width?: CapabilityRangeLike; height?: CapabilityRangeLike; frameRate?: CapabilityRangeLike };
  const width = rangeOf(caps.width);
  const height = rangeOf(caps.height);
  const frameRate = rangeOf(caps.frameRate);
  if (width.max <= 0 && height.max <= 0 && frameRate.max <= 0) return null;
  return sanitiseFacingCensus({
    widthMin: width.min,
    widthMax: width.max,
    heightMin: height.min,
    heightMax: height.max,
    frameRateMin: frameRate.min,
    frameRateMax: frameRate.max,
    deviceCount:
      typeof deviceCount === 'number' && Number.isFinite(deviceCount) && deviceCount >= 0 ? Math.round(deviceCount) : 0,
  });
}

/** Count video inputs from an enumeration — the ONLY fact the census takes from it (never ids). */
export function countVideoInputs(devices: readonly { kind?: string }[] | null | undefined): number {
  if (!devices) return 0;
  return devices.filter((d) => d?.kind === 'videoinput').length;
}

/** The most recent census stored for a facing (across its size-class entries), or null. */
export function censusForFacing(profiles: DeviceProfileMap, facing: CaptureFacingMode): FacingCensus | null {
  let found: FacingCensus | null = null;
  for (const profile of Object.values(profiles)) {
    if (profile.facing === facing && profile.census) found = profile.census;
  }
  return found;
}

/** Return a copy of `profile` carrying `census` (an unusable census leaves the profile unchanged). */
export function withCensus(profile: DeviceProfile, census: FacingCensus | null | undefined): DeviceProfile {
  const clean = sanitiseFacingCensus(census);
  if (!clean) return { ...profile };
  return { ...profile, census: clean };
}

/** The plain fallback shown when the browser shares no camera ranges. */
export const CENSUS_UNAVAILABLE_TEXT =
  "This browser doesn't share the camera's full range — we'll measure it from a test recording instead";

/** The largest short side a census offers (0 when it carries no size range). */
export function censusMaxShortSideValue(census: FacingCensus | null | undefined): number {
  if (!census) return 0;
  if (census.widthMax > 0 && census.heightMax > 0) return Math.min(census.widthMax, census.heightMax);
  return Math.max(census.widthMax, census.heightMax);
}

function censusSizeWord(shortSide: number): string {
  if (shortSide >= 2000) return '4K';
  if (shortSide > 0) return `${Math.round(shortSide)}p`;
  return '';
}

/**
 * The settings sheet's plain line for one facing, e.g.
 * "Back camera: up to 4K, up to 60 frames a second". Null when the
 * census carries neither a size nor a frame-rate maximum — the
 * caller shows `CENSUS_UNAVAILABLE_TEXT` instead.
 */
export function formatCensusOfferLine(facing: CaptureFacingMode, census: FacingCensus | null | undefined): string | null {
  if (!census) return null;
  const parts: string[] = [];
  const sizeWord = censusSizeWord(censusMaxShortSideValue(census));
  if (sizeWord) parts.push(`up to ${sizeWord}`);
  if (census.frameRateMax > 0) parts.push(`up to ${Math.round(census.frameRateMax)} frames a second`);
  if (parts.length === 0) return null;
  return `${facing === 'environment' ? 'Back camera' : 'Front camera'}: ${parts.join(', ')}`;
}

/* ------------------------------------------------------------------ */
/* R41 Step 3 Rung A — proven fps ceiling                              */
/* ------------------------------------------------------------------ */

/**
 * Return a copy of `profile` carrying `ceiling` (rounded) when it is a
 * positive finite number; a null/invalid ceiling returns a copy with
 * the field deleted.
 */
export function withProvenFpsCeiling(
  profile: DeviceProfile,
  ceiling: number | null | undefined,
): DeviceProfile {
  const next: DeviceProfile = { ...profile };
  if (typeof ceiling === 'number' && Number.isFinite(ceiling) && ceiling > 0) {
    next.provenFpsCeiling = Math.round(ceiling);
  } else {
    delete next.provenFpsCeiling;
  }
  return next;
}

/**
 * The most recent proven fps ceiling stored for a facing (across its
 * size-class entries), or null. The LAST entry in iteration order for
 * that facing carrying a valid field wins (mirrors censusForFacing);
 * the field is validated on read (finite, > 0).
 */
export function provenFpsCeilingForFacing(
  profiles: DeviceProfileMap,
  facing: CaptureFacingMode,
): number | null {
  let found: number | null = null;
  for (const profile of Object.values(profiles)) {
    if (
      profile.facing === facing &&
      typeof profile.provenFpsCeiling === 'number' &&
      Number.isFinite(profile.provenFpsCeiling) &&
      profile.provenFpsCeiling > 0
    ) {
      found = Math.round(profile.provenFpsCeiling);
    }
  }
  return found;
}

/** The update a completed take's negotiation implies for the proven fps ceiling. */
export type ProvenCeilingUpdate = { kind: 'set'; ceiling: number } | { kind: 'clear' } | { kind: 'none' };

/**
 * Decide what one take's asked-vs-granted negotiation proves:
 * - below the high-resolution short side, or an unreadable grant → none;
 * - a grant below the ask at a high-resolution rung → set the granted fps;
 * - a 60+ ask fully granted → clear (the ceiling is disproven);
 * - anything else → none.
 */
export function provenCeilingUpdate(input: {
  askedShortSide: number;
  askedFps: number;
  grantedFps: number;
}): ProvenCeilingUpdate {
  const { askedShortSide, askedFps, grantedFps } = input;
  if (
    typeof askedShortSide !== 'number' ||
    !Number.isFinite(askedShortSide) ||
    askedShortSide < PROVEN_FPS_CEILING_MIN_SHORT_SIDE
  ) {
    return { kind: 'none' };
  }
  if (typeof grantedFps !== 'number' || !Number.isFinite(grantedFps) || grantedFps <= 0) {
    return { kind: 'none' };
  }
  if (grantedFps < askedFps) return { kind: 'set', ceiling: Math.round(grantedFps) };
  if (askedFps >= 60 && grantedFps >= askedFps) return { kind: 'clear' };
  return { kind: 'none' };
}

/**
 * A new map with the proven fps ceiling stripped from every entry of
 * `facing` (other facings untouched).
 */
export function withoutProvenFpsCeiling(
  profiles: DeviceProfileMap,
  facing: CaptureFacingMode,
): DeviceProfileMap {
  const next: DeviceProfileMap = { ...profiles };
  for (const [key, profile] of Object.entries(next)) {
    if (profile.facing === facing && profile.provenFpsCeiling !== undefined) {
      const copy: DeviceProfile = { ...profile };
      delete copy.provenFpsCeiling;
      next[key] = copy;
    }
  }
  return next;
}

/** The fps chips' plain advisory line for a proven ceiling. */
export function provenFpsCeilingText(ceiling: number): string {
  return `This phone's browser gives ${ceiling} at this size — asking for that directly`;
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

/**
 * R41 WS-A — persist a facing census by attaching it to that
 * facing's most recent proven profile (the profile shape carries
 * the census; see the header). Returns true when a profile existed
 * to carry it. When none exists yet, nothing is written — the
 * caller keeps the census for the session, and the next proven
 * profile saved for that facing carries it (the component's
 * save path attaches the session census). No fake "proven" profile
 * is ever invented to hold a census. Best-effort, never throws.
 */
export function saveFacingCensus(
  storage: DeviceProfileStorage | null | undefined,
  facing: CaptureFacingMode,
  census: FacingCensus | null | undefined,
): boolean {
  const clean = sanitiseFacingCensus(census);
  if (!storage || !clean) return false;
  try {
    const existing = deviceProfileForFacing(loadDeviceProfiles(storage), facing);
    if (!existing) return false;
    saveDeviceProfile(storage, withCensus(existing, clean));
    return true;
  } catch {
    return false;
  }
}

/**
 * R41 Step 3 Rung A — clear the stored proven fps ceiling for a
 * facing (a 60fps grant disproved it). Mirrors saveFacingCensus's
 * storage-wrapper pattern: load → strip → persist only if changed.
 * Best-effort: storage failures are swallowed.
 */
export function clearProvenFpsCeiling(
  storage: DeviceProfileStorage | null | undefined,
  facing: CaptureFacingMode,
): void {
  if (!storage) return;
  try {
    const existing = loadDeviceProfiles(storage);
    const hasCeiling = Object.values(existing).some(
      (profile) => profile.facing === facing && profile.provenFpsCeiling !== undefined,
    );
    if (!hasCeiling) return;
    storage.setItem(DEVICE_PROFILE_STORAGE_KEY, serializeDeviceProfiles(withoutProvenFpsCeiling(existing, facing)));
  } catch {
    // Private-mode / quota failures must never break recording.
  }
}
