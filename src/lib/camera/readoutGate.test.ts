import { describe, it, expect } from 'vitest';
import {
  COACH_MIN_CHANGE_MS,
  METER_INTERVAL_IDLE_MS,
  METER_INTERVAL_RECORDING_MS,
  countdownDisplayForElapsed,
  createCoachGate,
  createTransitionGate,
  meterIntervalMs,
  zebraRecomputedWhile,
} from './readoutGate';
import type { MotionLevel } from './motionCoach';

/**
 * R36 WS-4 — Phase 0 churn harness (honest proxy, NOT a device
 * measurement).
 *
 * A true mount of CameraCapture needs a camera, MediaRecorder and
 * rVFC — none exist under vitest — so the churn numbers are produced
 * by SIMULATING the sampler schedules exactly as written in the
 * component source, before vs after:
 *
 * BEFORE (source audit of the pre-R36 component):
 * - light meter: setInterval 250ms -> setLightResult EVERY tick
 * - recording coach: setInterval 250ms -> setCoachState EVERY tick
 * - record timer: setInterval 1000ms -> setRecordSeconds EVERY tick
 * - steady-start countdown: setInterval 150ms -> setCountdownDisplay
 *   EVERY tick (countdown only)
 * - motion sampler tick (250ms): writes refs only — 0 React updates
 *   (verified in source; it never called a setter)
 * - frame-drop tracker: accumulates first/last samples in a closure,
 *   estimate computed once in stop() — 0 React updates (verified)
 *
 * The legacy simulation below replays those periods arithmetically;
 * the gated simulation drives the REAL gate functions in this module
 * with synthetic sample streams at the real tick rates. Both count
 * "React state updates into CameraCapture per second".
 */
const LEGACY_PERIODS_MS = {
  lightMeter: 250,
  coach: 250,
  recordTimer: 1000,
  countdown: 150,
} as const;

function legacyUpdatesPerSecond(source: keyof typeof LEGACY_PERIODS_MS): number {
  return 1000 / LEGACY_PERIODS_MS[source];
}

describe('Phase 0 — legacy churn (simulated from source periods)', () => {
  it('idle preview: the light meter alone drove 4 React updates/sec', () => {
    // Idle = warmed-up single-camera preview, not recording, no
    // countdown. Only the light meter fires setters (motion sampler
    // is refs-only and only runs while recording/countdown anyway).
    expect(legacyUpdatesPerSecond('lightMeter')).toBe(4);
  });

  it('recording: light 4/s + coach 4/s + timer 1/s = 9 React updates/sec', () => {
    const total =
      legacyUpdatesPerSecond('lightMeter') +
      legacyUpdatesPerSecond('coach') +
      legacyUpdatesPerSecond('recordTimer');
    expect(total).toBe(9);
  });

  it('countdown: the display setter fired ~6.7/sec on a 150ms interval', () => {
    expect(legacyUpdatesPerSecond('countdown')).toBeCloseTo(6.67, 1);
  });
});

describe('createTransitionGate', () => {
  it('accepts the first value and only true transitions after', () => {
    const gate = createTransitionGate<string>();
    expect(gate.push('good')).toBe(true);
    expect(gate.push('good')).toBe(false);
    expect(gate.push('too-dark')).toBe(true);
    expect(gate.push('too-dark')).toBe(false);
    expect(gate.current()).toBe('too-dark');
    gate.reset();
    expect(gate.push('too-dark')).toBe(true);
  });
});

describe('createCoachGate — hysteresis + 500ms cap', () => {
  it('a single-sample blip never changes the pill', () => {
    const gate = createCoachGate();
    expect(gate.push('steady', 0)).toBeUndefined(); // candidate 1
    expect(gate.push('steady', 250)?.text).toBe('Smooth'); // candidate 2 -> change
    expect(gate.push('shaky', 500)).toBeUndefined(); // blip starts
    expect(gate.push('steady', 750)).toBeUndefined(); // back to displayed: blip forgotten
    expect(gate.displayedLevel()).toBe('steady');
  });

  it('a persistent new level changes the pill only after two samples AND 500ms', () => {
    const gate = createCoachGate();
    gate.push('steady', 0);
    expect(gate.push('steady', 250)?.text).toBe('Smooth');
    // 'shaky' persists, but the last visible change was at 250ms.
    expect(gate.push('shaky', 300)).toBeUndefined(); // count 1
    expect(gate.push('shaky', 400)).toBeUndefined(); // count 2 but <500ms since change
    expect(gate.push('shaky', 800)?.text).toBe('Too shaky'); // released once 500ms passed
    expect(800 - 250).toBeGreaterThanOrEqual(COACH_MIN_CHANGE_MS);
  });

  it('unknown persisting across the window hides the pill (null, not a state)', () => {
    const gate = createCoachGate();
    gate.push('steady', 0);
    gate.push('steady', 250);
    expect(gate.push('unknown', 1000)).toBeUndefined();
    expect(gate.push('unknown', 1250)).toBeNull();
    expect(gate.displayedLevel()).toBe('unknown');
  });

  it('reset makes the next persistent level a fresh first change', () => {
    const gate = createCoachGate();
    gate.push('shaky', 0);
    gate.push('shaky', 250);
    gate.reset();
    expect(gate.push('moving', 300)).toBeUndefined();
    expect(gate.push('moving', 550)?.text).toBe('Slow down');
  });
});

describe('countdownDisplayForElapsed', () => {
  it('shows 3, then 2, then 1 — and the digit changes at most once a second', () => {
    expect(countdownDisplayForElapsed(0)).toBe(3);
    expect(countdownDisplayForElapsed(999)).toBe(3);
    expect(countdownDisplayForElapsed(1000)).toBe(2);
    expect(countdownDisplayForElapsed(1999)).toBe(2);
    expect(countdownDisplayForElapsed(2000)).toBe(1);
    expect(countdownDisplayForElapsed(3000)).toBe(1);
    expect(countdownDisplayForElapsed(Number.NaN)).toBe(3);
  });
});

describe('meter schedule', () => {
  it('full rate idle, at most 1/sec while recording, zebra paused while recording', () => {
    expect(meterIntervalMs(false)).toBe(METER_INTERVAL_IDLE_MS);
    expect(METER_INTERVAL_IDLE_MS).toBe(250);
    expect(meterIntervalMs(true)).toBe(METER_INTERVAL_RECORDING_MS);
    expect(METER_INTERVAL_RECORDING_MS).toBe(1000);
    expect(zebraRecomputedWhile(false)).toBe(true);
    expect(zebraRecomputedWhile(true)).toBe(false);
  });
});

describe('Phase 0/1 — gated churn simulation (real gates, synthetic streams)', () => {
  /**
   * Drive 60 seconds of simulated recording at the real tick rates:
   * - meter samples at the recording interval (1000ms), its state
   *   flipping every ~7s (a hand moving between light and shade) —
   *   React updates only on transitions.
   * - coach samples at 250ms with a level that changes every ~3s
   *   (with 1-sample blips mixed in) through the real coach gate.
   * - the record timer at 1000ms (the one legitimate per-second
   *   React update).
   * Count React updates the gated design would perform.
   */
  it('during a simulated recording, gated React updates stay at ~1/sec (the timer) plus rare transitions', () => {
    const durationMs = 60_000;
    let meterUpdates = 0;
    const meterGate = createTransitionGate<string>();
    const states = ['good', 'bright', 'good', 'too-dark', 'good', 'bright', 'good', 'good'];
    for (let t = 0; t < durationMs; t += meterIntervalMs(true)) {
      const state = states[Math.floor(t / 7000) % states.length];
      if (meterGate.push(state)) meterUpdates += 1;
    }

    let coachReactUpdates = 0; // the gated design paints the pill via DOM, so this stays 0 by construction
    const gate = createCoachGate();
    let pillPaints = 0;
    const levels: MotionLevel[] = ['steady', 'moving', 'shaky'];
    for (let t = 0; t < durationMs; t += 250) {
      // Level changes every 3s; every ~5s a one-sample blip to another level.
      let level = levels[Math.floor(t / 3000) % levels.length];
      if (t % 5000 === 1250) level = levels[(Math.floor(t / 3000) + 1) % levels.length];
      const out = gate.push(level, t);
      if (out !== undefined) pillPaints += 1;
    }
    const timerUpdates = durationMs / 1000;

    // Meter: 60 samples taken, only the handful of true state
    // transitions reach React.
    expect(meterUpdates).toBeLessThanOrEqual(10);
    expect(meterUpdates).toBeGreaterThan(0);
    // Coach: zero React updates (DOM paints only), and the paints
    // themselves are capped by hysteresis + the 500ms rule — far
    // below the legacy 240 setState calls over the same minute.
    expect(coachReactUpdates).toBe(0);
    expect(pillPaints).toBeLessThanOrEqual(20);
    expect(pillPaints).toBeGreaterThan(0);
    // Total React updates/sec into the component while recording:
    const totalPerSecond = (meterUpdates + coachReactUpdates + timerUpdates) / (durationMs / 1000);
    expect(totalPerSecond).toBeLessThanOrEqual(1.2);
    // Legacy comparison over the same minute: 9/s * 60 = 540.
    expect(
      (legacyUpdatesPerSecond('lightMeter') + legacyUpdatesPerSecond('coach') + legacyUpdatesPerSecond('recordTimer')) *
        60,
    ).toBe(540);
  });

  it('during a simulated idle preview, gated React updates are ~0/sec (transitions only)', () => {
    const meterGate = createTransitionGate<string>();
    let updates = 0;
    // 60s of idle preview at the full 250ms rate, light steady.
    for (let t = 0; t < 60_000; t += meterIntervalMs(false)) {
      if (meterGate.push('good')) updates += 1;
    }
    expect(updates).toBe(1); // the first reading only
  });

  it('the gated countdown re-renders at most once per digit (3 renders per countdown, not ~20)', () => {
    const gate = createTransitionGate<number>();
    let renders = 0;
    for (let elapsed = 0; elapsed <= 3000; elapsed += 150) {
      if (gate.push(countdownDisplayForElapsed(elapsed))) renders += 1;
    }
    expect(renders).toBe(3);
  });
});
