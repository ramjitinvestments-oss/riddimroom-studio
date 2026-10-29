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

import type { CaptureFacingMode } from './captureQuality';

/** Negotiated size classes, from the achieved short side. */
export type CaptureShortSideClass = '2160' | '1440' | '1080' | '720' | 'low' | 'unknown';

/** One proven-settings record. Exactly the fields the camera reuses. */
export interface DeviceProfile {
  facing: CaptureFacingMode;
  shortSideClass: CaptureShortSideClass;
  fps: number;
  mimeType: string;
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
