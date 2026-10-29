import { describe, it, expect } from 'vitest';
import {
  assessMotion,
  coachStateForLevel,
  combineMotionLevels,
  createZoomRamp,
  gyroSampleFromRotationRate,
  gyroSampleMagnitude,
  horizonTiltDegrees,
  isStillEnough,
  isZoomRampDone,
  levelBubbleOffsetPx,
  loadSteadyStartEnabled,
  meanAbsFrameDiff,
  motionLevelFromFrameDiffs,
  motionLevelFromGyroSamples,
  parseSteadyStartEnabled,
  retargetZoomRamp,
  saveSteadyStartEnabled,
  serializeSteadyStartEnabled,
  zoomRampValueAt,
  STEADY_START_STORAGE_KEY,
  type GyroSample,
} from './motionCoach';

/** A window of gyro samples all at one rotationRate magnitude (on the beta axis). */
function gyroWindow(magnitude: number, count = 6): GyroSample[] {
  return Array.from({ length: count }, () => ({ alpha: 0, beta: magnitude, gamma: 0 }));
}

describe('gyroSampleFromRotationRate', () => {
  it('keeps finite axes and nulls the rest', () => {
    expect(gyroSampleFromRotationRate({ alpha: 10, beta: null, gamma: -4 })).toEqual({
      alpha: 10,
      beta: null,
      gamma: -4,
    });
    expect(gyroSampleFromRotationRate({ alpha: 'fast', beta: 3 })).toEqual({ alpha: null, beta: 3, gamma: null });
  });

  it('returns null when nothing usable is present', () => {
    expect(gyroSampleFromRotationRate(null)).toBeNull();
    expect(gyroSampleFromRotationRate(undefined)).toBeNull();
    expect(gyroSampleFromRotationRate({})).toBeNull();
    expect(gyroSampleFromRotationRate({ alpha: null, beta: null, gamma: null })).toBeNull();
    expect(gyroSampleFromRotationRate(42)).toBeNull();
  });
});

describe('gyroSampleMagnitude', () => {
  it('is the vector magnitude, null axes counting as zero', () => {
    expect(gyroSampleMagnitude({ alpha: 3, beta: 4, gamma: 0 })).toBe(5);
    expect(gyroSampleMagnitude({ alpha: null, beta: null, gamma: null })).toBe(0);
    expect(gyroSampleMagnitude({ alpha: null, beta: -6, gamma: 8 })).toBe(10);
  });
});

describe('motionLevelFromGyroSamples', () => {
  it('reads a still hand as steady (low mean, low jitter)', () => {
    const samples: GyroSample[] = [
      { alpha: 1, beta: 2, gamma: 0 },
      { alpha: 0, beta: 3, gamma: 1 },
      { alpha: 2, beta: 1, gamma: 1 },
      { alpha: 1, beta: 2, gamma: 2 },
    ];
    expect(motionLevelFromGyroSamples(samples)).toBe('steady');
  });

  it('reads an even, slow pan as moving', () => {
    expect(motionLevelFromGyroSamples(gyroWindow(30))).toBe('moving');
  });

  it('reads a fast window as shaky on mean speed alone', () => {
    expect(motionLevelFromGyroSamples(gyroWindow(80))).toBe('shaky');
  });

  it('reads an uneven window as shaky on variance even at a modest mean', () => {
    // Alternating still / jolt: mean 30 (a "pan" speed) but deviation 30 — the jolt pattern is shake.
    const samples: GyroSample[] = Array.from({ length: 6 }, (_, i) => ({
      alpha: 0,
      beta: i % 2 === 0 ? 0 : 60,
      gamma: 0,
    }));
    expect(motionLevelFromGyroSamples(samples)).toBe('shaky');
  });

  it('treats null axes as zero and needs at least two usable samples', () => {
    expect(motionLevelFromGyroSamples([])).toBe('unknown');
    expect(motionLevelFromGyroSamples([{ alpha: 1, beta: 1, gamma: 1 }])).toBe('unknown');
    expect(
      motionLevelFromGyroSamples([
        { alpha: null, beta: null, gamma: null },
        { alpha: null, beta: null, gamma: null },
      ]),
    ).toBe('unknown');
  });
});

describe('meanAbsFrameDiff', () => {
  function grayFrame(width: number, height: number, value: number): Uint8ClampedArray {
    return new Uint8ClampedArray(width * height).fill(value);
  }

  it('is 0 for identical frames and the full step for black → white', () => {
    const black = { data: grayFrame(4, 4, 0), width: 4, height: 4, format: 'gray' as const };
    const white = { data: grayFrame(4, 4, 255), width: 4, height: 4, format: 'gray' as const };
    expect(meanAbsFrameDiff(black, black)).toBe(0);
    expect(meanAbsFrameDiff(black, white)).toBe(1);
  });

  it('measures a small uniform change proportionally (rgba input)', () => {
    const mk = (v: number) => {
      const data = new Uint8ClampedArray(2 * 2 * 4);
      for (let i = 0; i < 4; i++) {
        data[i * 4] = v;
        data[i * 4 + 1] = v;
        data[i * 4 + 2] = v;
        data[i * 4 + 3] = 255;
      }
      return { data, width: 2, height: 2 };
    };
    expect(meanAbsFrameDiff(mk(100), mk(100 + 51))).toBeCloseTo(51 / 255, 6);
  });

  it('returns null for mismatched shapes or empty samples', () => {
    const a = { data: grayFrame(4, 4, 0), width: 4, height: 4, format: 'gray' as const };
    const b = { data: grayFrame(2, 2, 0), width: 2, height: 2, format: 'gray' as const };
    expect(meanAbsFrameDiff(a, b)).toBeNull();
    expect(meanAbsFrameDiff({ data: new Uint8ClampedArray(0), width: 0, height: 0 }, a)).toBeNull();
  });
});

describe('motionLevelFromFrameDiffs', () => {
  it('reads near-identical successive frames as steady', () => {
    expect(motionLevelFromFrameDiffs([0.004, 0.006, 0.005, 0.007])).toBe('steady');
  });

  it('reads a moderate even change as moving', () => {
    expect(motionLevelFromFrameDiffs([0.03, 0.032, 0.028, 0.031])).toBe('moving');
  });

  it('reads large diffs as shaky, and spiky diffs as shaky on variance', () => {
    expect(motionLevelFromFrameDiffs([0.09, 0.1, 0.08, 0.11])).toBe('shaky');
    // Mean under the shaky arm but wild swings: deviation ≈ 0.05.
    expect(motionLevelFromFrameDiffs([0.0, 0.1, 0.0, 0.1])).toBe('shaky');
  });

  it('needs at least two usable diffs', () => {
    expect(motionLevelFromFrameDiffs([])).toBe('unknown');
    expect(motionLevelFromFrameDiffs([0.01])).toBe('unknown');
    expect(motionLevelFromFrameDiffs([Number.NaN, -1])).toBe('unknown');
  });
});

describe('combineMotionLevels + assessMotion', () => {
  it('prefers the gyro whenever it has an answer', () => {
    expect(combineMotionLevels('steady', 'shaky')).toBe('steady');
    expect(combineMotionLevels('shaky', 'steady')).toBe('shaky');
  });

  it('falls back to frame-diff only when the gyro is silent', () => {
    expect(combineMotionLevels('unknown', 'moving')).toBe('moving');
    expect(combineMotionLevels('unknown', 'unknown')).toBe('unknown');
  });

  it('assessMotion reports the deciding source', () => {
    expect(assessMotion({ gyroSamples: gyroWindow(4) })).toEqual({ level: 'steady', source: 'gyro' });
    expect(assessMotion({ frameDiffs: [0.03, 0.03, 0.03] })).toEqual({ level: 'moving', source: 'frame' });
    expect(assessMotion({})).toEqual({ level: 'unknown', source: 'none' });
    expect(
      assessMotion({ gyroSamples: gyroWindow(4), frameDiffs: [0.2, 0.2, 0.2] }),
    ).toEqual({ level: 'steady', source: 'gyro' });
  });
});

describe('isStillEnough', () => {
  it('needs two consecutive steady readings at the end of the history', () => {
    expect(isStillEnough(['steady', 'steady'])).toBe(true);
    expect(isStillEnough(['moving', 'steady', 'steady'])).toBe(true);
    expect(isStillEnough(['steady'])).toBe(false);
    expect(isStillEnough(['steady', 'moving', 'steady'])).toBe(false);
    expect(isStillEnough(['steady', 'steady', 'shaky'])).toBe(false);
  });

  it('treats unknown as not steady, and honours a custom requirement', () => {
    expect(isStillEnough(['steady', 'unknown', 'steady', 'steady'])).toBe(true);
    expect(isStillEnough(['steady', 'steady', 'unknown'])).toBe(false);
    expect(isStillEnough(['shaky', 'steady'], 1)).toBe(true);
    expect(isStillEnough([], 1)).toBe(false);
  });
});

describe('coachStateForLevel', () => {
  it('maps each known level to its pill, and unknown to no pill', () => {
    expect(coachStateForLevel('steady')).toEqual({ text: 'Smooth', tone: 'good' });
    expect(coachStateForLevel('moving')).toEqual({ text: 'Slow down', tone: 'warn' });
    expect(coachStateForLevel('shaky')).toEqual({ text: 'Too shaky', tone: 'bad' });
    expect(coachStateForLevel('unknown')).toBeNull();
  });
});

describe('horizonTiltDegrees', () => {
  it('is 0 for an upright, unrolled phone (beta 90, gamma 0)', () => {
    expect(horizonTiltDegrees(90, 0)).toBeCloseTo(0, 10);
  });

  it('reduces to gamma at the upright position', () => {
    expect(horizonTiltDegrees(90, 30)).toBeCloseTo(30, 10);
    expect(horizonTiltDegrees(90, -45)).toBeCloseTo(-45, 10);
    expect(horizonTiltDegrees(90, 90)).toBeCloseTo(90, 10);
  });

  it('reads 0 for a phone lying flat — no horizon to show, no spin', () => {
    expect(horizonTiltDegrees(0, 40)).toBeCloseTo(0, 10);
    expect(horizonTiltDegrees(180, -25)).toBeCloseTo(0, 10);
  });

  it('damps the tilt between flat and upright', () => {
    const tilt = horizonTiltDegrees(45, 30);
    expect(tilt).not.toBeNull();
    expect(tilt!).toBeGreaterThan(0);
    expect(tilt!).toBeLessThan(30);
  });

  it('returns null for missing or non-finite angles', () => {
    expect(horizonTiltDegrees(null, 10)).toBeNull();
    expect(horizonTiltDegrees(90, undefined)).toBeNull();
    expect(horizonTiltDegrees(Number.NaN, 0)).toBeNull();
    expect(horizonTiltDegrees(90, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('levelBubbleOffsetPx', () => {
  it('is 0 when level, and slides against the roll', () => {
    expect(levelBubbleOffsetPx(0, 40)).toBe(0);
    expect(levelBubbleOffsetPx(90, 40)).toBe(-40);
    expect(levelBubbleOffsetPx(-90, 40)).toBe(40);
    expect(levelBubbleOffsetPx(30, 40)).toBeCloseTo(-20, 6);
  });

  it('clamps to the radius and guards bad input', () => {
    expect(Math.abs(levelBubbleOffsetPx(179, 24))).toBeLessThanOrEqual(24);
    expect(levelBubbleOffsetPx(Number.NaN, 40)).toBe(0);
    expect(levelBubbleOffsetPx(30, 0)).toBe(0);
  });
});

describe('zoom ramp maths', () => {
  it('starts exactly at from and lands exactly on to', () => {
    const ramp = createZoomRamp(1, 3, 1000, 300);
    expect(zoomRampValueAt(ramp, 999)).toBe(1);
    expect(zoomRampValueAt(ramp, 1000)).toBe(1);
    expect(zoomRampValueAt(ramp, 1300)).toBe(3);
    expect(zoomRampValueAt(ramp, 2000)).toBe(3);
  });

  it('eases: the midpoint is halfway, the first quarter is behind a linear ramp (slow start)', () => {
    const ramp = createZoomRamp(1, 3, 0, 300);
    expect(zoomRampValueAt(ramp, 150)).toBeCloseTo(2, 10);
    // smootherstep(0.25) ≈ 0.104 — a gentle start, not 0.25.
    expect(zoomRampValueAt(ramp, 75)).toBeCloseTo(1 + 2 * 0.103515625, 6);
    expect(zoomRampValueAt(ramp, 75)).toBeLessThan(1.5);
  });

  it('is monotonic across the ramp', () => {
    const ramp = createZoomRamp(1, 2.5, 0, 300);
    let prev = 1;
    for (let t = 0; t <= 300; t += 25) {
      const v = zoomRampValueAt(ramp, t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(prev).toBe(2.5);
  });

  it('retargets from the current eased value, not the old target', () => {
    const ramp = createZoomRamp(1, 3, 0, 300);
    const mid = zoomRampValueAt(ramp, 150); // 2
    const retargeted = retargetZoomRamp(ramp, 1.2, 150, 300);
    expect(retargeted.from).toBeCloseTo(mid, 10);
    expect(retargeted.to).toBe(1.2);
    expect(zoomRampValueAt(retargeted, 150)).toBeCloseTo(mid, 10);
    expect(zoomRampValueAt(retargeted, 450)).toBe(1.2);
  });

  it('reports done at/past the end, and a zero-duration ramp is an instant jump', () => {
    const ramp = createZoomRamp(1, 2, 100, 300);
    expect(isZoomRampDone(ramp, 399)).toBe(false);
    expect(isZoomRampDone(ramp, 400)).toBe(true);
    const jump = createZoomRamp(1, 2, 100, 0);
    expect(zoomRampValueAt(jump, 100)).toBe(2);
    expect(isZoomRampDone(jump, 100)).toBe(true);
  });

  it('collapses non-finite input to a safe no-op ramp', () => {
    const ramp = createZoomRamp(Number.NaN, 2, 0, 300);
    expect(ramp.from).toBe(2);
    expect(zoomRampValueAt(ramp, 150)).toBe(2);
  });
});

describe('steady-start persistence', () => {
  it('serialises and parses round-trip, defaulting ON', () => {
    expect(serializeSteadyStartEnabled(true)).toBe('1');
    expect(serializeSteadyStartEnabled(false)).toBe('0');
    expect(parseSteadyStartEnabled('1')).toBe(true);
    expect(parseSteadyStartEnabled('0')).toBe(false);
    expect(parseSteadyStartEnabled(null)).toBe(true);
    expect(parseSteadyStartEnabled(undefined)).toBe(true);
    expect(parseSteadyStartEnabled('anything-else')).toBe(true);
  });

  it('loads and saves through a storage-shaped object under the plain key', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(loadSteadyStartEnabled(storage)).toBe(true);
    saveSteadyStartEnabled(storage, false);
    expect(store.get(STEADY_START_STORAGE_KEY)).toBe('0');
    expect(loadSteadyStartEnabled(storage)).toBe(false);
    saveSteadyStartEnabled(storage, true);
    expect(loadSteadyStartEnabled(storage)).toBe(true);
  });

  it('survives missing or throwing storage, defaulting on', () => {
    expect(loadSteadyStartEnabled(null)).toBe(true);
    expect(
      loadSteadyStartEnabled({
        getItem: () => {
          throw new Error('nope');
        },
        setItem: () => {},
      }),
    ).toBe(true);
    expect(() =>
      saveSteadyStartEnabled(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error('nope');
          },
        },
        false,
      ),
    ).not.toThrow();
  });
});
