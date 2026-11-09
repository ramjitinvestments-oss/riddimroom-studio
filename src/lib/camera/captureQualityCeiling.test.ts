import { describe, it, expect } from 'vitest';
import {
  PROVEN_FPS_CEILING_MIN_SHORT_SIDE,
  applyProvenFpsCeiling,
  buildCaptureAttempts,
  buildCensusAwareAttempts,
  type CaptureAttempt,
} from './captureQuality';

function videoOf(attempt: CaptureAttempt): MediaTrackConstraints {
  return attempt.constraints.video as MediaTrackConstraints;
}

function directAttempt(shortSide: number, frameRate: number, isFallback = false): CaptureAttempt {
  return {
    shortSide,
    frameRate,
    isFallback,
    constraints: {
      video: {
        facingMode: 'environment',
        width: { ideal: shortSide * 2 },
        height: { ideal: shortSide },
        aspectRatio: { ideal: 2 },
        frameRate: { ideal: frameRate },
      },
      audio: true,
    },
  };
}

const AUTO_60 = () =>
  buildCaptureAttempts({ canvasWidth: 1080, canvasHeight: 1920, facingMode: 'user', quality: 'auto', frameRate: 60 });

describe('PROVEN_FPS_CEILING_MIN_SHORT_SIDE', () => {
  it('is 1440 — the floor of the high-resolution rungs', () => {
    expect(PROVEN_FPS_CEILING_MIN_SHORT_SIDE).toBe(1440);
  });
});

describe('applyProvenFpsCeiling — no-op ceilings', () => {
  it.each([null, undefined, 0, -30, Number.NaN, Number.POSITIVE_INFINITY])(
    'returns the attempts unchanged for ceiling %s',
    (ceiling) => {
      const attempts = AUTO_60();
      expect(applyProvenFpsCeiling(attempts, ceiling)).toBe(attempts);
    },
  );
});

describe('applyProvenFpsCeiling — capping', () => {
  it('caps the 2160 and 1440 rungs to the ceiling and leaves the 1080 rungs at 60', () => {
    const attempts = AUTO_60();
    const out = applyProvenFpsCeiling(attempts, 30);
    expect(out.map((a) => [a.shortSide, a.frameRate])).toEqual([
      [2160, 30],
      [1440, 30],
      [1080, 60],
      [1080, 30],
    ]);
    // The 1080 rungs pass through untouched (same objects).
    expect(out[2]).toBe(attempts[2]);
    expect(out[3]).toBe(attempts[3]);
  });

  it('the capped rungs carry { ideal: ceiling } and their width/height/aspect constraints are unchanged', () => {
    const attempts = AUTO_60();
    const out = applyProvenFpsCeiling(attempts, 30);
    for (const i of [0, 1]) {
      const before = videoOf(attempts[i]);
      const after = videoOf(out[i]);
      expect(after.frameRate).toEqual({ ideal: 30 });
      expect(after.width).toEqual(before.width);
      expect(after.height).toEqual(before.height);
      expect(after.aspectRatio).toEqual(before.aspectRatio);
      expect(after.facingMode).toBe(before.facingMode);
      expect(out[i].constraints.audio).toBe(true);
      expect(out[i]).not.toBe(attempts[i]);
    }
  });

  it('never raises any fps: a ceiling of 60 on a 30 ladder changes nothing', () => {
    const ladder30 = buildCaptureAttempts({
      canvasWidth: 1920,
      canvasHeight: 1080,
      facingMode: 'environment',
      quality: 'auto',
      frameRate: 30,
    });
    const out = applyProvenFpsCeiling(ladder30, 60);
    expect(out).toEqual(ladder30);
    expect(out.every((a) => a.frameRate === 30)).toBe(true);
  });

  it('a ceiling at/above every rung frame rate leaves the ladder equal', () => {
    const attempts = AUTO_60();
    expect(applyProvenFpsCeiling(attempts, 60)).toEqual(attempts);
  });

  it('dedups identical (shortSide, frameRate) pairs keeping the first occurrence', () => {
    const first = directAttempt(2160, 60);
    const dupe = directAttempt(2160, 30);
    const other = directAttempt(1440, 60);
    const out = applyProvenFpsCeiling([first, dupe, other], 30);
    expect(out.map((a) => [a.shortSide, a.frameRate])).toEqual([
      [2160, 30],
      [1440, 30],
    ]);
    // The kept 2160 rung is the capped copy of the FIRST occurrence.
    expect(videoOf(out[0]).width).toEqual({ ideal: 4320 });
  });

  it('remaps isFallback so exactly the last rung is the fallback', () => {
    const out = applyProvenFpsCeiling(AUTO_60(), 30);
    expect(out.map((a) => a.isFallback)).toEqual([false, false, false, true]);
    const deduped = applyProvenFpsCeiling([directAttempt(2160, 60, true), directAttempt(1440, 60)], 30);
    expect(deduped.map((a) => a.isFallback)).toEqual([false, true]);
  });

  it('caps a rung at exactly 1440 and leaves a 1439 rung alone', () => {
    const at1440 = directAttempt(1440, 60);
    // Already the fallback, so the isFallback remap leaves it untouched too.
    const below = directAttempt(1439, 60, true);
    const out = applyProvenFpsCeiling([at1440, below], 30);
    expect(out[0].frameRate).toBe(30);
    expect(out[1]).toBe(below);
    expect(out[1].frameRate).toBe(60);
  });
});

describe('applyProvenFpsCeiling — composition after census shaping', () => {
  const censusOpts = { canvasWidth: 1080, canvasHeight: 1920, facingMode: 'user' as const, quality: 'auto' as const, frameRate: 60 as const };

  it('census cap 48 + proven ceiling 30 → the opening rung asks 30 (the min)', () => {
    const censusShaped = buildCensusAwareAttempts(censusOpts, { widthMax: 3840, heightMax: 2160, frameRateMax: 48 });
    expect(censusShaped[0].frameRate).toBe(48);
    const out = applyProvenFpsCeiling(censusShaped, 30);
    expect(out[0].shortSide).toBe(2160);
    expect(out[0].frameRate).toBe(30);
  });

  it('census cap 30 + proven ceiling 48 → the opening rung stays at the census 30 (never raised)', () => {
    const censusShaped = buildCensusAwareAttempts(censusOpts, { widthMax: 3840, heightMax: 2160, frameRateMax: 30 });
    expect(censusShaped[0].frameRate).toBe(30);
    const out = applyProvenFpsCeiling(censusShaped, 48);
    expect(out[0].frameRate).toBe(30);
    // The 1440 rung the census left at 60 is capped to the proven 48.
    const rung1440 = out.find((a) => a.shortSide === 1440);
    expect(rung1440?.frameRate).toBe(48);
  });

  it('without a proven ceiling the census-shaped ladder is untouched', () => {
    const censusShaped = buildCensusAwareAttempts(censusOpts, { widthMax: 3840, heightMax: 2160, frameRateMax: 48 });
    expect(applyProvenFpsCeiling(censusShaped, null)).toBe(censusShaped);
  });
});
