/**
 * Pure readout gating for the live camera (R36 WS-4 — ultra-smooth
 * cameras).
 *
 * BEFORE R36, CameraCapture's samplers called React setState on
 * every tick: the light meter at 250ms (4/s, with a canvas analysis
 * pass per tick), the recording coach at 250ms (4/s), the
 * steady-start countdown display at 150ms (~6.7/s) and the horizon
 * readout on every DeviceOrientation event — all re-rendering a
 * 2600-line component, several of them DURING a take, exactly when
 * the phone's CPU is busiest encoding video.
 *
 * This module holds the decisions that keep those readouts OFF the
 * React render path:
 * - The light pill / advice only change React state when their
 *   VALUE transitions (a 4-state pill changes rarely).
 * - The coach pill gets hysteresis: a new level must persist across
 *   two consecutive samples before the pill may change, and the
 *   visible pill changes at most once per 500ms. The pill itself is
 *   painted by direct DOM writes in the component; this gate decides
 *   WHEN a write is warranted at all.
 * - The countdown display only re-renders when the DIGIT changes.
 * - The meter's sampling schedule: full rate (250ms) before a take;
 *   while recording the pill samples at 1000ms and the zebra
 *   recomputation is paused outright (the canvas analysis pass must
 *   not run at 4Hz during a take).
 *
 * Everything here is pure and unit-tested; the component owns the
 * timers and the DOM nodes. $0 rule: no dependencies.
 */

import type { MotionCoachState, MotionLevel } from './motionCoach';
import { coachStateForLevel } from './motionCoach';

/* ------------------------------------------------------------------ */
/* Generic transition gate                                             */
/* ------------------------------------------------------------------ */

/**
 * A value-transition gate: `push` returns true only when the value
 * differs from the last accepted one. Used for the light pill state
 * and the advice line — React state is set only on transitions.
 */
export function createTransitionGate<T>(): {
  push: (value: T) => boolean;
  reset: () => void;
  current: () => T | undefined;
} {
  let has = false;
  let current: T | undefined;
  return {
    push(value: T) {
      if (has && Object.is(current, value)) return false;
      has = true;
      current = value;
      return true;
    },
    reset() {
      has = false;
      current = undefined;
    },
    current: () => current,
  };
}

/* ------------------------------------------------------------------ */
/* Coach hysteresis                                                    */
/* ------------------------------------------------------------------ */

/** Consecutive samples a new level must persist before the pill may follow it. */
export const COACH_HYSTERESIS_SAMPLES = 2;
/** Minimum ms between two VISIBLE coach-pill changes. */
export const COACH_MIN_CHANGE_MS = 500;

export interface CoachGate {
  /**
   * Feed one sampled level at `nowMs`. Returns the coach state to
   * paint when the visible pill should change NOW, or `undefined`
   * when nothing should change (same level, hysteresis not yet met,
   * or the 500ms minimum interval has not elapsed — a qualifying
   * candidate stays pending and a later push can still release it).
   * A return of `null` means "hide the pill" (level became unknown
   * and stayed that way across the hysteresis window).
   */
  push: (level: MotionLevel, nowMs: number) => MotionCoachState | null | undefined;
  /** Forget everything (recording stopped / stream stopped). */
  reset: () => void;
  /** The level the pill currently shows ('unknown' = hidden / none yet). */
  displayedLevel: () => MotionLevel;
}

export function createCoachGate(): CoachGate {
  let displayed: MotionLevel = 'unknown';
  let candidate: MotionLevel | null = null;
  let candidateCount = 0;
  let lastChangeMs = Number.NEGATIVE_INFINITY;

  return {
    push(level: MotionLevel, nowMs: number) {
      if (level === displayed) {
        candidate = null;
        candidateCount = 0;
        return undefined;
      }
      if (candidate === level) {
        candidateCount += 1;
      } else {
        candidate = level;
        candidateCount = 1;
      }
      if (candidateCount < COACH_HYSTERESIS_SAMPLES) return undefined;
      if (nowMs - lastChangeMs < COACH_MIN_CHANGE_MS) return undefined;
      displayed = level;
      candidate = null;
      candidateCount = 0;
      lastChangeMs = nowMs;
      return coachStateForLevel(level);
    },
    reset() {
      displayed = 'unknown';
      candidate = null;
      candidateCount = 0;
      lastChangeMs = Number.NEGATIVE_INFINITY;
    },
    displayedLevel: () => displayed,
  };
}

/* ------------------------------------------------------------------ */
/* Countdown display                                                   */
/* ------------------------------------------------------------------ */

/** The steady-start countdown's displayed digit for an elapsed time (3, then 2, then 1 — never 0). */
export function countdownDisplayForElapsed(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 3;
  return Math.max(1, 3 - Math.floor(elapsedMs / 1000));
}

/* ------------------------------------------------------------------ */
/* Light-meter schedule                                                */
/* ------------------------------------------------------------------ */

/** Meter sampling interval before a take — the full ~4Hz rate. */
export const METER_INTERVAL_IDLE_MS = 250;
/** Meter sampling interval DURING a take — at most once a second. */
export const METER_INTERVAL_RECORDING_MS = 1000;

/** The meter's sampling interval for the current phase. */
export function meterIntervalMs(isRecording: boolean): number {
  return isRecording ? METER_INTERVAL_RECORDING_MS : METER_INTERVAL_IDLE_MS;
}

/**
 * Whether the zebra grid is recomputed on this sample. While
 * recording the zebra is PAUSED: the grid keeps its last pre-take
 * painting (frozen, not recomputed) so no 576-cell canvas analysis
 * result churns during the take; the pill keeps sampling slowly.
 */
export function zebraRecomputedWhile(isRecording: boolean): boolean {
  return !isRecording;
}
