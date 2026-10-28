/**
 * Pure two-pass recording logic — the guided fallback for phones
 * that cannot run both cameras at once (R31, part 2).
 *
 * Kept separate from the capture component so the flow's phase
 * machine and its start-alignment maths are unit-testable without a
 * DOM or real cameras — same split as `dualCapture.ts` (R29/R30),
 * which this module builds on and never duplicates.
 *
 * THE SHAPE: dual recording (R29/R30) is probe-first, and on the
 * owner's Android the probe fails — the phone cannot run both
 * cameras at once in the browser. A two-pass pair is structurally
 * IDENTICAL to a dual pair (a main recording + a front overlay
 * recording + a measured start delta), so it can travel through the
 * exact same handoff (`CaptureDualResult` → `onCaptureDual` →
 * `appendDualCaptureToTimeline`) with nothing downstream changed.
 * The only difference is WHEN the two recordings are made:
 *
 *   Step 1 — record the main video (the scene), review it, keep it.
 *   Step 2 — the kept main video PLAYS BACK (with sound) full-frame
 *            while the front camera records the user reacting /
 *            performing over it. The recorder starts FIRST and the
 *            playback second, on one `performance.now()` clock, so
 *            the measured delta lines the front take up against the
 *            main take exactly as the dual path's delta does.
 *
 * This module owns ONLY the phase machine, the delta maths (a thin
 * re-export of the dual maths with two-pass semantics documented)
 * and the flow's user-facing copy. All camera, recorder and object-
 * URL handling lives in the capture component.
 *
 * $0 rule: no dependencies.
 */

import { dualStartDeltaMs } from './dualCapture';

/* ------------------------------------------------------------------ */
/* UI copy                                                             */
/* ------------------------------------------------------------------ */

/** Heading shown above the controls throughout step 1 (live + review). */
export const TWO_PASS_STEP1_HEADING = 'Step 1 of 2 — record your main video';

/** Heading shown above the controls throughout step 2 (live + review). */
export const TWO_PASS_STEP2_HEADING = 'Step 2 of 2 — record yourself over it';

/**
 * Why the flow exists, shown under the step-1 heading ONLY when the
 * user arrived here from the dual-failure banner (`viaDualFallback`)
 * — it answers the "why not both at once?" question they just hit.
 */
export const TWO_PASS_WHY_LINE =
  "Your phone can't run both cameras at once, so we'll record in two steps — same result.";

/**
 * Step-2 live tip: the main video plays WITH SOUND while the front
 * camera (and its microphone) records, so its audio can bleed into
 * the front take's recording. Earbuds (or low volume) keep the front
 * take clean; the main take's own audio is untouched either way.
 */
export const TWO_PASS_STEP2_TIP =
  'Your main video plays with sound while you record. Tip: earbuds keep its sound out of your recording — or keep the volume low.';

/** Label of the button that enters the flow from the live controls. */
export const TWO_PASS_BUTTON_LABEL = 'Record in two steps';

/* ------------------------------------------------------------------ */
/* Phase machine                                                       */
/* ------------------------------------------------------------------ */

/**
 * The flow's phases:
 * - `off`          — two-pass is not active; single/dual behaviour rules.
 * - `step1-live`   — live camera (rear by default, flip allowed),
 *                    ready to record / recording the main take.
 * - `step1-review` — the main take is held for review (the component's
 *                    existing `pendingVideo` review, branched).
 * - `step2-live`   — front camera live in the corner, the kept main
 *                    take full-frame and paused at frame 0, ready to
 *                    record / recording the front take over playback.
 * - `step2-review` — both takes held for review (the component's
 *                    existing `pendingDual` review, branched).
 */
export type TwoPassPhase = 'off' | 'step1-live' | 'step1-review' | 'step2-live' | 'step2-review';

export interface TwoPassState {
  phase: TwoPassPhase;
  /** The kept step-1 (main) recording; null until step 1 is recorded. */
  mainBlob: Blob | null;
  /** The step-2 (front) recording; null until step 2 is recorded. */
  frontBlob: Blob | null;
  /**
   * Measured start delta between step 2's recorder and its playback
   * (see `twoPassStartDeltaMs`); 0 until step 2 is recorded.
   */
  startDeltaMs: number;
  /**
   * True when the flow was entered from the dual-failure banner
   * ("Record in two steps instead") rather than the live-controls
   * button — drives the why-line under the step-1 heading.
   */
  viaDualFallback: boolean;
}

/** The state the flow starts (and `exit` returns) in. */
export const initialTwoPassState: TwoPassState = {
  phase: 'off',
  mainBlob: null,
  frontBlob: null,
  startDeltaMs: 0,
  viaDualFallback: false,
};

/**
 * Every way the flow can move. Payload-carrying events are a
 * discriminated union so a transition that needs a take (or a delta,
 * or the entry route) cannot be dispatched without it.
 */
export type TwoPassEvent =
  | { type: 'enter'; viaDualFallback: boolean }
  | { type: 'step1-recorded'; blob: Blob }
  | { type: 'retake-step1' }
  | { type: 'keep-step1' }
  | { type: 'step2-recorded'; blob: Blob; startDeltaMs: number }
  | { type: 'retake-step2' }
  | { type: 'start-over' }
  | { type: 'exit' };

/**
 * Advance the two-pass machine. An event that does not apply in the
 * current phase returns the state UNCHANGED (the same reference), so
 * stray dispatches — a double-tap, a recorder callback racing a
 * retake — are harmless no-ops instead of corrupt states.
 *
 * Take-ownership rules:
 * - `enter` starts clean: both takes and the delta are cleared, and
 *   the entry route is recorded in `viaDualFallback`.
 * - `retake-step1` drops ONLY the main take (nothing else exists yet).
 * - `keep-step1` carries the main take into step 2 untouched.
 * - `retake-step2` drops the front take and the delta but KEEPS the
 *   main take — re-recording yourself must never cost the scene.
 * - `start-over` drops both takes (and the delta) back to step 1.
 * - `exit` (from ANY phase) drops everything, including
 *   `viaDualFallback`, returning to `initialTwoPassState`.
 */
export function transitionTwoPass(state: TwoPassState, event: TwoPassEvent): TwoPassState {
  switch (event.type) {
    case 'enter':
      if (state.phase !== 'off') return state;
      return {
        phase: 'step1-live',
        mainBlob: null,
        frontBlob: null,
        startDeltaMs: 0,
        viaDualFallback: event.viaDualFallback,
      };
    case 'step1-recorded':
      if (state.phase !== 'step1-live') return state;
      return { ...state, phase: 'step1-review', mainBlob: event.blob };
    case 'retake-step1':
      if (state.phase !== 'step1-review') return state;
      return { ...state, phase: 'step1-live', mainBlob: null };
    case 'keep-step1':
      if (state.phase !== 'step1-review') return state;
      return { ...state, phase: 'step2-live' };
    case 'step2-recorded':
      if (state.phase !== 'step2-live') return state;
      return { ...state, phase: 'step2-review', frontBlob: event.blob, startDeltaMs: event.startDeltaMs };
    case 'retake-step2':
      if (state.phase !== 'step2-review') return state;
      return { ...state, phase: 'step2-live', frontBlob: null, startDeltaMs: 0 };
    case 'start-over':
      if (state.phase !== 'step2-review') return state;
      return { ...state, phase: 'step1-live', mainBlob: null, frontBlob: null, startDeltaMs: 0 };
    case 'exit':
      return { ...initialTwoPassState };
    default:
      return state;
  }
}

/* ------------------------------------------------------------------ */
/* Start alignment                                                     */
/* ------------------------------------------------------------------ */

/**
 * How far apart step 2's two starts actually were, in milliseconds —
 * the two-pass reading of `dualStartDeltaMs` (imported, not
 * duplicated: it is plain `second start − first start` maths, and
 * the timeline alignment consumes both flows' deltas identically).
 *
 * In step 2 the recorder starts FIRST, then playback is driven:
 * - `recorderStartMs` is `performance.now()` taken just after
 *   `recorder.start()` returns;
 * - `playbackStartMs` is the timestamp of the playback element's
 *   'playing' event — the moment its first frames are actually
 *   presented, NOT the moment `play()` was called (a paused element
 *   can take a while to present, and only presented frames are what
 *   the user performed against).
 *
 * The delta is therefore normally NEGATIVE (the recorder was already
 * running when the first playback frame appeared). Downstream,
 * `appendDualCaptureToTimeline` / `dualAlignmentTrims` trim the
 * FRONT take's head by |delta| — those opening milliseconds are the
 * user waiting for playback to begin, content the main take has no
 * counterpart for. The MAIN take is never trimmed, and any residual
 * sub-frame misalignment is what the timeline's "Line up the sound"
 * nudge exists for.
 */
export function twoPassStartDeltaMs(playbackStartMs: number, recorderStartMs: number): number {
  return dualStartDeltaMs(playbackStartMs, recorderStartMs);
}
