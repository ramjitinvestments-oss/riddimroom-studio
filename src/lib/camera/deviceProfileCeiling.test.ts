import { describe, it, expect } from 'vitest';
import {
  DEVICE_PROFILE_STORAGE_KEY,
  clearProvenFpsCeiling,
  loadDeviceProfiles,
  parseDeviceProfiles,
  provenCeilingUpdate,
  provenFpsCeilingForFacing,
  provenFpsCeilingText,
  saveDeviceProfile,
  serializeDeviceProfiles,
  upsertDeviceProfile,
  withProvenFpsCeiling,
  withoutProvenFpsCeiling,
  type DeviceProfile,
  type DeviceProfileMap,
  type DeviceProfileStorage,
} from './deviceProfile';

const REAR_2160: DeviceProfile = { facing: 'environment', shortSideClass: '2160', fps: 60, mimeType: 'video/mp4' };
const FRONT_1080: DeviceProfile = { facing: 'user', shortSideClass: '1080', fps: 30, mimeType: 'video/mp4' };

function fakeStorage(): DeviceProfileStorage & { data: Map<string, string>; setCalls: number } {
  const data = new Map<string, string>();
  const storage = {
    data,
    setCalls: 0,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storage.setCalls += 1;
      data.set(k, v);
    },
  };
  return storage;
}

describe('provenFpsCeiling — parse / serialise', () => {
  it('round-trips through serialise/parse with the field', () => {
    const withIt = withProvenFpsCeiling(REAR_2160, 30);
    expect(withIt.provenFpsCeiling).toBe(30);
    const map = upsertDeviceProfile({}, withIt);
    const parsed = parseDeviceProfiles(serializeDeviceProfiles(map));
    expect(parsed).toEqual(map);
    expect(parsed['environment:2160'].provenFpsCeiling).toBe(30);
  });

  it('a fractional stored ceiling is rounded on parse', () => {
    const json = JSON.stringify({ 'environment:2160': { ...REAR_2160, provenFpsCeiling: 29.6 } });
    expect(parseDeviceProfiles(json)['environment:2160'].provenFpsCeiling).toBe(30);
  });

  it('a legacy store without the field parses identically', () => {
    const legacyJson =
      '{"user:1080":{"facing":"user","shortSideClass":"1080","fps":30,"mimeType":"video/mp4"},' +
      '"environment:2160":{"facing":"environment","shortSideClass":"2160","fps":60,"mimeType":"video/webm"}}';
    const parsed = parseDeviceProfiles(legacyJson);
    expect(parsed).toEqual({
      'user:1080': { facing: 'user', shortSideClass: '1080', fps: 30, mimeType: 'video/mp4' },
      'environment:2160': { facing: 'environment', shortSideClass: '2160', fps: 60, mimeType: 'video/webm' },
    });
    expect(provenFpsCeilingForFacing(parsed, 'environment')).toBeNull();
  });

  it.each([
    ['a string', 'thirty'],
    ['zero', 0],
    ['a negative number', -30],
    ['NaN (serialised as null)', null],
  ])('a malformed ceiling (%s) drops alone, profile kept', (_label, bad) => {
    const json = JSON.stringify({ 'environment:2160': { ...REAR_2160, provenFpsCeiling: bad } });
    const parsed = parseDeviceProfiles(json);
    expect(parsed['environment:2160']).toEqual(REAR_2160);
    expect(parsed['environment:2160'].provenFpsCeiling).toBeUndefined();
  });

  it('a NaN ceiling value drops alone when the parsed object carries one', () => {
    // JSON cannot carry NaN, so exercise the sanitiser through a value
    // that JSON.stringify turns into null and through direct rounding:
    // a non-finite number is not a valid ceiling in any representation.
    const json = '{"environment:2160":{"facing":"environment","shortSideClass":"2160","fps":60,"mimeType":"video/mp4","provenFpsCeiling":null}}';
    expect(parseDeviceProfiles(json)['environment:2160'].provenFpsCeiling).toBeUndefined();
    expect(withProvenFpsCeiling(REAR_2160, Number.NaN).provenFpsCeiling).toBeUndefined();
  });
});

describe('withProvenFpsCeiling', () => {
  it('sets a rounded ceiling on a copy, leaving the input untouched', () => {
    const out = withProvenFpsCeiling(REAR_2160, 29.6);
    expect(out.provenFpsCeiling).toBe(30);
    expect(REAR_2160.provenFpsCeiling).toBeUndefined();
    expect(out).not.toBe(REAR_2160);
  });

  it('deletes the field for null / invalid ceilings', () => {
    const withIt = withProvenFpsCeiling(REAR_2160, 30);
    for (const bad of [null, undefined, 0, -24, Number.NaN, Number.POSITIVE_INFINITY] as const) {
      const out = withProvenFpsCeiling(withIt, bad);
      expect(out.provenFpsCeiling).toBeUndefined();
      expect(out.fps).toBe(60);
    }
  });
});

describe('provenFpsCeilingForFacing', () => {
  it('the LAST carrier in iteration order for that facing wins', () => {
    let map: DeviceProfileMap = {};
    map = upsertDeviceProfile(map, withProvenFpsCeiling(REAR_2160, 30));
    map = upsertDeviceProfile(map, { facing: 'environment', shortSideClass: '1440', fps: 30, mimeType: 'video/mp4' });
    // The 1440 entry carries no ceiling — the earlier carrier still stands.
    expect(provenFpsCeilingForFacing(map, 'environment')).toBe(30);
    map = upsertDeviceProfile(
      map,
      withProvenFpsCeiling({ facing: 'environment', shortSideClass: '1440', fps: 24, mimeType: 'video/mp4' }, 24),
    );
    expect(provenFpsCeilingForFacing(map, 'environment')).toBe(24);
  });

  it('ignores other facings and returns null when nothing is proven', () => {
    const map = upsertDeviceProfile({}, withProvenFpsCeiling(REAR_2160, 30));
    expect(provenFpsCeilingForFacing(map, 'user')).toBeNull();
    expect(provenFpsCeilingForFacing({}, 'environment')).toBeNull();
    expect(provenFpsCeilingForFacing(upsertDeviceProfile({}, FRONT_1080), 'user')).toBeNull();
  });

  it('validates on read: an in-memory malformed field is ignored', () => {
    const map: DeviceProfileMap = {
      'environment:2160': { ...REAR_2160, provenFpsCeiling: Number.NaN },
      'user:1080': { ...FRONT_1080, provenFpsCeiling: -5 },
    };
    expect(provenFpsCeilingForFacing(map, 'environment')).toBeNull();
    expect(provenFpsCeilingForFacing(map, 'user')).toBeNull();
  });
});

describe('provenCeilingUpdate — the learning rule', () => {
  it('sets the granted fps when a 2160 ask of 60 was granted 30', () => {
    expect(provenCeilingUpdate({ askedShortSide: 2160, askedFps: 60, grantedFps: 30 })).toEqual({
      kind: 'set',
      ceiling: 30,
    });
  });

  it('sets at exactly 1440 (the minimum high-resolution short side)', () => {
    expect(provenCeilingUpdate({ askedShortSide: 1440, askedFps: 60, grantedFps: 30 })).toEqual({
      kind: 'set',
      ceiling: 30,
    });
  });

  it('sets 24 when a 2160 ask of 60 was granted 24', () => {
    expect(provenCeilingUpdate({ askedShortSide: 2160, askedFps: 60, grantedFps: 24 })).toEqual({
      kind: 'set',
      ceiling: 24,
    });
  });

  it('is none at 1080 even when 60 was granted 30 (below the high-res floor)', () => {
    expect(provenCeilingUpdate({ askedShortSide: 1080, askedFps: 60, grantedFps: 30 })).toEqual({ kind: 'none' });
  });

  it('is none when the granted fps is unreadable (0)', () => {
    expect(provenCeilingUpdate({ askedShortSide: 2160, askedFps: 60, grantedFps: 0 })).toEqual({ kind: 'none' });
    expect(provenCeilingUpdate({ askedShortSide: 2160, askedFps: 60, grantedFps: Number.NaN })).toEqual({
      kind: 'none',
    });
  });

  it('clears when a 2160 ask of 60 was fully granted 60', () => {
    expect(provenCeilingUpdate({ askedShortSide: 2160, askedFps: 60, grantedFps: 60 })).toEqual({ kind: 'clear' });
  });

  it('is none when 30 was asked and 30 granted', () => {
    expect(provenCeilingUpdate({ askedShortSide: 2160, askedFps: 30, grantedFps: 30 })).toEqual({ kind: 'none' });
  });

  it('is none when 30 was asked and 60 granted at 2160 (no 60+ ask, so no clear)', () => {
    expect(provenCeilingUpdate({ askedShortSide: 2160, askedFps: 30, grantedFps: 60 })).toEqual({ kind: 'none' });
  });

  it('rounds a fractional granted fps on set', () => {
    expect(provenCeilingUpdate({ askedShortSide: 2160, askedFps: 60, grantedFps: 29.7 })).toEqual({
      kind: 'set',
      ceiling: 30,
    });
  });
});

describe('withoutProvenFpsCeiling', () => {
  it('strips the field from every entry of that facing only', () => {
    let map: DeviceProfileMap = {};
    map = upsertDeviceProfile(map, withProvenFpsCeiling(REAR_2160, 30));
    map = upsertDeviceProfile(
      map,
      withProvenFpsCeiling({ facing: 'environment', shortSideClass: '1440', fps: 30, mimeType: 'video/mp4' }, 30),
    );
    map = upsertDeviceProfile(map, withProvenFpsCeiling(FRONT_1080, 24));
    const out = withoutProvenFpsCeiling(map, 'environment');
    expect(out['environment:2160'].provenFpsCeiling).toBeUndefined();
    expect(out['environment:1440'].provenFpsCeiling).toBeUndefined();
    expect(out['user:1080'].provenFpsCeiling).toBe(24);
    expect(out['user:1080']).toBe(map['user:1080']);
    // Input map not mutated.
    expect(map['environment:2160'].provenFpsCeiling).toBe(30);
    expect(out).not.toBe(map);
  });
});

describe('clearProvenFpsCeiling — storage wrapper', () => {
  it('strips the facing ceiling from storage and leaves the other facing', () => {
    const storage = fakeStorage();
    saveDeviceProfile(storage, withProvenFpsCeiling(REAR_2160, 30));
    saveDeviceProfile(storage, withProvenFpsCeiling(FRONT_1080, 24));
    clearProvenFpsCeiling(storage, 'environment');
    const stored = loadDeviceProfiles(storage);
    expect(stored['environment:2160'].provenFpsCeiling).toBeUndefined();
    expect(stored['environment:2160'].fps).toBe(60);
    expect(stored['user:1080'].provenFpsCeiling).toBe(24);
    expect(storage.data.has(DEVICE_PROFILE_STORAGE_KEY)).toBe(true);
  });

  it('persists nothing when there is no ceiling to clear', () => {
    const storage = fakeStorage();
    saveDeviceProfile(storage, REAR_2160);
    const before = storage.setCalls;
    clearProvenFpsCeiling(storage, 'environment');
    expect(storage.setCalls).toBe(before);
    expect(loadDeviceProfiles(storage)).toEqual({ 'environment:2160': REAR_2160 });
  });

  it('swallows missing / throwing storage without throwing', () => {
    expect(() => clearProvenFpsCeiling(null, 'user')).not.toThrow();
    expect(() => clearProvenFpsCeiling(undefined, 'user')).not.toThrow();
    const throwing: DeviceProfileStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => clearProvenFpsCeiling(throwing, 'user')).not.toThrow();
  });
});

describe('provenFpsCeilingText', () => {
  it('renders the exact advisory line', () => {
    expect(provenFpsCeilingText(30)).toBe("This phone's browser gives 30 at this size — asking for that directly");
    expect(provenFpsCeilingText(24)).toBe("This phone's browser gives 24 at this size — asking for that directly");
  });
});
