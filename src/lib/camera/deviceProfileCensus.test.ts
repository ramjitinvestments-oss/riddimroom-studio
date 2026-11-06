import { describe, it, expect } from 'vitest';
import {
  CENSUS_UNAVAILABLE_TEXT,
  censusForFacing,
  censusFromCapabilities,
  countVideoInputs,
  formatCensusOfferLine,
  loadDeviceProfiles,
  parseDeviceProfiles,
  saveDeviceProfile,
  saveFacingCensus,
  serializeDeviceProfiles,
  upsertDeviceProfile,
  withCensus,
  type DeviceProfile,
  type DeviceProfileStorage,
  type FacingCensus,
} from './deviceProfile';

const CENSUS_4K60: FacingCensus = {
  widthMin: 320,
  widthMax: 3840,
  heightMin: 240,
  heightMax: 2160,
  frameRateMin: 15,
  frameRateMax: 60,
  deviceCount: 3,
};

const FRONT_1080: DeviceProfile = { facing: 'user', shortSideClass: '1080', fps: 30, mimeType: 'video/mp4' };

describe('legacy v1 profiles — backward compatibility (R41 WS-A)', () => {
  it('a pre-R41 stored profile (core fields only, no census) parses EXACTLY as before', () => {
    const legacyJson =
      '{"user:1080":{"facing":"user","shortSideClass":"1080","fps":30,"mimeType":"video/mp4"},' +
      '"environment:2160":{"facing":"environment","shortSideClass":"2160","fps":60,"mimeType":"video/webm"}}';
    const parsed = parseDeviceProfiles(legacyJson);
    expect(parsed).toEqual({
      'user:1080': { facing: 'user', shortSideClass: '1080', fps: 30, mimeType: 'video/mp4' },
      'environment:2160': { facing: 'environment', shortSideClass: '2160', fps: 60, mimeType: 'video/webm' },
    });
    expect(censusForFacing(parsed, 'user')).toBeNull();
  });

  it('a legacy profile carrying an R36 smoothness outcome also parses unchanged', () => {
    const legacyJson = JSON.stringify({
      'environment:2160': {
        facing: 'environment',
        shortSideClass: '2160',
        fps: 60,
        mimeType: 'video/mp4',
        lastQuality: '4k',
        lastTakeSmooth: false,
        lastDroppedFrames: 50,
        lastExpectedFrames: 900,
      },
    });
    const parsed = parseDeviceProfiles(legacyJson);
    expect(parsed['environment:2160'].lastTakeSmooth).toBe(false);
    expect(parsed['environment:2160'].census).toBeUndefined();
  });
});

describe('census on the profile shape', () => {
  it('round-trips through serialise/parse and is found per facing', () => {
    const withIt = withCensus(FRONT_1080, CENSUS_4K60);
    expect(withIt.census).toEqual(CENSUS_4K60);
    const map = upsertDeviceProfile({}, withIt);
    const parsed = parseDeviceProfiles(serializeDeviceProfiles(map));
    expect(parsed).toEqual(map);
    expect(censusForFacing(parsed, 'user')).toEqual(CENSUS_4K60);
    expect(censusForFacing(parsed, 'environment')).toBeNull();
  });

  it('never stores a deviceId: a census input carrying one is stripped by the shape', () => {
    const dirty = { ...CENSUS_4K60, deviceId: 'secret-id-123' } as FacingCensus & { deviceId: string };
    const saved = serializeDeviceProfiles(upsertDeviceProfile({}, withCensus(FRONT_1080, dirty)));
    expect(saved).not.toContain('deviceId');
    expect(saved).not.toContain('secret-id-123');
    expect(Object.keys(JSON.parse(saved)['user:1080'].census).sort()).toEqual([
      'deviceCount',
      'frameRateMax',
      'frameRateMin',
      'heightMax',
      'heightMin',
      'widthMax',
      'widthMin',
    ]);
  });

  it('a malformed census is dropped on its own — the core profile survives', () => {
    const json = JSON.stringify({
      'user:1080': { ...FRONT_1080, census: { widthMax: 'huge', frameRateMax: -1 } },
      'environment:2160': {
        facing: 'environment',
        shortSideClass: '2160',
        fps: 60,
        mimeType: 'video/webm',
        census: 'not-an-object',
      },
    });
    const parsed = parseDeviceProfiles(json);
    expect(parsed['user:1080']).toEqual(FRONT_1080);
    expect(parsed['environment:2160'].fps).toBe(60);
    expect(parsed['environment:2160'].census).toBeUndefined();
  });
});

describe('censusFromCapabilities', () => {
  it('reads width/height/frameRate RANGES from a Chrome-shaped capabilities object', () => {
    const census = censusFromCapabilities(
      {
        width: { min: 320, max: 3840, step: 1 },
        height: { min: 240, max: 2160 },
        frameRate: { min: 15, max: 60 },
      },
      3,
    );
    expect(census).toEqual(CENSUS_4K60);
  });

  it('accepts bare-number capabilities and returns null when no range is exposed at all', () => {
    expect(censusFromCapabilities({ width: 1920, height: 1080, frameRate: 30 }, 1)?.widthMax).toBe(1920);
    expect(censusFromCapabilities({}, 2)).toBeNull();
    expect(censusFromCapabilities(null, 2)).toBeNull();
    expect(censusFromCapabilities({ zoom: { min: 1, max: 4 } }, 2)).toBeNull();
  });

  it('countVideoInputs counts video inputs only (labels/count, never ids)', () => {
    expect(
      countVideoInputs([
        { kind: 'videoinput' },
        { kind: 'audioinput' },
        { kind: 'videoinput' },
        { kind: 'audiooutput' },
      ]),
    ).toBe(2);
    expect(countVideoInputs(null)).toBe(0);
    expect(countVideoInputs([])).toBe(0);
  });
});

describe('formatCensusOfferLine + fallback', () => {
  it('reads in plain words per facing', () => {
    expect(formatCensusOfferLine('environment', CENSUS_4K60)).toBe('Back camera: up to 4K, up to 60 frames a second');
    expect(formatCensusOfferLine('user', { ...CENSUS_4K60, widthMax: 1920, heightMax: 1080, frameRateMax: 30 })).toBe(
      'Front camera: up to 1080p, up to 30 frames a second',
    );
  });

  it('null census → null line, and the fallback text is the honest one', () => {
    expect(formatCensusOfferLine('user', null)).toBeNull();
    expect(CENSUS_UNAVAILABLE_TEXT).toBe(
      "This browser doesn't share the camera's full range — we'll measure it from a test recording instead",
    );
  });
});

describe('saveFacingCensus — storage', () => {
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

  it('attaches the census to the facing most recent proven profile', () => {
    const storage = fakeStorage();
    saveDeviceProfile(storage, FRONT_1080);
    expect(saveFacingCensus(storage, 'user', CENSUS_4K60)).toBe(true);
    expect(censusForFacing(loadDeviceProfiles(storage), 'user')).toEqual(CENSUS_4K60);
    // The core profile fields are untouched.
    expect(loadDeviceProfiles(storage)['user:1080'].fps).toBe(30);
  });

  it('with NO proven profile for the facing it writes nothing and invents no profile', () => {
    const storage = fakeStorage();
    expect(saveFacingCensus(storage, 'environment', CENSUS_4K60)).toBe(false);
    expect(loadDeviceProfiles(storage)).toEqual({});
    expect(() => saveFacingCensus(null, 'user', CENSUS_4K60)).not.toThrow();
    expect(saveFacingCensus(storage, 'user', null)).toBe(false);
  });
});
