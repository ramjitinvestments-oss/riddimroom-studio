/**
 * FINAL FIX — CameraCapture guards (source-level), in the house
 * style of r41Camera.test.ts / cameraSmoothness.test.ts.
 *
 * Part 1 pins the 1Hz in-take diet: the record-seconds tick lives
 * in the RecordClock leaf (the camera tree no longer re-renders
 * per second), the light meter does ZERO sampling during a take,
 * and the coach's frame-diff canvas work is suspended in-take.
 *
 * Part 2 pins the new-engine wiring: the settings-sheet switch
 * (the new engine is the default since its 2026-11-11 promotion;
 * Standard stays selectable), the single-path engine selection,
 * the mid-take fallback through the identical stop handling, the
 * telemetry's route into receipt + diagnostics pack, and the
 * invariant that diagnostics clips stay the selected engine's RAW
 * output (the diag branch of the stop handling returns before any
 * steadying call exists).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const cameraSource = readFileSync(join(HERE, 'CameraCapture.tsx'), 'utf8');
const recordClockSource = readFileSync(join(HERE, 'RecordClock.tsx'), 'utf8');

describe('FINAL FIX Part 1 — the record-seconds tick is a leaf', () => {
  it('CameraCapture holds no record-seconds state at all', () => {
    expect(cameraSource).not.toContain('setRecordSeconds');
    // The auto-stops are driven by the leaf's per-second callback.
    expect(cameraSource).toContain('const handleRecordSecond = useCallback(');
    expect(cameraSource).toContain('seconds >= DIAGNOSTICS_TOTAL_SECONDS');
    expect(cameraSource).toContain('seconds >= MAX_MEDIA_SECONDS');
  });

  it('the ticking displays render through RecordClock, which owns the 1s interval', () => {
    expect(cameraSource).toContain("import { RecordClock } from './RecordClock';");
    expect(cameraSource.split('<RecordClock').length - 1).toBe(2); // REC pill + diagnostics banner
    expect(recordClockSource).toContain('window.setInterval(');
    expect(recordClockSource).toContain('1000');
    expect(recordClockSource).toContain('setSeconds(secondsRef.current)');
    // The leaf renders through a render prop and never imports the
    // camera surface — the isolation is structural, not a promise.
    expect(recordClockSource).toContain('children(seconds)');
    expect(recordClockSource).not.toContain("from './CameraCapture'");
  });
});

describe('FINAL FIX Part 1 — the light meter does zero in-take sampling', () => {
  it('the meter effect returns on isRecording BEFORE any canvas or interval exists', () => {
    const meterAt = cameraSource.indexOf('light meter sampler');
    expect(meterAt).toBeGreaterThan(-1);
    const guardAt = cameraSource.indexOf('pendingDual || error) return;', meterAt);
    const stopAt = cameraSource.indexOf('if (isRecording) return;', guardAt);
    const canvasAt = cameraSource.indexOf("document.createElement('canvas')", meterAt);
    expect(guardAt).toBeGreaterThan(-1);
    expect(stopAt).toBeGreaterThan(guardAt);
    // The early return stands before the sampler's canvas is even
    // created — in-take there is no interval, no drawImage, no
    // getImageData: zero sampling work, by construction.
    expect(stopAt).toBeLessThan(canvasAt);
  });

  it("the coach's frame-diff canvas work is suspended while recording (gyro carries the take)", () => {
    expect(cameraSource).toContain('if (!isRecording && video && video.videoWidth > 0 && video.videoHeight > 0) {');
  });
});

describe('FINAL FIX Part 2 — new-engine wiring', () => {
  it('the settings sheet carries the plain-words engine switch, new engine first', () => {
    expect(cameraSource).toContain('aria-label="Capture engine"');
    expect(cameraSource).toContain('Standard');
    expect(cameraSource).toContain('New engine');
    expect(cameraSource).toContain('selectCaptureEngine');
    // The promotion removed the test framing everywhere in the
    // component — no "(test)" survives in copy or comments.
    expect(cameraSource).not.toContain('(test)');
    // The new engine leads the switch (it is the engine of
    // record); Standard follows, still selectable.
    expect(cameraSource.indexOf("selectCaptureEngine('webcodecs')")).toBeLessThan(
      cameraSource.indexOf("selectCaptureEngine('standard')"),
    );
    // The unsupported explanation is plain words, shown in the sheet.
    expect(cameraSource).toContain('isn&rsquo;t available in this browser, so the standard engine is used');
    // The probe runs when the sheet opens.
    expect(cameraSource).toContain('probeWebcodecsCapture({ width, height, fps, bitrate })');
  });

  it('the engine choice initialises from the persisted preference (whose default is the new engine)', () => {
    expect(cameraSource).toContain('loadCaptureEngineChoice(browserLocalStorage())');
  });

  it('the single path selects the new engine only when chosen, on the same negotiated stream', () => {
    expect(cameraSource).toContain("if (captureEngineRef.current === 'webcodecs') {");
    expect(cameraSource).toContain('createWebcodecsTakeRecorder(stream, {');
    expect(cameraSource).toContain("engineAttemptRef.current = 'webcodecs';");
    // Selection can never cost a take: the standard recorder is the
    // immediate fallback whenever the prototype declines.
    expect(cameraSource).toContain('if (!recorder) recorder = createRecorder(stream, provenMimeFor(facingModeRef.current));');
  });

  it('the engine record reaches the receipt and the diagnostics pack', () => {
    expect(cameraSource).toContain('const engineInfoForTake = useCallback(');
    expect(cameraSource).toContain('negotiationSnapshot, engineInfoForTake())');
    expect(cameraSource).toContain("kind: 'webcodecs' as const,");
    expect(cameraSource).toContain('framesDroppedByQueue: engineTelemetryRef.current?.framesDroppedByQueue,');
    // …and rides through the Rung B save step untouched.
    expect(cameraSource).toContain('engine: receipt.engine ?? null,');
  });

  it('a mid-take engine failure swaps to the standard recorder through the same wiring', () => {
    expect(cameraSource).toContain('const swapToStandardRecorder = () => {');
    expect(cameraSource).toContain('engineFellBackRef.current = true;');
    expect(cameraSource).toContain('current.dispose();');
    expect(cameraSource).toContain('wireRecorder(fallback);');
    // Both engines are started and stopped through the shared ref.
    expect(cameraSource).toContain('useRef<MediaRecorder | WebcodecsTakeRecorder | null>(null)');
  });

  it('diagnostics clips stay the selected engine’s RAW output — the diag branch returns before any steadying', () => {
    const wireAt = cameraSource.indexOf('const wireRecorder');
    expect(wireAt).toBeGreaterThan(-1);
    const slice = cameraSource.slice(wireAt, cameraSource.indexOf('const stopRecording', wireAt));
    const diagBranchAt = slice.indexOf('if (diagModeRef.current) {');
    const packAt = slice.indexOf('buildDiagnosticsEvidencePack({');
    const steadyAt = slice.indexOf('steadyTakeForProject(');
    expect(diagBranchAt).toBeGreaterThan(-1);
    expect(packAt).toBeGreaterThan(diagBranchAt);
    // The diagnostics stop handling (pack + held raw blob) completes
    // and returns before the project steadying call exists in the
    // same handler — for EITHER engine, the saved diagnostics clip
    // is the engine's own file, untouched.
    expect(steadyAt).toBeGreaterThan(packAt);
    expect(slice.indexOf('setDiagResult({ pack, blob')).toBeGreaterThan(packAt);
    expect(slice.indexOf('setDiagResult({ pack, blob')).toBeLessThan(steadyAt);
    // The clip download serves the held blob itself.
    const downloadAt = cameraSource.indexOf('const downloadDiagnosticsClip');
    const downloadBody = cameraSource.slice(downloadAt, downloadAt + 400);
    expect(downloadBody).toContain('downloadBlobFile(diagResult.blob,');
    expect(downloadBody).not.toContain('steady');
  });
});
