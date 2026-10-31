/**
 * R36 WS-4 — CameraCapture smoothness guards (source-level).
 *
 * CameraCapture cannot be mounted under vitest (it needs a real
 * camera, MediaRecorder and rVFC), so the render-churn and
 * capture-discipline guarantees are pinned here against the source,
 * in the same spirit as the copy blocklist's source scans — plus the
 * behavioural halves are unit-tested for real in
 * `lib/camera/readoutGate.test.ts` (gates + churn simulation),
 * `lib/camera/deviceProfileSmoothness.test.ts` (outcomes,
 * suggestion, receipt verdict).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const cameraSource = readFileSync(join(HERE, 'CameraCapture.tsx'), 'utf8');
const importPanelSource = readFileSync(join(HERE, 'MediaImportPanel.tsx'), 'utf8');

describe('WS-4 Phase 1 — readouts off React state', () => {
  it('no per-sample React setters remain for meter / coach / horizon', () => {
    expect(cameraSource).not.toContain('setLightResult(');
    expect(cameraSource).not.toContain('setCoachState(');
    expect(cameraSource).not.toContain('setHorizonTilt(');
    // The replacements are present: transition-gated pill state,
    // DOM-painted coach pill + level indicator, ref-held reading.
    expect(cameraSource).toContain('createTransitionGate');
    expect(cameraSource).toContain('coachPillRef');
    expect(cameraSource).toContain('levelWrapRef');
    expect(cameraSource).toContain('lightResultRef');
  });

  it('the coach goes through the hysteresis gate, not straight to the pill', () => {
    expect(cameraSource).toContain('createCoachGate');
    expect(cameraSource).toContain('coachGateRef.current.push(level, performance.now())');
  });

  it('the meter schedule is recording-aware and the zebra pauses while recording', () => {
    expect(cameraSource).toContain('meterIntervalMs(recording)');
    expect(cameraSource).toContain('zebraRecomputedWhile(recording)');
    expect(cameraSource).toContain('zebraCellRefs');
  });

  it('the countdown display is set only on digit changes', () => {
    expect(cameraSource).toContain('countdownDisplayForElapsed');
    expect(cameraSource).toContain('countdownDisplayGateRef.current.push(digit)');
  });
});

describe('WS-4 Phase 2 — capture discipline', () => {
  it('tap-focus, Lock and brightness are gated off while recording', () => {
    // Handler-level gates.
    expect(cameraSource).toContain('if (!controlCaps?.pointsOfInterest || !isReady || isRecording || pendingVideo || pendingDual) return;');
    expect(cameraSource).toContain('if (isRecordingRef.current) return;');
    // UI-level disabled states (the component’s existing pattern).
    const lockButton = cameraSource.slice(cameraSource.indexOf('Lock focus & light') - 600, cameraSource.indexOf('Lock focus & light'));
    expect(lockButton).toContain('disabled={isRecording}');
    const exposureInput = cameraSource.slice(
      cameraSource.indexOf('aria-label="Exposure compensation"') - 700,
      cameraSource.indexOf('aria-label="Exposure compensation"'),
    );
    expect(exposureInput).toContain('disabled={isRecording}');
  });

  it('the ramped zoom stays available during a take (one of the two allowed applies)', () => {
    const zoomInput = cameraSource.slice(
      cameraSource.indexOf('aria-label="Camera zoom"') - 700,
      cameraSource.indexOf('aria-label="Camera zoom"'),
    );
    expect(zoomInput).not.toContain('disabled={');
    // The torch toggle carries no recording gate either.
    const torchButton = cameraSource.slice(cameraSource.indexOf('Flashlight') - 500, cameraSource.indexOf('Flashlight'));
    expect(torchButton).not.toContain('disabled={isRecording}');
  });

  it('the automatic two-step continuity apply cannot land mid-take', () => {
    expect(cameraSource).toContain("phase === 'step2-live' && continuityProfileRef.current && !isRecordingRef.current");
  });

  it('the dual rear raise is still awaited before the dual recorders are created', () => {
    const raiseIdx = cameraSource.indexOf('await tryRaiseRearResolution');
    const recorderIdx = cameraSource.indexOf('const rearRecorder = createRecorder');
    expect(raiseIdx).toBeGreaterThan(-1);
    expect(recorderIdx).toBeGreaterThan(raiseIdx);
  });
});

describe('WS-4 — overlayOnly review (from WS-1)', () => {
  it('CameraCapture declares the prop and the single "Add as PiP" primary action', () => {
    expect(cameraSource).toContain('overlayOnly?: boolean');
    expect(cameraSource).toContain('Add as PiP');
    // The default review is untouched: both standard actions remain.
    expect(cameraSource).toContain('Add to timeline');
    expect(cameraSource).toContain('Use as Overlay (PiP)');
  });

  it('MediaImportPanel passes overlayOnly exactly in PiP camera mode', () => {
    expect(importPanelSource).toContain('overlayOnly={cameraForPip}');
  });
});

describe('R40 P-38/P-39 — zebra first paint + level remount paint (source-level)', () => {
  it('the zebra grid is kept in a ref and cells paint from it on mount and on toggle', () => {
    expect(cameraSource).toContain('lastZebraCellsRef');
    expect(cameraSource).toContain('lastZebraCellsRef.current = [...result.zebraCells]');
    expect(cameraSource).toContain('paintZebraCell(el, i)');
    expect(cameraSource).toContain('zebraCellRefs.current.forEach((cell, i) => paintZebraCell(cell, i))');
  });

  it('the last tilt is kept in a ref and the remounted level wrap paints it immediately', () => {
    expect(cameraSource).toContain('lastTiltRef');
    expect(cameraSource).toContain('lastTiltRef.current = tilt');
    expect(cameraSource).toContain('if (tilt !== null) paintLevel(tilt)');
  });

  it('the pair-placement verb on the camera review is "Add as a pair" — "Add both" is nowhere', () => {
    expect(cameraSource).toContain('Add as a pair');
    expect(cameraSource).not.toContain('Add both');
  });
});

describe('WS-4 — proven-smooth suggestion surface', () => {
  it('the suggestion renders where quality is chosen and applies only on tap', () => {
    expect(cameraSource).toContain('provenSmoothnessSuggestion');
    expect(cameraSource).toContain('profileSuggestion.text');
    expect(cameraSource).toContain('setQualityChoice(profileSuggestion.suggestedQuality)');
    // Takes record their outcome onto the profile at stop.
    expect(cameraSource).toContain('withTakeOutcome');
  });
});
