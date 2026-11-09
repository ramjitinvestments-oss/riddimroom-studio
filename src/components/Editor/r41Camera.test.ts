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
const diagnosticsSource = readFileSync(join(HERE, '../../lib/camera/diagnostics.ts'), 'utf8');
const frameDropsSource = readFileSync(join(HERE, '../../lib/camera/frameDrops.ts'), 'utf8');

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

describe('R41 Step 3 Rung A — proven fps ceiling wiring', () => {
  it('startStream gates applyProvenFpsCeiling on userFpsChoiceRef', () => {
    expect(cameraSource).toContain('applyProvenFpsCeiling');
    expect(cameraSource).toContain(
      'userFpsChoiceRef.current ? null : provenFpsCeilingForFacing(loadDeviceProfiles(browserLocalStorage()), facingMode)',
    );
    const startStream = cameraSource.slice(cameraSource.indexOf('const startStream'));
    const window = startStream.slice(0, startStream.indexOf('acquireCameraStream({'));
    expect(window).toContain('buildCensusAwareAttempts');
    expect(window).toContain('applyProvenFpsCeiling');
    // The ceiling composes AFTER (around) the census shaping.
    expect(window.indexOf('applyProvenFpsCeiling')).toBeLessThan(window.indexOf('buildCensusAwareAttempts'));
  });

  it('saveProvenProfile wraps the built profile with withProvenFpsCeiling as the outermost wrap', () => {
    expect(cameraSource).toContain('withProvenFpsCeiling');
    expect(cameraSource).toContain('ceiling?: number');
    const save = cameraSource.slice(cameraSource.indexOf('function saveProvenProfile'));
    const window = save.slice(0, save.indexOf('/** The proven recorder mime'));
    expect(window.indexOf('withProvenFpsCeiling')).toBeLessThan(window.indexOf('withCensus'));
    expect(window).toContain('opts?.ceiling');
  });

  it('both take-end save sites (single + step 2, not dual) compute provenCeilingUpdate and pass ceiling', () => {
    expect(cameraSource.split('provenCeilingUpdate').length - 1).toBeGreaterThanOrEqual(3); // import + 2 sites
    expect(cameraSource.split('const ceilingUpdate = negotiationSnapshot').length - 1).toBe(2);
    expect(cameraSource.split("ceiling: ceilingUpdate.kind === 'set' ? ceilingUpdate.ceiling : undefined").length - 1).toBe(2);
    expect(cameraSource).toContain('grantedFps(settingsSnapshot)');
    expect(cameraSource).toContain('askedShortSide: negotiationSnapshot.asked.shortSide');
    expect(cameraSource).toContain('askedFps: negotiationSnapshot.asked.frameRate');
  });

  it("a 'clear' update invokes clearProvenFpsCeiling for the facing being saved, at both sites", () => {
    expect(cameraSource.split('clearProvenFpsCeiling').length - 1).toBeGreaterThanOrEqual(3); // import + 2 sites
    expect(cameraSource).toContain(
      "if (ceilingUpdate.kind === 'clear') clearProvenFpsCeiling(browserLocalStorage(), facingModeRef.current);",
    );
    expect(cameraSource).toContain("if (ceilingUpdate.kind === 'clear') clearProvenFpsCeiling(browserLocalStorage(), 'user');");
    // The clear runs BEFORE its save at each site.
    const singleClear = cameraSource.indexOf('clearProvenFpsCeiling(browserLocalStorage(), facingModeRef.current)');
    expect(cameraSource.slice(singleClear, singleClear + 400)).toContain('saveProvenProfile(facingModeRef.current');
    const step2Clear = cameraSource.indexOf("clearProvenFpsCeiling(browserLocalStorage(), 'user')");
    expect(cameraSource.slice(step2Clear, step2Clear + 400)).toContain("saveProvenProfile('user'");
  });

  it('the fps chip onClick sets the explicit-pick state alongside the ref', () => {
    expect(cameraSource).toContain('setFpsPickedExplicitly(true)');
    const chip = cameraSource.slice(cameraSource.indexOf('userFpsChoiceRef.current = true;'));
    expect(chip.slice(0, 200)).toContain('setFpsPickedExplicitly(true)');
    expect(chip.slice(0, 200)).toContain('setFpsChoice(fps)');
  });

  it('provenFpsCeilingText is rendered under the fps chips, gated on ceiling / explicit pick / quality', () => {
    expect(cameraSource).toContain('provenFpsCeilingText(provenCeiling)');
    expect(cameraSource).toContain("provenCeiling !== null && !fpsPickedExplicitly && qualityChoice !== 'hd'");
    const fpsGroup = cameraSource.slice(cameraSource.indexOf('aria-label="Frame rate"'));
    const afterChips = fpsGroup.slice(fpsGroup.indexOf('{fps} fps'));
    expect(afterChips.slice(0, 1200)).toContain('provenFpsCeilingText(provenCeiling)');
    // The ceiling state refreshes alongside the profile suggestion.
    expect(cameraSource).toContain(
      'setProvenCeiling(provenFpsCeilingForFacing(loadDeviceProfiles(browserLocalStorage()), facingMode));',
    );
  });
});

describe('R41 Step 3 Rung A, Part 2 — in-take painter diet (F03/F04/F05)', () => {
  it('the meter skips the zebra maths while recording via computeZebra', () => {
    expect(cameraSource).toContain('computeZebra: zebraRecomputedWhile(recording)');
  });

  it('the devicemotion push is gated by motionSampleAccepted before it reaches the buffer', () => {
    expect(cameraSource).toContain('motionSampleAccepted(lastAcceptedMotionMs, nowMs, isRecording)');
    const onMotion = cameraSource.slice(cameraSource.indexOf('const onMotion'));
    const handler = onMotion.slice(0, onMotion.indexOf("window.addEventListener('devicemotion'"));
    expect(handler).toContain('motionSampleAccepted');
    expect(handler.indexOf('motionSampleAccepted')).toBeLessThan(handler.indexOf('buffer.gyro.push'));
    // The last-accepted timestamp is owned by the effect and reset on setup.
    expect(cameraSource).toContain('let lastAcceptedMotionMs = 0;');
  });

  it('both coach intervals use coachIntervalMs (sampler tick + pill)', () => {
    expect(cameraSource).toContain('window.setInterval(tick, coachIntervalMs(isRecording))');
    expect(cameraSource).toContain('}, coachIntervalMs(isRecording));');
    expect(cameraSource.split('coachIntervalMs(').length - 1).toBeGreaterThanOrEqual(3); // import-free call sites + tick + pill
  });

  it('the orientation handler suspends on isRecordingRef before any paintLevel write', () => {
    const onOrientation = cameraSource.slice(cameraSource.indexOf('const onOrientation'));
    const handler = onOrientation.slice(0, onOrientation.indexOf("window.addEventListener('deviceorientation'"));
    expect(handler).toContain('if (isRecordingRef.current) return;');
    expect(handler.indexOf('isRecordingRef.current')).toBeLessThan(handler.indexOf('paintLevel(tilt)'));
  });

  it('the pre-take countdown interval is NOT dieted (it never runs during a take)', () => {
    // The countdown effect still polls at its full 150ms rate; the
    // diet keys on isRecording only, never on countdown state.
    const countdown = cameraSource.slice(cameraSource.indexOf('countdownDisplayGateRef.current.reset()'));
    expect(countdown.slice(0, countdown.indexOf('completeCountdown();') + 200)).toContain('}, 150);');
    expect(countdown.slice(0, 900)).not.toContain('coachIntervalMs');
  });

  it('EXEMPTION — the diagnostics instruments carry no painter-diet references', () => {
    for (const source of [diagnosticsSource, frameDropsSource]) {
      expect(source).not.toContain('coachIntervalMs');
      expect(source).not.toContain('motionSampleAccepted');
      expect(source).not.toContain('computeZebra');
    }
  });

  it('EXEMPTION — the diagnostics start block still starts the longtask collector + raw recorder, ungated', () => {
    const block = cameraSource.slice(cameraSource.indexOf('const rawRecorder = createRawFrameSeriesRecorder()'));
    const startBlock = block.slice(0, block.indexOf('diagLongtaskRef.current = longtasks;') + 60);
    expect(startBlock).toContain('rawRecorder.start(videoRef.current)');
    expect(startBlock).toContain('createLongtaskCollector');
    expect(startBlock).toContain('longtasks.start()');
    expect(startBlock).not.toContain('isRecording');
    expect(startBlock).not.toContain('coachIntervalMs');
    expect(startBlock).not.toContain('motionSampleAccepted');
    expect(startBlock).not.toContain('computeZebra');
    // Normal-take frame-drop tracking is untouched.
    expect(cameraSource).toContain('beginFrameDropTracking');
  });
});

describe('R41 Step 3 (flip fix) — flip-proof stream acquisition wiring', () => {
  it('startStream acquires through acquireCameraStream with the two-stage negotiation as its seam', () => {
    expect(cameraSource).toContain('acquireCameraStream');
    expect(cameraSource).toContain('negotiate: (attempt) =>');
    expect(cameraSource).toContain('negotiateStreamAttempt');
    // The old inline walk — and its two-error-only predicate — is gone
    // from the component: contention errors no longer abort the ladder.
    expect(cameraSource).not.toContain('isLadderRetryableError');
  });

  it('startStream is generation-guarded: a superseded call stops its own stream and bows out', () => {
    expect(cameraSource).toContain('streamGenerationRef');
    expect(cameraSource).toContain('const myGeneration = ++streamGenerationRef.current;');
    expect(cameraSource).toContain('if (myGeneration !== streamGenerationRef.current) return;');
    // The superseded stream is stopped directly, never via stopStream
    // (which would kill the newer call's stream).
    expect(cameraSource).toContain('acquired.stream.getTracks().forEach((track) => {');
  });

  it('a fully-failed flip reverts to the last working facing and raises the plain-words notice', () => {
    expect(cameraSource).toContain('workingFacingRef');
    expect(cameraSource).toContain('setFlipNotice(flipFailureNoticeText(facingMode, workingFacingRef.current));');
    expect(cameraSource).toContain('setFacingMode(workingFacingRef.current);');
    // Only a successful open moves the working-facing marker.
    expect(cameraSource).toContain('workingFacingRef.current = facingMode;');
  });

  it('the flip button clears a stale notice before toggling, and the notice renders dismissibly', () => {
    const labelAt = cameraSource.indexOf('Flip camera');
    const buttonWindow = cameraSource.slice(Math.max(0, labelAt - 700), labelAt);
    expect(buttonWindow).toContain('setFlipNotice(null);');
    expect(buttonWindow).toContain("setFacingMode((m) => (m === 'user' ? 'environment' : 'user'))");
    // The notice itself renders from state with its own dismiss.
    expect(cameraSource).toContain('{flipNotice && !error && (');
    expect(cameraSource).toContain("{flipNotice}");
  });
});

describe('R41 Step 3 Rungs B + C — steadying wiring + the diagnostics-raw guarantee', () => {
  const steadyTakeSource = readFileSync(join(HERE, '../../lib/camera/steadyTake.ts'), 'utf8');

  it('every project-media save path routes its take through the steady step', () => {
    // The single-camera stop, the dual stop (BOTH takes), the
    // two-pass step-2 stop, and the diagnostics "Use this clip"
    // confirm — five call sites await the steady helper.
    expect(cameraSource).toContain("import { steadyCameraTake } from '../../lib/camera/steadyTake';");
    expect(cameraSource).toContain('const steadyTakeForProject = useCallback(');
    expect(cameraSource.split('await steadyTakeForProject(').length - 1).toBe(5);
    // The helper targets the take's own granted rate and restates
    // the receipt with the outcome for the saved file.
    expect(cameraSource).toContain('steadyCameraTake(blob, { targetFps: receipt.actualFps })');
    expect(cameraSource).toContain("timingOutcome: outcome.status === 'steadied' ? 'steadied' : 'original'");
  });

  it('the steadying state covers the surface while a take is prepared', () => {
    expect(cameraSource).toContain('const [steadyingTake, setSteadyingTake] = useState(false);');
    expect(cameraSource).toContain('Steadying your take…');
    expect(cameraSource).toContain('Evening out the frame timing before it joins your project.');
  });

  it('the receipt lines render: timing outcome + orientation note (neither amber)', () => {
    expect(cameraSource).toContain('{orientationNote && <p className="text-[11px] text-white/60">{orientationNote}</p>}');
    expect(cameraSource).toContain('{timingLine && <p className="text-[11px] text-white/60">{timingLine}</p>}');
  });

  it('the negotiation snapshot carries the orientation verdict into the receipt', () => {
    expect(cameraSource).toContain('orientationMismatch: boolean;');
    expect(cameraSource).toContain('orientationMismatch: negotiation?.orientationMismatch,');
    expect(cameraSource).toContain('acquired.negotiated?.orientationMismatch ??');
  });

  it('GUARANTEE: the diagnostics "Save the test clip" download delivers the RAW recorded blob — no steadying anywhere near it', () => {
    const downloadAt = cameraSource.indexOf('const downloadDiagnosticsClip');
    const useAt = cameraSource.indexOf('const useDiagnosticsClip');
    expect(downloadAt).toBeGreaterThan(-1);
    expect(useAt).toBeGreaterThan(downloadAt);
    const downloadBody = cameraSource.slice(downloadAt, useAt);
    expect(downloadBody).toContain('downloadBlobFile(diagResult.blob');
    expect(downloadBody).not.toContain('steadyTakeForProject');
    expect(downloadBody).not.toContain('steadyCameraTake');
    // And the steady module itself never touches the diagnostics
    // evidence path: no import of it, no reference to it.
    expect(steadyTakeSource).not.toContain("from './diagnostics'");
    expect(steadyTakeSource).not.toContain('diagResult');
    expect(diagnosticsSource).not.toContain('steadyCameraTake');
  });

  it('the diagnostics RUN holds the RAW recorded blob and returns before any steadying hook', () => {
    // In the recorder's onstop, the diagnostics branch stores the
    // recorder's own assembled blob — object-identical, unsteadied —
    // and returns; the steady step lives only in the project-media
    // tail below it.
    const diagResultAt = cameraSource.indexOf('setDiagResult({ pack, blob, url: URL.createObjectURL(blob), receipt });');
    const steadyAt = cameraSource.indexOf('const final = await steadyTakeForProject(blob, receipt);');
    expect(diagResultAt).toBeGreaterThan(-1);
    expect(steadyAt).toBeGreaterThan(diagResultAt);
    const diagTail = cameraSource.slice(diagResultAt, diagResultAt + 120);
    expect(diagTail).toContain('return;');
  });
});
