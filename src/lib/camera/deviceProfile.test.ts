import { describe, it, expect } from 'vitest';
import {
  DEVICE_PROFILE_STORAGE_KEY,
  deviceProfileFor,
  deviceProfileForFacing,
  deviceProfileKey,
  loadDeviceProfiles,
  parseDeviceProfiles,
  saveDeviceProfile,
  serializeDeviceProfiles,
  shortSideClassFor,
  upsertDeviceProfile,
  type DeviceProfile,
  type DeviceProfileStorage,
} from './deviceProfile';

const FRONT_1080: DeviceProfile = { facing: 'user', shortSideClass: '1080', fps: 30, mimeType: 'video/mp4' };
const REAR_2160: DeviceProfile = { facing: 'environment', shortSideClass: '2160', fps: 60, mimeType: 'video/webm;codecs=vp9,opus' };

describe('shortSideClassFor', () => {
  it('bands the achieved short side', () => {
    expect(shortSideClassFor(2160)).toBe('2160');
    expect(shortSideClassFor(2000)).toBe('2160');
    expect(shortSideClassFor(1440)).toBe('1440');
    expect(shortSideClassFor(1300)).toBe('1440');
    expect(shortSideClassFor(1080)).toBe('1080');
    expect(shortSideClassFor(1000)).toBe('1080');
    expect(shortSideClassFor(720)).toBe('720');
    expect(shortSideClassFor(480)).toBe('low');
    expect(shortSideClassFor(0)).toBe('unknown');
    expect(shortSideClassFor(Number.NaN)).toBe('unknown');
  });
});

describe('deviceProfileKey', () => {
  it('keys coarsely by facing + size class only', () => {
    expect(deviceProfileKey('user', '1080')).toBe('user:1080');
    expect(deviceProfileKey('environment', '2160')).toBe('environment:2160');
  });
});

describe('serialisation round-trip', () => {
  it('serialises and parses back an identical map', () => {
    const map = upsertDeviceProfile(upsertDeviceProfile({}, FRONT_1080), REAR_2160);
    expect(parseDeviceProfiles(serializeDeviceProfiles(map))).toEqual(map);
  });

  it('parses empty / missing / corrupt input to an empty map, never throws', () => {
    expect(parseDeviceProfiles(null)).toEqual({});
    expect(parseDeviceProfiles(undefined)).toEqual({});
    expect(parseDeviceProfiles('')).toEqual({});
    expect(parseDeviceProfiles('not json {')).toEqual({});
    expect(parseDeviceProfiles('[1,2,3]')).toEqual({});
    expect(parseDeviceProfiles('42')).toEqual({});
  });

  it('drops malformed entries and keys that do not match their profile', () => {
    const json = JSON.stringify({
      'user:1080': FRONT_1080,
      'user:720': { facing: 'user', shortSideClass: '720', fps: 'fast', mimeType: 'video/mp4' },
      // Key says environment:2160 but the profile inside says user — inconsistent, dropped.
      'environment:2160': FRONT_1080,
      'environment:480': { facing: 'environment', shortSideClass: 'low', fps: 30, mimeType: 'video/webm' },
    });
    const parsed = parseDeviceProfiles(json);
    expect(Object.keys(parsed).sort()).toEqual(['user:1080']);
  });

  it('never carries a deviceId: the stored shape is exactly facing/class/fps/mime', () => {
    const saved = serializeDeviceProfiles(upsertDeviceProfile({}, FRONT_1080));
    expect(saved).not.toContain('deviceId');
    expect(Object.keys(JSON.parse(saved)['user:1080']).sort()).toEqual(['facing', 'fps', 'mimeType', 'shortSideClass']);
  });
});

describe('upsert + lookup', () => {
  it('replaces the same facing+class and keeps the other facing untouched', () => {
    const start = upsertDeviceProfile(upsertDeviceProfile({}, FRONT_1080), REAR_2160);
    const updated = upsertDeviceProfile(start, { ...FRONT_1080, fps: 60 });
    expect(deviceProfileFor(updated, 'user', '1080')?.fps).toBe(60);
    expect(deviceProfileFor(updated, 'environment', '2160')).toEqual(REAR_2160);
    // The input map is not mutated.
    expect(deviceProfileFor(start, 'user', '1080')?.fps).toBe(30);
  });

  it('deviceProfileForFacing returns the most recently saved profile for that facing', () => {
    let map = upsertDeviceProfile({}, FRONT_1080);
    map = upsertDeviceProfile(map, { facing: 'user', shortSideClass: '720', fps: 30, mimeType: 'video/webm' });
    map = upsertDeviceProfile(map, REAR_2160);
    expect(deviceProfileForFacing(map, 'user')?.shortSideClass).toBe('720');
    expect(deviceProfileForFacing(map, 'environment')).toEqual(REAR_2160);
    // Re-saving the older class makes IT the most recent for that facing.
    map = upsertDeviceProfile(map, FRONT_1080);
    expect(deviceProfileForFacing(map, 'user')?.shortSideClass).toBe('1080');
  });

  it('returns null for a facing with no saved profile', () => {
    expect(deviceProfileForFacing({}, 'user')).toBeNull();
    expect(deviceProfileFor(upsertDeviceProfile({}, FRONT_1080), 'environment', '1080')).toBeNull();
  });
});

describe('storage wrappers', () => {
  function fakeStorage(): DeviceProfileStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => {
        data.set(k, v);
      },
    };
  }

  it('saves under the versioned key and loads back', () => {
    const storage = fakeStorage();
    saveDeviceProfile(storage, FRONT_1080);
    expect(storage.data.has(DEVICE_PROFILE_STORAGE_KEY)).toBe(true);
    expect(loadDeviceProfiles(storage)).toEqual({ 'user:1080': FRONT_1080 });
    saveDeviceProfile(storage, REAR_2160);
    expect(deviceProfileForFacing(loadDeviceProfiles(storage), 'environment')).toEqual(REAR_2160);
  });

  it('survives missing storage and a throwing store without throwing', () => {
    expect(loadDeviceProfiles(null)).toEqual({});
    expect(loadDeviceProfiles(undefined)).toEqual({});
    const throwing: DeviceProfileStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadDeviceProfiles(throwing)).toEqual({});
    expect(() => saveDeviceProfile(throwing, FRONT_1080)).not.toThrow();
    expect(() => saveDeviceProfile(null, FRONT_1080)).not.toThrow();
  });
});
