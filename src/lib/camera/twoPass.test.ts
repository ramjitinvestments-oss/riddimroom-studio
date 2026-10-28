import { describe, it, expect } from 'vitest';
import {
  TWO_PASS_BUTTON_LABEL,
  TWO_PASS_STEP1_HEADING,
  TWO_PASS_STEP2_HEADING,
  TWO_PASS_STEP2_TIP,
  TWO_PASS_WHY_LINE,
  initialTwoPassState,
  transitionTwoPass,
  twoPassStartDeltaMs,
  type TwoPassState,
} from './twoPass';

const mainBlob = new Blob(['main'], { type: 'video/webm' });
const frontBlob = new Blob(['front'], { type: 'video/webm' });

/** Drive the machine into step1-review with a stored main take. */
function stateInStep1Review(): TwoPassState {
  const entered = transitionTwoPass(initialTwoPassState, { type: 'enter', viaDualFallback: false });
  return transitionTwoPass(entered, { type: 'step1-recorded', blob: mainBlob });
}

/** Drive the machine into step2-review with both takes + a delta stored. */
function stateInStep2Review(): TwoPassState {
  const step2Live = transitionTwoPass(stateInStep1Review(), { type: 'keep-step1' });
  return transitionTwoPass(step2Live, { type: 'step2-recorded', blob: frontBlob, startDeltaMs: -60 });
}

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

describe('copy constants', () => {
  it('has the exact step headings', () => {
    expect(TWO_PASS_STEP1_HEADING).toBe('Step 1 of 2 — record your main video');
    expect(TWO_PASS_STEP2_HEADING).toBe('Step 2 of 2 — record yourself over it');
  });

  it('has the exact why line', () => {
    expect(TWO_PASS_WHY_LINE).toBe(
      "Your phone can't run both cameras at once, so we'll record in two steps — same result.",
    );
  });

  it('has the exact step-2 tip', () => {
    expect(TWO_PASS_STEP2_TIP).toBe(
      'Your main video plays with sound while you record. Tip: earbuds keep its sound out of your recording — or keep the volume low.',
    );
  });

  it('has the exact entry button label', () => {
    expect(TWO_PASS_BUTTON_LABEL).toBe('Record in two steps');
  });
});

/* ------------------------------------------------------------------ */
/* Phase machine                                                       */
/* ------------------------------------------------------------------ */

describe('transitionTwoPass', () => {
  it('starts off with no takes, no delta and no fallback flag', () => {
    expect(initialTwoPassState).toEqual({
      phase: 'off',
      mainBlob: null,
      frontBlob: null,
      startDeltaMs: 0,
      viaDualFallback: false,
    });
  });

  it('enter from off goes to step1-live with the fallback flag set (dual-banner route)', () => {
    expect(transitionTwoPass(initialTwoPassState, { type: 'enter', viaDualFallback: true })).toEqual({
      phase: 'step1-live',
      mainBlob: null,
      frontBlob: null,
      startDeltaMs: 0,
      viaDualFallback: true,
    });
  });

  it('enter from off goes to step1-live with the fallback flag clear (live-controls route)', () => {
    expect(transitionTwoPass(initialTwoPassState, { type: 'enter', viaDualFallback: false })).toEqual({
      phase: 'step1-live',
      mainBlob: null,
      frontBlob: null,
      startDeltaMs: 0,
      viaDualFallback: false,
    });
  });

  it('step1-recorded stores the main blob and moves to step1-review', () => {
    const state = stateInStep1Review();
    expect(state.phase).toBe('step1-review');
    expect(state.mainBlob).toBe(mainBlob);
    expect(state.frontBlob).toBeNull();
  });

  it('retake-step1 clears the main blob and returns to step1-live', () => {
    const state = transitionTwoPass(stateInStep1Review(), { type: 'retake-step1' });
    expect(state.phase).toBe('step1-live');
    expect(state.mainBlob).toBeNull();
  });

  it('keep-step1 preserves the main blob and moves to step2-live', () => {
    const state = transitionTwoPass(stateInStep1Review(), { type: 'keep-step1' });
    expect(state.phase).toBe('step2-live');
    expect(state.mainBlob).toBe(mainBlob);
  });

  it('step2-recorded stores the front blob and the delta, moving to step2-review', () => {
    const state = stateInStep2Review();
    expect(state.phase).toBe('step2-review');
    expect(state.mainBlob).toBe(mainBlob);
    expect(state.frontBlob).toBe(frontBlob);
    expect(state.startDeltaMs).toBe(-60);
  });

  it('retake-step2 clears the front blob and delta but KEEPS the main blob', () => {
    const state = transitionTwoPass(stateInStep2Review(), { type: 'retake-step2' });
    expect(state.phase).toBe('step2-live');
    expect(state.mainBlob).toBe(mainBlob);
    expect(state.frontBlob).toBeNull();
    expect(state.startDeltaMs).toBe(0);
  });

  it('start-over clears both takes and returns to step1-live', () => {
    const state = transitionTwoPass(stateInStep2Review(), { type: 'start-over' });
    expect(state.phase).toBe('step1-live');
    expect(state.mainBlob).toBeNull();
    expect(state.frontBlob).toBeNull();
    expect(state.startDeltaMs).toBe(0);
  });

  it('exit from step2-review returns to off with everything cleared, including the fallback flag', () => {
    const entered = transitionTwoPass(initialTwoPassState, { type: 'enter', viaDualFallback: true });
    const step1Review = transitionTwoPass(entered, { type: 'step1-recorded', blob: mainBlob });
    const step2Live = transitionTwoPass(step1Review, { type: 'keep-step1' });
    const step2Review = transitionTwoPass(step2Live, {
      type: 'step2-recorded',
      blob: frontBlob,
      startDeltaMs: -60,
    });
    expect(transitionTwoPass(step2Review, { type: 'exit' })).toEqual({
      phase: 'off',
      mainBlob: null,
      frontBlob: null,
      startDeltaMs: 0,
      viaDualFallback: false,
    });
  });

  it('keeps the fallback flag through the steps (it explains step 1 only, but is not step state)', () => {
    const entered = transitionTwoPass(initialTwoPassState, { type: 'enter', viaDualFallback: true });
    const step1Review = transitionTwoPass(entered, { type: 'step1-recorded', blob: mainBlob });
    expect(step1Review.viaDualFallback).toBe(true);
    expect(transitionTwoPass(step1Review, { type: 'retake-step1' }).viaDualFallback).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Invalid events are no-ops                                           */
/* ------------------------------------------------------------------ */

describe('transitionTwoPass invalid events', () => {
  it('keep-step1 from step1-live is a no-op (same reference)', () => {
    const entered = transitionTwoPass(initialTwoPassState, { type: 'enter', viaDualFallback: false });
    expect(transitionTwoPass(entered, { type: 'keep-step1' })).toBe(entered);
  });

  it('step2-recorded from step1-review is a no-op (same reference)', () => {
    const state = stateInStep1Review();
    expect(transitionTwoPass(state, { type: 'step2-recorded', blob: frontBlob, startDeltaMs: -10 })).toBe(state);
  });

  it('enter from step1-live is a no-op (same reference)', () => {
    const entered = transitionTwoPass(initialTwoPassState, { type: 'enter', viaDualFallback: false });
    expect(transitionTwoPass(entered, { type: 'enter', viaDualFallback: true })).toBe(entered);
  });

  it('step1-recorded from off is a no-op (same reference)', () => {
    expect(transitionTwoPass(initialTwoPassState, { type: 'step1-recorded', blob: mainBlob })).toBe(
      initialTwoPassState,
    );
  });

  it('retake-step2 from step2-live is a no-op (same reference)', () => {
    const step2Live = transitionTwoPass(stateInStep1Review(), { type: 'keep-step1' });
    expect(transitionTwoPass(step2Live, { type: 'retake-step2' })).toBe(step2Live);
  });

  it('start-over from step1-review is a no-op (same reference)', () => {
    const state = stateInStep1Review();
    expect(transitionTwoPass(state, { type: 'start-over' })).toBe(state);
  });
});

/* ------------------------------------------------------------------ */
/* Start alignment                                                     */
/* ------------------------------------------------------------------ */

describe('twoPassStartDeltaMs', () => {
  it('is negative when the recorder started 60ms BEFORE playback presented', () => {
    // recorder at t=1000, playback 'playing' at t=1060.
    expect(twoPassStartDeltaMs(1060, 1000)).toBe(-60);
  });

  it('is positive when the recorder started 80ms AFTER playback presented', () => {
    // playback 'playing' at t=1000, recorder at t=1080.
    expect(twoPassStartDeltaMs(1000, 1080)).toBe(80);
  });

  it('is zero when both started together', () => {
    expect(twoPassStartDeltaMs(1000, 1000)).toBe(0);
  });
});
