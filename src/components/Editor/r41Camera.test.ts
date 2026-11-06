/**
 * R41 WS-A/B + F02 — CameraCapture guards (source-level).
 *
 * CameraCapture cannot be mounted under vitest (real camera,
 * MediaRecorder, rVFC), so the wiring guarantees of this round are
 * pinned against the source, in the established style of
 * cameraSmoothness.test.ts. The behavioural halves are unit-tested
 * for real in lib/camera: negotiation.test.ts (the three grant
 * cases), captureReceiptNegotiation.test.ts, deviceProfileCensus.
 * test.ts, frameDropsRaw.test.ts, diagnostics.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const cameraSource = readFileSync(join(HERE, 'CameraCapture.tsx'), 'utf8');

describe('R41 F02 — every record path records with a 250ms timeslice', () => {
  it('all four record-path start calls use start(250)', () => {
    expect(cameraSource).toContain('rearRecorder.start(250)');
    expect(cameraSource).toContain('frontRecorder.start(250)');
    // Single path + two-pass step 2 both call the shared `recorder` name.
    expect(cameraSource.split('recorder.start(250)').length - 1).toBe(2);
  });

  it('no record path still calls a bare start() (the whole-take Blob)', () => {
    expect(cameraSource).not.toContain('rearRecorder.start()');
    expect(cameraSource).not.toContain('frontRecorder.start()');
    expect(cameraSource).not.toContain('recorder.start();');
    expect(cameraSource).not.toContain('recorder.start()\n');
  });

  it('chunk assembly is still the ordered append the handlers always did', () => {
    expect(cameraSource).toContain('if (e.data.size > 0) chunksRef.current.push(e.data)');
    expect(cameraSource).toContain('if (e.data.size > 0) dualChunksRef.current.rear.push(e.data)');
    expect(cameraSource).toContain('if (e.data.size > 0) dualChunksRef.current.front.push(e.data)');
    expect(cameraSource).toContain('if (e.data.size > 0) step2ChunksRef.current.push(e.data)');
  });
});

describe('R41 WS-B — two-stage negotiation wiring', () => {
  it('stream setup negotiates per rung and the census shapes the ladder', () => {
    expect(cameraSource).toContain('negotiateStreamAttempt');
    expect(cameraSource).toContain('buildCensusAwareAttempts');
    expect(cameraSource).toContain('lastNegotiationRef');
  });

  it('receipts are built with the per-take negotiation snapshot (single + step 2)', () => {
    expect(cameraSource).toContain('negotiationSnapshotForTake');
    expect(cameraSource.split('negotiationSnapshot').length - 1).toBeGreaterThanOrEqual(4);
  });

  it('the review summary area renders asked-vs-granted outside Details', () => {
    expect(cameraSource).toContain('askedVsGranted');
    expect(cameraSource).toContain('grantBelowAsked');
  });

  it('the WS-D health calls survive exactly (preserved, not regressed)', () => {
    expect(cameraSource).toContain("import { useAuth } from '../../context/AuthContext';");
    expect(cameraSource).toContain("import { recordDoorOpen, recordTakeHealthFromReceipt } from '../../lib/healthEvents';");
    expect(cameraSource).toContain('recordTakeHealthFromReceipt(pendingVideo.receipt, idToken)');
    expect(cameraSource).toContain('recordTakeHealthFromReceipt(pendingDual.mainReceipt, idToken)');
  });
});

describe('R41 WS-A — census + diagnostics wiring', () => {
  it('the census is captured at camera open and shown in the settings sheet', () => {
    expect(cameraSource).toContain('censusFromCapabilities');
    expect(cameraSource).toContain('What this phone offers');
    expect(cameraSource).toContain('CENSUS_UNAVAILABLE_TEXT');
  });

  it('the diagnostics session ships under its label, with its intro, phases and result actions', () => {
    expect(cameraSource).toContain('Check camera smoothness');
    expect(cameraSource).toContain('Start the check');
    expect(cameraSource).toContain('Download report');
    expect(cameraSource).toContain('Save the test clip');
    expect(cameraSource).toContain('Use this clip');
    expect(cameraSource).toContain('diagnosticsPhaseAt');
    expect(cameraSource).toContain('createRawFrameSeriesRecorder');
    expect(cameraSource).toContain('createLongtaskCollector');
    expect(cameraSource).toContain('buildDiagnosticsEvidencePack');
    expect(cameraSource).toContain('DIAGNOSTICS_TOTAL_SECONDS');
  });

  it('the diagnostics take goes through the normal record path (startRecording), not a side recorder', () => {
    const start = cameraSource.slice(cameraSource.indexOf('const startDiagnosticsSession'));
    expect(start.slice(0, 900)).toContain('startRecording()');
  });
});
