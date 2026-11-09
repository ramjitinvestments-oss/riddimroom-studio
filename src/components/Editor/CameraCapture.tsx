import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Clapperboard, PictureInPicture2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { recordDoorOpen, recordTakeHealthFromReceipt } from '../../lib/healthEvents';
import { MAX_MEDIA_SECONDS } from '../../lib/media/constants';
import {
  acquireCameraStream,
  applyProvenFpsCeiling,
  buildCensusAwareAttempts,
  flipFailureNoticeText,
  grantedFps,
  negotiateStreamAttempt,
  orientationMismatchBetween,
  pickRecorderMimeType,
  previewMirrorTransform,
  recorderOptionsForTrackSettings,
  zoomCapabilityFromCapabilities,
  type CaptureFacingMode,
  type CaptureFpsChoice,
  type CaptureQualityChoice,
  type GrantedTrackSettings,
  type ZoomCapability,
} from '../../lib/camera/captureQuality';
import { steadyCameraTake } from '../../lib/camera/steadyTake';
import {
  createFrameDropTracker,
  createRawFrameSeriesRecorder,
  type FrameDropEstimate,
  type FrameDropTracker,
  type RawFrameSeriesRecorder,
} from '../../lib/camera/frameDrops';
import {
  DIAGNOSTICS_PHASES,
  DIAGNOSTICS_TOTAL_SECONDS,
  buildDiagnosticsEvidencePack,
  createLongtaskCollector,
  diagnosticsPhaseAt,
  diagnosticsReportJson,
  formatDiagnosticsSummary,
  type DiagnosticsEvidencePack,
  type LongtaskCollector,
} from '../../lib/camera/diagnostics';
import {
  buildCaptureReceipt,
  captureReceiptDropWarning,
  formatCaptureReceipt,
  type CaptureReceipt,
} from '../../lib/camera/captureReceipt';
import {
  assessMotion,
  coachStateForLevel,
  createZoomRamp,
  gyroSampleFromRotationRate,
  horizonTiltDegrees,
  isStillEnough,
  isZoomRampDone,
  levelBubbleOffsetPx,
  loadSteadyStartEnabled,
  meanAbsFrameDiff,
  retargetZoomRamp,
  saveSteadyStartEnabled,
  zoomRampValueAt,
  type FrameSampleInput,
  type GyroSample,
  type MotionCoachState,
  type MotionLevel,
  type ZoomRamp,
} from '../../lib/camera/motionCoach';
import {
  CENSUS_UNAVAILABLE_TEXT,
  censusForFacing,
  censusFromCapabilities,
  clearProvenFpsCeiling,
  countVideoInputs,
  deviceProfileForFacing,
  formatCensusOfferLine,
  loadDeviceProfiles,
  provenCeilingUpdate,
  provenFpsCeilingForFacing,
  provenFpsCeilingText,
  provenSmoothnessSuggestion,
  saveDeviceProfile,
  saveFacingCensus,
  shortSideClassFor,
  withCensus,
  withProvenFpsCeiling,
  withTakeOutcome,
  type DeviceProfileStorage,
  type FacingCensus,
  type SmoothnessSuggestion,
  type TakeDropOutcome,
} from '../../lib/camera/deviceProfile';
import {
  coachIntervalMs,
  countdownDisplayForElapsed,
  createCoachGate,
  createTransitionGate,
  meterIntervalMs,
  motionSampleAccepted,
  zebraRecomputedWhile,
} from '../../lib/camera/readoutGate';
import {
  buildContinuityPlan,
  buildLockPlan,
  buildUnlockPlan,
  cameraControlCapsFromTrack,
  clampExposureCompensation,
  exposureLockNote,
  extractContinuityProfile,
  formatLockedChip,
  lockableSystems,
  lockedSystemsFromSettings,
  normalisedTapPoint,
  type CameraControlCaps,
  type ContinuityProfile,
  type LockableSystem,
} from '../../lib/camera/cameraControls';
import {
  LIGHT_GRID_COLS,
  LIGHT_GRID_ROWS,
  analyzeLightSample,
  lightAdvice,
  lightStateLabel,
  type LightState,
} from '../../lib/camera/lightMeter';
import {
  DUAL_MIC_UNAVAILABLE_MESSAGE,
  DUAL_UNAVAILABLE_MESSAGE,
  attachMicrophone,
  probeDualCamera,
  tryRaiseRearResolution,
} from '../../lib/camera/dualCapture';
import {
  TWO_PASS_BUTTON_LABEL,
  TWO_PASS_STEP1_HEADING,
  TWO_PASS_STEP2_HEADING,
  TWO_PASS_ENTRY_TIP,
  TWO_PASS_STEP2_TIP,
  TWO_PASS_WHY_LINE,
  initialTwoPassState,
  transitionTwoPass,
  twoPassStartDeltaMs,
  type TwoPassEvent,
  type TwoPassPhase,
} from '../../lib/camera/twoPass';

/**
 * Live camera capture (photo + short video), front/back toggle.
 *
 * Source: EventCam's capture screen (`getUserMedia` + `MediaRecorder`
 * pattern, front/back `facingMode` toggle). Re-implemented against this
 * app's component structure rather than copied verbatim — EventCam's
 * version was tightly coupled to its own single-screen App.tsx — but the
 * underlying browser APIs and control flow (request stream -> attach to
 * <video> -> snapshot via <canvas> for photo, MediaRecorder for video) are
 * the same proven approach.
 *
 * V1 (replaces the old 30s standard): recording (1) negotiates an actual
 * resolution instead of leaving every `getUserMedia` constraint unset
 * (which silently produced a 640x480 default on real hardware — found via
 * live testing), targeting the SELECTED PROJECT's aspect ratio at roughly
 * 1080p-class quality with graceful fallback via `ideal` (not
 * `exact`/`min`) constraints, so a device that can't do 1080p just
 * negotiates its own best match rather than failing; (2) auto-stops at
 * `MAX_MEDIA_SECONDS` (10 min) with a visible REC countdown instead of
 * recording indefinitely until the user manually stops.
 *
 * R24 (PiP camera quality): (WS-P1) capture now walks a constraint ladder
 * (see `lib/camera/captureQuality`) — 2160 -> 1440 -> 1080 short side at
 * the chosen fps, backing off to 30fps, ending on the exact pre-R24
 * permissive ideal-1080 request — with a user-facing Auto / 4K / HD +
 * 60 / 30fps chip row, and `MediaRecorder` gets tier bitrates derived
 * from the negotiated track settings instead of the browser default.
 * (WS-P2) the FRONT camera's live preview is CSS-mirrored so movement
 * matches phone-camera convention; the recorded stream/file is never
 * transformed (true-to-life), and the review screen shows it as-is.
 * (WS-P3) a toggleable rule-of-thirds + headroom guide overlay (DOM
 * only — the recording captures the media stream, never the DOM, so
 * guides can never appear in a recording). (WS-P4a) where the video
 * track exposes a `zoom` capability, a slider drives the real camera
 * zoom via `applyConstraints`; where it doesn't (iOS Safari), no zoom
 * control is rendered at all.
 *
 * R29 (dual-camera recording): when the caller provides `onCaptureDual`,
 * the camera offers a "Record both cameras" mode — rear camera as the
 * main video, front camera as a PiP overlay, recorded at the same time.
 * The mode is probe-first: both cameras are actually opened (via
 * `probeDualCamera` in `lib/camera/dualCapture`) before dual mode is
 * entered, and on any phone/browser that cannot run both at once the
 * component falls back honestly to today's single-camera mode with
 * `DUAL_UNAVAILABLE_MESSAGE` explaining why — it never pretends dual
 * worked. The microphone lives on the rear stream only, so there is
 * exactly one audio source to line up. Both recorders are started back-to-back
 * on one `performance.now()` anchor and the measured start delta is
 * carried with the result, so the timeline insert can line the overlay
 * up with the main clip. Stopping holds BOTH recordings for review; the
 * "Add as a pair" choice hands the pair to the caller together, while Retake
 * re-probes back into dual mode.
 *
 * R30 (dual-probe v2 — R29 failed on the owner's Android): the probe
 * now opens both cameras VIDEO-ONLY on a low-first pairing ladder
 * inside the concurrent-stream envelope Android guarantees (rear
 * 1080p + front 720p, descending, all 30fps); HAL rejections
 * (NotReadableError / AbortError) step DOWN a pairing instead of
 * killing the probe; liveness is judged after a ~1s settle window by
 * FRAME FLOW (see `probeStreamFramesFlowing`) instead of the rear
 * track's muted flag in the opening tick; cameras pair by exact
 * deviceId once permission reveals labels; and the microphone is
 * fetched LAST on its own audio-only call and merged onto the rear
 * stream — a mic failure degrades to silent dual video with
 * `DUAL_MIC_UNAVAILABLE_MESSAGE`, never to no dual at all. Right
 * before recording starts, one best-effort `applyConstraints` tries
 * to raise the rear toward 1440p; failure is ignored. A failed probe
 * surfaces the probe's plain-words details line under the banner and
 * in the console, so the next field report names the exact failure.
 *
 * R31 (guided two-pass recording): for phones where the dual probe
 * fails, the camera offers "Record in two steps" — record the main
 * video first (step 1, the existing single-camera path), then record
 * yourself with the FRONT camera while the kept main video plays
 * back full-frame WITH SOUND (step 2). A two-pass pair is
 * structurally identical to a dual pair, so the finished pair hands
 * off through the SAME `onCaptureDual` callback and nothing
 * downstream changes. The pure phase machine, delta maths and copy
 * live in `lib/camera/twoPass`. Step 2 starts its recorder FIRST and
 * drives playback second, anchoring the delta on the playback
 * element's 'playing' event, so the (normally negative) delta trims
 * the front take's head downstream exactly like dual's does.
 *
 * R32 Phase 1 (capture profile & honest receipt): recorder bitrates
 * are fps-aware (the 30fps table is unchanged); the recorder codec
 * comes from a support ladder (MP4 first where the platform supports
 * it) or this phone's saved proven choice; recordings are measured
 * with a frame-drop tracker where the browser supports it and every
 * review screen shows the honest receipt (actual size/fps/codec/
 * measured bitrate) built by `lib/camera/captureReceipt`; successful
 * recordings save a coarsely-keyed device profile (facing + size
 * class, never a device id) that later sessions prefer unless the
 * user picks a frame rate themselves; the two-step flow locks step
 * 1's quality + fps choices for step 2; and "Test my camera" runs a
 * guided 10-second test that shows the receipt, saves the profile
 * and discards the take.
 *
 * R32 Phase 2 (premium viewfinder & locks): after a stream starts, a
 * short warm-up settle (~800ms, a cancellable timer — the preview is
 * never blocked) gates the Phase 2 controls: they appear only for
 * what the live track's capabilities actually expose (see
 * `lib/camera/cameraControls`). Tap-to-focus via pointsOfInterest
 * with a brief ring at the tap; a Lock button that pins each offered
 * system (focus / exposure / white balance) to manual AT ITS CURRENT
 * settings and only claims the lock after `getSettings()` reads the
 * mode back as manual — the chip names exactly what locked, and an
 * exposure that couldn't join gets one plain note; an exposure
 * compensation slider inside its capability range; a Torch toggle
 * on the rear camera where offered; a front "Selfie light" (a bright
 * warm frame glow — DOM only, it adds no real light); a light meter
 * sampling the preview into a tiny canvas at ~4Hz with zebra stripes
 * over clipping cells and plain advice that NEVER changes the user's
 * quality/fps choice; and two-pass colour continuity — step 1's
 * negotiated colour/exposure profile is snapshotted after warm-up
 * and re-applied, clamped to the front track's ranges, at step 2.
 * On devices exposing none of this (desktop, iOS), nothing renders.
 *
 * R36 WS-4 (ultra-smooth cameras): the per-sample readouts left the
 * React render path. The light pill + advice are React state set ONLY
 * on value transitions; the zebra grid, the coach pill and the level
 * indicator are painted by direct DOM writes through refs, gated by
 * the pure `lib/camera/readoutGate` module (coach hysteresis: a new
 * level must persist across two samples, and the visible pill changes
 * at most every 500ms). While recording, the meter samples at most
 * once a second and the zebra recomputation is paused, so the only
 * per-second React update left in a take is the record timer. During
 * a take the only `applyConstraints` a user action can still land are
 * the ramped zoom and the torch; tap-focus, Lock and the brightness
 * slider are gated off, and every AUTOMATIC apply (warm-up settle,
 * two-step colour continuity, the dual rear raise) completes before
 * its recorder starts. Finished takes record their smoothness
 * outcome on the device profile (same drop threshold as the receipt
 * advisory), which can surface a one-step-down quality suggestion —
 * shown, never applied automatically.
 *
 * R32 Phase 3 (smooth-motion kit): all decision logic is the pure
 * `lib/camera/motionCoach` module; this component owns the sensors.
 * A "Steady start" toggle (default on, saved on this phone) holds a
 * Record press (single, dual via the shared startRecording path, and
 * two-step step 1 + step 2) behind a 3-2-1 countdown that finishes
 * early once the phone reads still enough, finishes anyway at zero
 * and never hard-blocks; Skip starts at once; with the toggle off
 * the start is immediate and unchanged. (The guided camera test
 * keeps its own direct start — it is not a Record press.) While
 * recording, a motion sampler (~4Hz, gyro primary, preview
 * frame-difference fallback) drives the coach pill — Smooth / Slow
 * down / Too shaky, and no pill when there is no signal. A Level
 * toggle shows a horizon line + bubble from DeviceOrientation
 * (permission is requested only from that tap, where the platform
 * requires it; the toggle defaults on only where no prompt is
 * needed). The zoom slider now applies through an eased ~300ms ramp
 * instead of jumping. Review screens add the dropped-frame advisory
 * from the Phase 1 receipt when the measured drops pass the
 * threshold (see `lib/camera/frameDrops`).
 */

export type CaptureResult =
  | { kind: 'photo'; blob: Blob }
  // R32 Phase 1 — a finished video carries its honest capture receipt
  // (actual size/fps/codec/measured bitrate, dropped frames when
  // measured) for any caller that wants to show or store it.
  | { kind: 'video'; blob: Blob; receipt?: CaptureReceipt };

export interface CaptureDualResult {
  main: CaptureResult;
  overlay: CaptureResult;
  /** Measured start delta between the two recorders (front start − rear start) in ms, on one performance.now() anchor. */
  startDeltaMs: number;
  /** R32 Phase 4 — layout chosen on the review screen: Corner PiP (the R29–R31 default) or Split 50/50. */
  layout: 'pip' | 'split';
}

interface CameraCaptureProps {
  onCapture: (result: CaptureResult) => void;
  /**
   * Tweaks round — camera → PiP flow. When provided, a finished VIDEO
   * recording's review state offers "Use as Overlay (PiP)" next to the
   * normal "Add to timeline": the same CaptureResult, handed to the
   * caller through this callback instead, and the caller routes it to
   * the overlay insert path (MediaImportPanel purpose 'overlay' →
   * `addPipOverlay`). Omitted = the choice is never shown.
   */
  onCaptureAsOverlay?: (result: CaptureResult) => void;
  /**
   * R29 — dual-camera recording. When provided, the camera offers
   * "Record both cameras" (rear = main video, front = PiP overlay) and a
   * finished dual recording's review state hands BOTH recordings to the
   * caller through this callback via its "Add as a pair" choice. Omitted =
   * dual mode is never offered.
   */
  onCaptureDual?: (result: CaptureDualResult) => void;
  /**
   * R36 WS-4 (from WS-1) — forced-overlay mode: the caller has wired
   * BOTH confirm callbacks to the overlay landing (MediaImportPanel's
   * PiP camera mode), so the single-camera review presents ONE
   * primary action, "Add as PiP", instead of the standard
   * main-vs-overlay pair. Absent = the standard review, unchanged.
   */
  overlayOnly?: boolean;
  onClose: () => void;
  /** The project's own canvas dimensions — used to negotiate a matching, non-distorted recording aspect ratio (16:9 / 9:16 / 1:1 / 4:5, whatever the project actually is), and to size the live preview box to match. */
  canvasWidth: number;
  canvasHeight: number;
}

/**
 * R30 — the real frame-flow check the dual probe judges liveness by:
 * attach the stream to a scratch <video> and count presented frames
 * via `requestVideoFrameCallback` (two frames = flowing). Browsers
 * without rVFC fall back to the track's muted flag — which is only
 * consulted here AFTER the probe's settle window, never in the tick
 * the second camera opened. The scratch element is detached on
 * resolution; the stream itself is untouched.
 */
function probeStreamFramesFlowing(stream: MediaStream): Promise<boolean> {
  return new Promise((resolve) => {
    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') {
      resolve(false);
      return;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    let settled = false;
    let frames = 0;
    const finish = (flowing: boolean) => {
      if (settled) return;
      settled = true;
      try {
        video.srcObject = null;
      } catch {
        // Best-effort detach only.
      }
      resolve(flowing);
    };
    const rvfcHost = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
    };
    if (typeof rvfcHost.requestVideoFrameCallback === 'function') {
      const onFrame = () => {
        frames += 1;
        if (frames >= 2) {
          finish(true);
          return;
        }
        rvfcHost.requestVideoFrameCallback?.(onFrame);
      };
      rvfcHost.requestVideoFrameCallback(onFrame);
      void video.play().catch(() => {});
      window.setTimeout(() => finish(frames >= 2), 900);
    } else {
      void video.play().catch(() => {});
      window.setTimeout(() => finish(track.muted === false), 400);
    }
  });
}

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* R32 Phase 1 — device profile storage + receipt display helpers      */
/* ------------------------------------------------------------------ */

function browserLocalStorage(): DeviceProfileStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Remember the settings that just worked on this phone (facing + size
 * class + fps + recorder mime), so a later session can prefer them.
 * Coarsely keyed in the lib module — no device ids are ever stored.
 */
function saveProvenProfile(
  facing: CaptureFacingMode,
  settings: { width?: number; height?: number; frameRate?: number } | null | undefined,
  mimeType: string,
  fallbackFps: number,
  opts?: {
    quality?: CaptureQualityChoice | null;
    outcome?: TakeDropOutcome | null;
    census?: FacingCensus | null;
    ceiling?: number;
  },
): void {
  const width = settings?.width ?? 0;
  const height = settings?.height ?? 0;
  const shortSide = width > 0 && height > 0 ? Math.min(width, height) : 0;
  // R36 WS-4 — the take's smoothness outcome rides along when the
  // caller measured one, so the profile can later offer its
  // one-step-down suggestion. Callers without a quality context
  // (dual) pass neither field and the core save is unchanged.
  // R41 WS-A — the session census for this facing (when one was
  // measured) rides along the same way, so the stored profile
  // carries what this phone's browser offers per facing.
  // R41 Step 3 Rung A — a proven fps ceiling learned from this take
  // rides along the same way, as the outermost wrap (absent/invalid
  // values leave the fresh profile without the field, unchanged).
  saveDeviceProfile(
    browserLocalStorage(),
    withProvenFpsCeiling(
      withCensus(
        withTakeOutcome(
          {
            facing,
            shortSideClass: shortSideClassFor(shortSide),
            fps:
              typeof settings?.frameRate === 'number' && settings.frameRate > 0
                ? Math.round(settings.frameRate)
                : fallbackFps,
            mimeType: mimeType ?? '',
          },
          opts?.quality,
          opts?.outcome,
        ),
        opts?.census,
      ),
      opts?.ceiling,
    ),
  );
}

/** The proven recorder mime for a facing, when one is saved. */
function provenMimeFor(facing: CaptureFacingMode): string | undefined {
  const profile = deviceProfileForFacing(loadDeviceProfiles(browserLocalStorage()), facing);
  return profile?.mimeType ? profile.mimeType : undefined;
}

/**
 * The receipt on a review screen: the plain summary (what was
 * actually recorded — size, frame rate, honest quality word) over
 * the plain details line (duration + file size). The technical
 * line sits behind a "Details" expander, collapsed by default.
 * The strings themselves come from the lib formatter.
 */
function ReceiptLines({ receipt, label }: { receipt: CaptureReceipt; label?: string }) {
  const { summary, details, technicalDetails, askedVsGranted, grantBelowAsked, timingLine, orientationNote } =
    formatCaptureReceipt(receipt);
  const [showDetails, setShowDetails] = useState(false);
  // R32 Phase 3 — dropped-frame review warning: advisory only, and
  // only when the tracker actually measured drops past the threshold.
  const dropWarning = captureReceiptDropWarning(receipt);
  return (
    <div className="flex flex-col items-center gap-0.5 text-center">
      {label && (
        <p className="text-[10px] font-bold uppercase tracking-wide text-white/40">{label}</p>
      )}
      <p className="text-xs text-white/80">{summary}</p>
      {/* R41 WS-B — asked vs granted sits in the SUMMARY area, not
          only in Details: when the final grant fell below the
          selected quality it is stated plainly here, in amber. */}
      {askedVsGranted && (
        <p className={`text-[11px] ${grantBelowAsked ? 'text-amber-300' : 'text-white/60'}`}>{askedVsGranted}</p>
      )}
      {/* R41 Step 3 Rung C — the orientation note sits in the summary
          area too: plain and non-alarming (never amber), it simply
          says the phone framed the picture differently than asked. */}
      {orientationNote && <p className="text-[11px] text-white/60">{orientationNote}</p>}
      {/* R41 Step 3 Rung B — the frame-timing outcome of the save:
          steadied onto an even grid, or the original timing kept. */}
      {timingLine && <p className="text-[11px] text-white/60">{timingLine}</p>}
      {details && <p className="text-[11px] text-white/50">{details}</p>}
      {dropWarning && <p className="text-[11px] text-amber-300">{dropWarning}</p>}
      {technicalDetails && (
        <>
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails}
            className="text-[11px] font-bold text-white/50 hover:text-gold"
          >
            Details
          </button>
          {showDetails && <p className="text-[11px] text-white/50">{technicalDetails}</p>}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* R32 Phase 3 — level indicator platform helpers                      */
/* ------------------------------------------------------------------ */

/** True when the platform exposes DeviceOrientation at all (the Level toggle renders only then). */
function deviceOrientationAvailable(): boolean {
  return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
}

/** True on platforms (iOS) where orientation access needs an explicit permission request from a user tap. */
function orientationPermissionNeeded(): boolean {
  return (
    typeof DeviceOrientationEvent !== 'undefined' &&
    typeof (DeviceOrientationEvent as unknown as { requestPermission?: unknown }).requestPermission === 'function'
  );
}

export function CameraCapture({ onCapture, onCaptureAsOverlay, onCaptureDual, overlayOnly, onClose, canvasWidth, canvasHeight }: CameraCaptureProps) {
  // R41 WS-D health hooks (keep these two small blocks intact — see
  // healthEvents.ts): the camera door counts once when this component
  // mounts (CameraCapture only mounts when the camera is opened), and
  // take health is recorded in confirmPendingVideo / confirmDual below.
  const { idToken } = useAuth();
  const cameraDoorCountedRef = useRef(false);
  useEffect(() => {
    if (idToken && !cameraDoorCountedRef.current) {
      cameraDoorCountedRef.current = true;
      recordDoorOpen('camera', idToken);
    }
  }, [idToken]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  // R24 WS-P1: user quality / frame-rate choices. Defaults: Auto (the
  // full ladder) + 60fps. Changing either re-acquires the stream.
  const [qualityChoice, setQualityChoice] = useState<CaptureQualityChoice>('auto');
  const [fpsChoice, setFpsChoice] = useState<CaptureFpsChoice>(60);
  // R24 WS-P3: framing guides default ON (the camera opens on the front
  // camera, where the headroom guide matters most); toggleable any time.
  const [showGuides, setShowGuides] = useState(true);
  /** R40 P-16 — the "Camera settings" sheet: the pre-Record controls
      (quality, frame rate, Guides, Steady start, Level, Test my
      camera) live behind this one button; the surface keeps only the
      essentials (viewfinder, Record/Stop, Flip, Photo, Close,
      Flashlight, Selfie light, the light-meter pill, Lock). */
  const [cameraSettingsOpen, setCameraSettingsOpen] = useState(false);
  // R24 WS-P4a: the live track's zoom capability, when the platform
  // exposes one; null = no zoom control is rendered at all.
  const [zoomCapability, setZoomCapability] = useState<ZoomCapability | null>(null);
  const [zoomValue, setZoomValue] = useState(1);
  const [error, setError] = useState<string | null>(null);
  // R41 Step 3 (flip fix) — the plain-words notice shown when a camera
  // flip could not land and the working camera was kept instead. A
  // separate state from `error` on purpose: the restore re-opens the
  // working camera through startStream, which clears `error` at entry
  // — the notice must survive that so the owner is told the flip
  // failed rather than left guessing why the picture never changed.
  const [flipNotice, setFlipNotice] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  /** R36 WS-4 — ref mirror of `isRecording` for timer/sampler closures and constraint gates. */
  const isRecordingRef = useRef(false);
  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [isReady, setIsReady] = useState(false);
  // Review state (tweaks round): a stopped recording is HELD here for
  // preview + the add-as-main vs use-as-overlay choice instead of being
  // handed off the instant the recorder stops (the previous behavior —
  // no chance to review, retake, or pick the overlay track). `url` is an
  // object URL for the preview <video>, revoked when the state clears.
  const [pendingVideo, setPendingVideo] = useState<{ blob: Blob; url: string; receipt: CaptureReceipt } | null>(null);

  useEffect(() => {
    if (!pendingVideo) return;
    return () => URL.revokeObjectURL(pendingVideo.url);
  }, [pendingVideo]);

  // R41 Step 3 Rung B — while a finished take is being steadied to
  // an even frame rate (see steadyTakeForProject below), the whole
  // camera surface is covered by a plain "Steadying your take…"
  // state: the review only appears once the file that will actually
  // join the project exists, so what the user reviews IS what the
  // project gets, and the receipt can state the outcome honestly.
  const [steadyingTake, setSteadyingTake] = useState(false);

  // R29 — dual-camera state. All of it stays null/false/0 in single
  // mode, so the single-camera behaviour is unchanged.
  const frontStreamRef = useRef<MediaStream | null>(null);
  const frontVideoRef = useRef<HTMLVideoElement>(null);
  const frontRecorderRef = useRef<MediaRecorder | null>(null);
  const dualChunksRef = useRef<{ rear: Blob[]; front: Blob[] }>({ rear: [], front: [] });
  const dualStartRef = useRef<{ anchorMs: number; rearStartMs: number; frontStartMs: number } | null>(null);
  const dualStoppedRef = useRef(0);
  const [dualMode, setDualMode] = useState(false);
  const [dualNotice, setDualNotice] = useState<string | null>(null);
  // R30 — the failed probe's diagnosis, kept as data (and logged to
  // the console). R34 — the banner now hides it behind a "Why?"
  // expander, collapsed by default.
  const [dualDetails, setDualDetails] = useState<string | null>(null);
  const [dualWhyOpen, setDualWhyOpen] = useState(false);
  // R30 — true while the dual probe is running (both cameras can take
  // a few seconds to open + settle): the button disables and relabels.
  const [dualBusy, setDualBusy] = useState(false);
  // R30 — the mic call failed after both cameras passed: dual
  // recording proceeds WITHOUT sound and the user is told up front.
  const [dualMicMissing, setDualMicMissing] = useState(false);
  const [dualCamCount, setDualCamCount] = useState(0);
  // R32 Phase 4 — the dual review's layout choice; Corner PiP is the
  // default, exactly as pairs have always been placed.
  const [dualLayout, setDualLayout] = useState<'pip' | 'split'>('pip');
  const [pendingDual, setPendingDual] = useState<{
    mainBlob: Blob;
    mainUrl: string;
    frontBlob: Blob;
    frontUrl: string;
    startDeltaMs: number;
    mainReceipt: CaptureReceipt;
    frontReceipt: CaptureReceipt;
  } | null>(null);

  useEffect(() => {
    if (!pendingDual) return;
    return () => {
      URL.revokeObjectURL(pendingDual.mainUrl);
      URL.revokeObjectURL(pendingDual.frontUrl);
    };
  }, [pendingDual]);

  // R31 — guided two-pass state. All of it stays in its initial state
  // while the flow is off, so single/dual behaviour is unchanged. The
  // phase machine is the pure one in `lib/camera/twoPass`; this
  // component owns everything the machine deliberately does not:
  // streams, recorders and object URLs.
  const [twoPass, setTwoPass] = useState(initialTwoPassState);
  const twoPassPhase = twoPass.phase;
  const isStep2Phase = twoPassPhase === 'step2-live' || twoPassPhase === 'step2-review';
  // Ref mirror of the phase for use inside recorder `onstop`
  // closures, which are created while a phase is live but fire after
  // state has moved on — they must read the phase as it IS at stop
  // time, not as it was when the closure was created.
  const twoPassPhaseRef = useRef<TwoPassPhase>('off');
  useEffect(() => {
    twoPassPhaseRef.current = twoPassPhase;
  }, [twoPassPhase]);
  // The retained step-1 take's object URL while the flow owns it
  // (step1-review → step2-live). Ownership transfers INTO
  // `pendingDual.mainUrl` at step2-review — the ref is cleared at the
  // transfer, and the pendingDual effect above owns revocation from
  // there. NOTE it is a SEPARATE object URL from `pendingVideo.url`
  // for the same blob: the pendingVideo effect revokes its URL when
  // the review clears, and the retained copy must survive that.
  const step1UrlRef = useRef<string | null>(null);
  // R32 Phase 1 — capture-profile state. Ref mirrors of the user's
  // choices for use inside recorder callbacks (created in one phase,
  // fired in another), the two-step profile lock, the step-1 receipt
  // (carried into the step-2 review), and the camera-test mode flags.
  const facingModeRef = useRef(facingMode);
  useEffect(() => {
    facingModeRef.current = facingMode;
  }, [facingMode]);
  const qualityChoiceRef = useRef(qualityChoice);
  useEffect(() => {
    qualityChoiceRef.current = qualityChoice;
  }, [qualityChoice]);
  const fpsChoiceRef = useRef(fpsChoice);
  useEffect(() => {
    fpsChoiceRef.current = fpsChoice;
  }, [fpsChoice]);
  /** True once the user taps an fps chip this session — a saved device profile never overrides an explicit choice. */
  const userFpsChoiceRef = useRef(false);
  // R41 Step 3 (flip fix) — startStream concurrency guard + the facing
  // of the last stream that actually opened. startStream is async and
  // several callers can overlap (the mount effect, the R32 profile-fps
  // effect restarting the stream a tick later, a flip during an
  // in-flight open): without a generation check, the call that
  // resolved LAST won — stopping nothing (stopStream only stops the
  // stream in streamRef) and leaking its rival's stream, which kept
  // holding its camera and made later flips contend for a busy HAL.
  // Every startStream entry bumps the generation; a call that finds
  // itself superseded stops its own stream and bows out silently.
  const streamGenerationRef = useRef(0);
  /** The facing of the last successfully opened single-camera stream — the camera a failed flip restores. */
  const workingFacingRef = useRef<CaptureFacingMode>('user');
  /** Two-step lock: the quality + fps captured when step 1 started recording; step 2 must reuse them. */
  const twoPassLockRef = useRef<{ quality: CaptureQualityChoice; fps: CaptureFpsChoice } | null>(null);
  /** The step-1 take's receipt, carried into the step-2 (pendingDual) review. */
  const step1ReceiptRef = useRef<CaptureReceipt | null>(null);
  /** "Test my camera" mode: the next single recording is a 10s test — measured, profiled, then discarded. */
  const testModeRef = useRef(false);
  const [isTestingCamera, setIsTestingCamera] = useState(false);
  const [testReceipt, setTestReceipt] = useState<CaptureReceipt | null>(null);

  // R41 WS-B — the two-stage negotiation outcome of the CURRENT
  // stream: what the winning rung asked, what the stage-1 stream
  // granted, and whether the one exact retry ran / won. Read by the
  // record paths at record start (snapshotted per take) so each
  // receipt can state asked vs granted. Dual streams never pass
  // through here — their pairing ladder negotiates separately.
  const lastNegotiationRef = useRef<{
    asked: { shortSide: number; frameRate: number; width: number; height: number };
    granted: GrantedTrackSettings | null;
    exactRetried: boolean;
    usedExact: boolean;
    /** R41 Step 3 Rung C — the final grant's orientation vs the ask (for the receipt's plain note). */
    orientationMismatch: boolean;
  } | null>(null);

  // R41 WS-A — per-facing capability census. Session cache first
  // (captured once per facing per session, at camera open), backed
  // by the stored profiles' census fields. `censusByFacing` is the
  // settings sheet's view of it; the ref is the capture path's.
  const censusSessionRef = useRef<Partial<Record<CaptureFacingMode, FacingCensus>>>({});
  const [censusByFacing, setCensusByFacing] = useState<Partial<Record<CaptureFacingMode, FacingCensus>>>(() => {
    const stored = loadDeviceProfiles(browserLocalStorage());
    const initial: Partial<Record<CaptureFacingMode, FacingCensus>> = {};
    for (const facing of ['user', 'environment'] as CaptureFacingMode[]) {
      const census = censusForFacing(stored, facing);
      if (census) {
        initial[facing] = census;
        censusSessionRef.current[facing] = census;
      }
    }
    return initial;
  });

  // R41 WS-A — diagnostics session ("Check camera smoothness"):
  // intro → one guided 60s take through the NORMAL record path →
  // evidence pack. The refs carry the collectors + per-take facts
  // the recorder callbacks need; the state drives the panels.
  const diagModeRef = useRef(false);
  const diagRawRecorderRef = useRef<RawFrameSeriesRecorder | null>(null);
  const diagLongtaskRef = useRef<LongtaskCollector | null>(null);
  const diagAskedRef = useRef<{ shortSide: number; frameRate: number; width: number; height: number } | null>(null);
  const diagRecorderInfoRef = useRef<{ mimeType: string; videoBitsPerSecond: number; audioBitsPerSecond: number } | null>(null);
  const [diagIntroOpen, setDiagIntroOpen] = useState(false);
  const [isDiagRecording, setIsDiagRecording] = useState(false);
  const [diagResult, setDiagResult] = useState<{
    pack: DiagnosticsEvidencePack;
    blob: Blob;
    url: string;
    receipt: CaptureReceipt;
  } | null>(null);

  useEffect(() => {
    if (!diagResult) return;
    return () => URL.revokeObjectURL(diagResult.url);
  }, [diagResult]);

  // R32 Phase 2 — premium viewfinder state. Everything here stays
  // null/false/empty until a stream's warm-up reads real capabilities,
  // so on devices exposing nothing (desktop, iOS) no Phase 2 control
  // ever renders.
  /** The live track's Phase 2 capability model; null until warm-up (and on tracks exposing nothing usable it is the all-absent model). */
  const [controlCaps, setControlCaps] = useState<CameraControlCaps | null>(null);
  /** True once the current stream's warm-up settle has run. */
  const [warmedUp, setWarmedUp] = useState(false);
  /** The tap-to-focus ring position (0..1 fractions of the preview box); null = no ring. */
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number } | null>(null);
  const [focusRingFading, setFocusRingFading] = useState(false);
  /** Systems the read-back PROVED locked — the chip names exactly these. */
  const [lockedSystems, setLockedSystems] = useState<LockableSystem[]>([]);
  /** The one-time "exposure can't lock" note for the current lock; null otherwise. */
  const [lockNote, setLockNote] = useState<string | null>(null);
  const [exposureCompValue, setExposureCompValue] = useState(0);
  const [torchOn, setTorchOn] = useState(false);
  const [selfieLight, setSelfieLight] = useState(false);
  // R36 WS-4 — the light meter OFF React state per sample: the pill's
  // STATE (one of four values) is discrete React state set only when
  // it transitions; the full latest reading lives in a ref, and the
  // zebra grid is a DOM node painted directly by the sampler.
  /** The meter pill's current light state; null until the sampler's first pass. Set ONLY on transitions. */
  const [lightState, setLightState] = useState<LightState | null>(null);
  /** The meter advice line; null when there is nothing worth saying. Set ONLY when the line changes. */
  const [meterAdviceText, setMeterAdviceText] = useState<string | null>(null);
  /** The latest full meter reading (mean/clipped/zebra source) — a ref, never state. */
  const lightResultRef = useRef<import('../../lib/camera/lightMeter').LightMeterResult | null>(null);
  /** Transition gates for the pill state + advice line (pure, in readoutGate). */
  const lightStateGateRef = useRef(createTransitionGate<LightState>());
  const meterAdviceGateRef = useRef(createTransitionGate<string | null>());
  /** The zebra overlay's cell nodes, painted by direct DOM writes from the sampler. */
  const zebraCellRefs = useRef<Array<HTMLDivElement | null>>([]);
  /**
   * R40 P-38 — the last computed zebra grid, kept in a ref. The grid
   * only mounts once a cell has flagged (`zebraAnyOn`), which is
   * AFTER the sampler computed that grid — without this, fresh cells
   * all started hidden and the first warning waited for the next
   * sample (and every remount blanked for a beat). Cells now paint
   * from this ref on mount, and the whole grid re-paints from it on
   * any false→true toggle. Deliberately NOT cleared by stopStream:
   * a review remount must repaint the grid as it was.
   */
  const lastZebraCellsRef = useRef<boolean[]>([]);
  /** Paint one zebra cell from the last computed grid (direct DOM write). */
  const paintZebraCell = useCallback((el: HTMLDivElement | null, i: number) => {
    if (el) el.style.display = lastZebraCellsRef.current[i] ? 'block' : 'none';
  }, []);
  /** True once any zebra cell is painted on — drives the overlay container's visibility class only on flips. */
  const [zebraAnyOn, setZebraAnyOn] = useState(false);
  const zebraAnyGateRef = useRef(createTransitionGate<boolean>());
  const warmupTimerRef = useRef<number | null>(null);
  const focusRingTimersRef = useRef<number[]>([]);
  const lastCompApplyRef = useRef(0);
  /** Two-pass colour continuity: step 1's negotiated colour/exposure profile, re-applied (clamped) at step 2. */
  const continuityProfileRef = useRef<ContinuityProfile | null>(null);

  // R32 Phase 3 — smooth-motion kit state. The decision logic is the
  // pure module in `lib/camera/motionCoach`; this component owns the
  // sensors and the timers only.
  /** Steady-start toggle: default ON, persisted in localStorage (pure (de)serialisation in the lib module). */
  const [steadyStartEnabled, setSteadyStartEnabled] = useState<boolean>(() =>
    loadSteadyStartEnabled(browserLocalStorage()),
  );
  /** True while the steady-start countdown overlay is up (the pending recorder start sits in a ref). */
  const [countdownActive, setCountdownActive] = useState(false);
  /** The countdown's displayed number (3, then 2, then 1) — set ONLY when the digit changes (R36 WS-4). */
  const [countdownDisplay, setCountdownDisplay] = useState(3);
  const countdownDisplayGateRef = useRef(createTransitionGate<number>());
  /** The recorder start waiting on the countdown — single, dual (via startRecording) or step-2. */
  const countdownPendingRef = useRef<(() => void) | null>(null);
  /** Rolling motion-level history, written by the motion sampler; the countdown decision reads it. */
  const levelHistoryRef = useRef<MotionLevel[]>([]);
  // R36 WS-4 — the coach pill is a DOM node painted directly (never
  // React state per sample); the pure gate adds hysteresis (a level
  // must persist across two samples) and a 500ms minimum between
  // visible changes.
  const coachPillRef = useRef<HTMLDivElement | null>(null);
  const coachGateRef = useRef(createCoachGate());
  /** Level indicator on/off. Default ON only where enabling it needs no permission prompt on this platform. */
  const [levelEnabled, setLevelEnabled] = useState<boolean>(
    () => deviceOrientationAvailable() && !orientationPermissionNeeded(),
  );
  // R36 WS-4 — the horizon readout is painted directly onto these
  // DOM nodes by the orientation listener (per-event React state
  // was the worst churn source of all when the phone moved).
  const levelWrapRef = useRef<HTMLDivElement | null>(null);
  const horizonLineRef = useRef<HTMLDivElement | null>(null);
  const levelBubbleRef = useRef<HTMLDivElement | null>(null);
  /**
   * R40 P-39 — the last known horizon tilt, kept in a ref. The level
   * wrap unmounts during review states; when it remounts it used to
   * start hidden and wait for the next deviceorientation event — on
   * a phone held still, no event fires and the level stayed missing.
   * The remounted wrap now paints this tilt immediately (see the
   * layout effect by the orientation listener).
   */
  const lastTiltRef = useRef<number | null>(null);
  /** Paint the level wrap / line / bubble from a tilt value (direct DOM writes). */
  const paintLevel = useCallback((tilt: number) => {
    const wrap = levelWrapRef.current;
    const line = horizonLineRef.current;
    const bubble = levelBubbleRef.current;
    if (!wrap || !line || !bubble) return;
    wrap.style.display = 'block';
    const level = Math.abs(tilt) <= 2;
    line.style.transform = `rotate(${-tilt}deg)`;
    line.className = `w-28 h-0.5 rounded ${level ? 'bg-emerald-400/90' : 'bg-white/70'}`;
    bubble.style.transform = `translate(calc(-50% + ${levelBubbleOffsetPx(tilt, 40)}px), -50%)`;
    bubble.className = `absolute top-1/2 left-1/2 w-2.5 h-2.5 rounded-full ${level ? 'bg-emerald-400' : 'bg-gold'}`;
  }, []);
  /** Rolling sensor buffers for the motion sampler (gyro primary, frame-diff fallback). */
  const motionBufferRef = useRef<{ gyro: GyroSample[]; diffs: number[]; lastFrame: FrameSampleInput | null }>({
    gyro: [],
    diffs: [],
    lastFrame: null,
  });
  /** The live smooth-zoom ramp (animation-frame handle + ramp state); null = no ramp running. */
  const zoomRampRef = useRef<{ ramp: ZoomRamp; raf: number } | null>(null);
  /** The zoom value most recently APPLIED to the track — a new ramp starts (or retargets) from here. */
  const zoomAppliedRef = useRef(1);

  // R32 Phase 1 — prefer this phone's proven frame rate for the
  // current facing when the session starts (or the camera flips),
  // unless the user has already picked a frame rate this session.
  useEffect(() => {
    if (userFpsChoiceRef.current) return;
    if (twoPassPhase !== 'off') return;
    const profile = deviceProfileForFacing(loadDeviceProfiles(browserLocalStorage()), facingMode);
    if (profile && (profile.fps === 30 || profile.fps === 60) && profile.fps !== fpsChoice) {
      setFpsChoice(profile.fps as CaptureFpsChoice);
    }
  }, [facingMode, fpsChoice, twoPassPhase]);

  // R36 WS-4 — the proven-smooth suggestion for the current facing:
  // refreshed when the facing flips and whenever a take finishes
  // (a review appearing is the moment a new outcome was just saved).
  // A suggestion only — applying it is the user's one tap below.
  const [profileSuggestion, setProfileSuggestion] = useState<SmoothnessSuggestion | null>(null);
  // R41 Step 3 Rung A — the proven fps ceiling for the current facing
  // (for the fps chips' advisory line), refreshed on the same cadence
  // as the smoothness suggestion; and whether the user has explicitly
  // picked an fps this session (which silences that advisory line and,
  // via userFpsChoiceRef, the ceiling shaping in startStream).
  const [provenCeiling, setProvenCeiling] = useState<number | null>(null);
  const [fpsPickedExplicitly, setFpsPickedExplicitly] = useState(false);
  useEffect(() => {
    setProfileSuggestion(
      provenSmoothnessSuggestion(loadDeviceProfiles(browserLocalStorage()), facingMode),
    );
    setProvenCeiling(provenFpsCeilingForFacing(loadDeviceProfiles(browserLocalStorage()), facingMode));
  }, [facingMode, pendingVideo, pendingDual, testReceipt]);

  const step2PlaybackRef = useRef<HTMLVideoElement>(null);
  const step2ChunksRef = useRef<Blob[]>([]);
  const step2AnchorsRef = useRef<{
    recorderStartMs: number;
    playbackAnchorMs: number | null;
    fallbackAnchorMs: number;
  } | null>(null);

  const dispatchTwoPass = useCallback((event: TwoPassEvent) => {
    setTwoPass((prev) => transitionTwoPass(prev, event));
  }, []);

  /** Drop the retained step-1 URL (take retaken / replaced / flow exited). */
  const dropStep1Url = useCallback(() => {
    if (step1UrlRef.current) {
      URL.revokeObjectURL(step1UrlRef.current);
      step1UrlRef.current = null;
    }
  }, []);

  /** Leave the two-pass flow entirely: machine to 'off' + retained URL dropped. */
  const exitTwoPass = useCallback(() => {
    dropStep1Url();
    twoPassLockRef.current = null;
    step1ReceiptRef.current = null;
    continuityProfileRef.current = null;
    dispatchTwoPass({ type: 'exit' });
  }, [dropStep1Url, dispatchTwoPass]);

  const previewAspectRatio = canvasWidth > 0 && canvasHeight > 0 ? `${canvasWidth} / ${canvasHeight}` : '9 / 16';

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    // R29 — the front stream only ever exists in dual mode; stopping it
    // here too keeps every exit path (close, review, retake) leak-free.
    frontStreamRef.current?.getTracks().forEach((track) => track.stop());
    frontStreamRef.current = null;
    setZoomCapability(null);
    // R32 Phase 2 — a stopped stream takes every Phase 2 control
    // state with it: locks die with their track, the torch is off
    // (its track is gone), warm-up must re-run for the next stream.
    if (warmupTimerRef.current !== null) {
      window.clearTimeout(warmupTimerRef.current);
      warmupTimerRef.current = null;
    }
    focusRingTimersRef.current.forEach((t) => window.clearTimeout(t));
    focusRingTimersRef.current = [];
    setControlCaps(null);
    setWarmedUp(false);
    setFocusPoint(null);
    setFocusRingFading(false);
    setLockedSystems([]);
    setLockNote(null);
    setTorchOn(false);
    // R36 WS-4 — the meter readout resets with the stream: ref,
    // transition gates and the (transition-gated) pill/advice state.
    lightResultRef.current = null;
    lightStateGateRef.current.reset();
    meterAdviceGateRef.current.reset();
    zebraAnyGateRef.current.reset();
    setLightState(null);
    setMeterAdviceText(null);
    setZebraAnyOn(false);
    // R32 Phase 3 — a stopped stream also stops the zoom ramp (its
    // track is gone), any pending steady-start countdown (its start
    // must never fire into a dead stream) and the coach pill.
    if (zoomRampRef.current) {
      cancelAnimationFrame(zoomRampRef.current.raf);
      zoomRampRef.current = null;
    }
    countdownPendingRef.current = null;
    setCountdownActive(false);
    coachGateRef.current.reset();
    if (coachPillRef.current) coachPillRef.current.style.display = 'none';
  }, []);

  const startStream = useCallback(async (override?: { quality: CaptureQualityChoice; fps: CaptureFpsChoice }) => {
    // R41 Step 3 (flip fix) — claim a new generation FIRST: any older
    // startStream still awaiting getUserMedia is superseded from this
    // moment and will stop its own stream instead of leaking it or
    // overwriting this call's bookkeeping when it resolves late.
    const myGeneration = ++streamGenerationRef.current;
    setError(null);
    setIsReady(false);
    stopStream();
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera capture is not supported in this browser. Use file upload instead.');
      return;
    }
    // R32 Phase 1 — two-step profile lock: while step 2 is live (or
    // its review is up), the stream is acquired with STEP 1's quality
    // + frame-rate choices, so the pair matches by construction; chip
    // changes mid-flow are ignored here (and the chips are disabled
    // in step 2 besides). `override` covers the one call made in the
    // same tick as the step-1 → step-2 transition, before the phase
    // ref has caught up.
    const phaseAtStart = twoPassPhaseRef.current;
    const lock =
      override ??
      (phaseAtStart === 'step2-live' || phaseAtStart === 'step2-review' ? twoPassLockRef.current : null);
    // R24 WS-P1: walk the constraint ladder in order. A rung that the
    // device rejects as over-constrained / not found falls through to
    // the next rung; the final rung is the pre-R24 permissive ideal-1080
    // request, so capture never hard-fails on resolution grounds. Any
    // other error (permission denied, no device busy, …) aborts at once.
    // R41 WS-A: when a census exists for this facing it shapes the
    // ladder's first rung (measured maximums; the generic ladder is
    // the fallback when there is none).
    const knownCensus =
      censusSessionRef.current[facingMode] ?? censusForFacing(loadDeviceProfiles(browserLocalStorage()), facingMode);
    // R41 Step 3 Rung A — the proven fps ceiling shapes the census-shaped
    // ladder next (ceiling = min of the census cap and the proven ceiling
    // on the opening rung emerges from that order), unless the user has
    // explicitly picked an fps this session. This applies identically
    // when a two-pass lock is present: the lock carries quality/fps and
    // the ceiling shapes the ask in both passes, exactly like the census
    // shaping already does.
    const attempts = applyProvenFpsCeiling(
      buildCensusAwareAttempts(
        {
          canvasWidth,
          canvasHeight,
          facingMode,
          quality: lock?.quality ?? qualityChoice,
          frameRate: lock?.fps ?? fpsChoice,
        },
        knownCensus,
      ),
      userFpsChoiceRef.current ? null : provenFpsCeilingForFacing(loadDeviceProfiles(browserLocalStorage()), facingMode),
    );
    // R41 WS-B — two-stage negotiation per rung (AUDIT F01): stage 1
    // is the rung's ideal ask (unchanged); after it settles, a grant
    // below the rung earns ONE exact retry of that rung, and a working
    // stage-1 stream is never lost to a failed or worse exact attempt.
    // Setup only — nothing here runs during a recording.
    //
    // R41 Step 3 (flip fix) — the walk itself now lives in
    // acquireCameraStream (captureQuality): contention errors
    // (NotReadableError / AbortError — the camera still releasing, or
    // held by a leaked stream) fall through rungs instead of aborting
    // the ladder; if every negotiated rung fails, the ladder runs
    // bare (no exact retry — its second concurrent open is itself a
    // contention source), then a plain facingMode-only ask. A flip
    // therefore lands unless the camera itself refuses every form.
    let acquired: Awaited<ReturnType<typeof acquireCameraStream>>;
    try {
      acquired = await acquireCameraStream({
        attempts,
        facingMode,
        getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
        negotiate: (attempt) =>
          negotiateStreamAttempt({ attempt, getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c) }),
      });
    } catch (err) {
      // A superseded call stays silent: the newer call owns the screen.
      if (myGeneration !== streamGenerationRef.current) return;
      if (facingMode !== workingFacingRef.current) {
        // The ask was a FLIP (or a two-pass facing change) and even
        // the plain ask refused: revert the facing state to the last
        // camera that actually opened — the effect re-runs
        // startStream for it, restoring a working picture — and say
        // plainly that the switch failed. Never a dead screen, never
        // a silent stay.
        setFlipNotice(flipFailureNoticeText(facingMode, workingFacingRef.current));
        setFacingMode(workingFacingRef.current);
        return;
      }
      const e: any = err;
      setError(
        e?.name === 'NotAllowedError'
          ? 'Camera/microphone access was denied. Allow access in your browser settings, or use file upload instead.'
          : `Could not start the camera: ${e?.message || e}`,
      );
      return;
    }
    if (myGeneration !== streamGenerationRef.current) {
      // Superseded while the camera was opening: stop OUR stream (it
      // was never put in streamRef, so nothing else will ever stop
      // it — leaving it live is the leak this guard exists to close)
      // and let the newer call's stream win.
      acquired.stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Best-effort cleanup of a stream nobody will use.
        }
      });
      return;
    }
    const stream = acquired.stream;
    {
      const attempt = acquired.attempt;
      const askedVideo = attempt.constraints.video as MediaTrackConstraints | undefined;
      const idealDim = (c: unknown): number =>
        c && typeof c === 'object' && typeof (c as { ideal?: unknown }).ideal === 'number'
          ? ((c as { ideal: number }).ideal as number)
          : 0;
      lastNegotiationRef.current = {
        asked: {
          shortSide: attempt.shortSide,
          frameRate: attempt.frameRate,
          width: idealDim(askedVideo?.width),
          height: idealDim(askedVideo?.height),
        },
        granted: acquired.grantedSettings,
        exactRetried: acquired.negotiated?.exactRetried ?? false,
        usedExact: acquired.negotiated?.usedExact ?? false,
        // Rung C — the negotiated outcome carries the verdict on
        // pass 1; the fallback passes (no negotiation) judge the
        // final grant against the winning attempt's ask directly.
        orientationMismatch:
          acquired.negotiated?.orientationMismatch ??
          orientationMismatchBetween(
            { width: idealDim(askedVideo?.width), height: idealDim(askedVideo?.height) },
            acquired.grantedSettings,
          ),
      };
    }
    workingFacingRef.current = facingMode;
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play().catch(() => {});
    }
    if (myGeneration !== streamGenerationRef.current) {
      // Superseded during play(): the newer call owns streamRef and
      // the screen now — stop only OUR tracks (never stopStream(),
      // which would kill the newer call's stream) and bow out before
      // the census/warm-up bookkeeping can run against this stream.
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Best-effort cleanup of a stream nobody will use.
        }
      });
      return;
    }
    // R24 WS-P4a: surface the track's real zoom capability, if any.
    // Silent absence elsewhere (notably iOS Safari) — no control renders.
    try {
      const track = stream.getVideoTracks()[0];
      const capability = track?.getCapabilities ? zoomCapabilityFromCapabilities(track.getCapabilities()) : null;
      setZoomCapability(capability);
      if (capability) {
        const settings = track.getSettings?.() as { zoom?: number } | undefined;
        const applied = typeof settings?.zoom === 'number' ? settings.zoom : capability.min;
        setZoomValue(applied);
        zoomAppliedRef.current = applied;
      }
    } catch {
      setZoomCapability(null);
    }
    // R41 WS-A — per-facing capability census at camera open: read
    // the live track's capability RANGES once per facing per session
    // (unless a previous attempt found none — then a later open may
    // retry). Cheap: ranges only, no extra stream. The device count
    // comes from the enumeration (labels/count only — no deviceId
    // is ever stored). Persisted onto the facing's proven profile
    // when one exists; otherwise the next proven-profile save for
    // this facing carries it (see saveProvenProfile).
    if (!censusSessionRef.current[facingMode]) {
      try {
        const track = stream.getVideoTracks()[0];
        const census = track?.getCapabilities ? censusFromCapabilities(track.getCapabilities(), 0) : null;
        if (census) {
          const facingAtCapture = facingMode;
          censusSessionRef.current[facingAtCapture] = census;
          setCensusByFacing((prev) => ({ ...prev, [facingAtCapture]: census }));
          saveFacingCensus(browserLocalStorage(), facingAtCapture, census);
          void (async () => {
            try {
              const devices = await navigator.mediaDevices?.enumerateDevices();
              const count = countVideoInputs(devices);
              const current = censusSessionRef.current[facingAtCapture];
              if (devices && current && count > 0 && count !== current.deviceCount) {
                const withCount = { ...current, deviceCount: count };
                censusSessionRef.current[facingAtCapture] = withCount;
                setCensusByFacing((prev) => ({ ...prev, [facingAtCapture]: withCount }));
                saveFacingCensus(browserLocalStorage(), facingAtCapture, withCount);
              }
            } catch {
              // Count is a nice-to-have census field only.
            }
          })();
        }
      } catch {
        // Census is a measurement layer; its failure leaves the
        // generic ladder in charge, exactly as before R41.
      }
    }
    // R32 Phase 2 — warm-up: let auto focus / exposure / white
    // balance settle (~800ms) before reading the capabilities and
    // settings the locks, receipt-adjacent state and two-pass
    // continuity depend on. A cancellable timer only — the preview
    // is already live and Record is never blocked on it; stopStream
    // (or the next startStream) cancels a stale timer, and the
    // stream-identity check guards the race regardless.
    const streamAtStart = stream;
    warmupTimerRef.current = window.setTimeout(() => {
      warmupTimerRef.current = null;
      if (streamRef.current !== streamAtStart) return;
      try {
        const track = streamAtStart.getVideoTracks()[0];
        if (!track) return;
        const caps = cameraControlCapsFromTrack(
          track.getCapabilities ? track.getCapabilities() : null,
          typeof navigator !== 'undefined' && navigator.mediaDevices?.getSupportedConstraints
            ? navigator.mediaDevices.getSupportedConstraints()
            : null,
        );
        setControlCaps(caps);
        const settings = (track.getSettings?.() ?? {}) as Record<string, unknown>;
        if (typeof settings.exposureCompensation === 'number') {
          setExposureCompValue(settings.exposureCompensation);
        }
        // R32 Phase 2 — two-pass colour continuity. Step 1: snapshot
        // the negotiated colour/exposure profile. Step 2: re-apply
        // step 1's targets, clamped to THIS (front) track's ranges —
        // best-effort, failures ignored, and never shown as a lock.
        const phase = twoPassPhaseRef.current;
        if (phase === 'step1-live') {
          continuityProfileRef.current = extractContinuityProfile(settings);
        } else if (phase === 'step2-live' && continuityProfileRef.current && !isRecordingRef.current) {
          // R36 WS-4 — capture discipline: this AUTOMATIC apply must
          // complete BEFORE the step-2 recorder starts. Warm-up runs
          // ~800ms after the stream opens and Record is available
          // immediately, so a fast Record press could otherwise land
          // it mid-take — in that case it is skipped outright (the
          // take records with the front camera's own settings).
          const plan = buildContinuityPlan(continuityProfileRef.current, caps);
          for (const constraints of plan) {
            void track
              .applyConstraints({ advanced: [constraints as MediaTrackConstraintSet] })
              .catch(() => {});
          }
        }
      } catch {
        // Capabilities are a nice-to-have layer; a failure here just
        // leaves the Phase 2 controls absent for this stream.
      }
      setWarmedUp(true);
    }, 800);
    setIsReady(true);
  }, [canvasWidth, canvasHeight, facingMode, qualityChoice, fpsChoice, stopStream]);

  // R29 — how many cameras does this device expose? The "Record both
  // cameras" button only renders at 2+. Best-effort: enumerated on
  // mount, on 'devicechange', and once the stream is ready (labels /
  // counts can settle only after permission is granted); any failure
  // leaves the last count alone.
  useEffect(() => {
    let cancelled = false;
    const updateCount = async () => {
      try {
        const devices = await navigator.mediaDevices?.enumerateDevices();
        if (!devices || cancelled) return;
        setDualCamCount(devices.filter((d) => d.kind === 'videoinput').length);
      } catch {
        // Best-effort only — leave the count as it is.
      }
    };
    const handleDeviceChange = () => {
      void updateCount();
    };
    void updateCount();
    navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange);
    };
  }, [isReady]);

  /**
   * R31 — enter the guided two-pass flow. Two routes, both gated on
   * `onCaptureDual` (the finished pair hands off through it): the
   * live-controls "Record in two steps" button (`viaDualFallback`
   * false) and the dual-failure banner's "Record in two steps
   * instead" button (true — entering from the banner also dismisses
   * it). Step 1 records the main video, so entry aims the camera at
   * the rear: switching `facingMode` re-acquires via the startStream
   * effect; if it is already the rear camera, start directly.
   */
  const enterTwoPass = useCallback(
    (viaDualFallback: boolean) => {
      if (!onCaptureDual || countdownActive) return;
      setDualNotice(null);
      setDualDetails(null);
      setDualWhyOpen(false);
      dropStep1Url();
      twoPassLockRef.current = null;
      step1ReceiptRef.current = null;
      dispatchTwoPass({ type: 'enter', viaDualFallback });
      if (facingMode !== 'environment') {
        setFacingMode('environment');
      } else {
        void startStream();
      }
    },
    [onCaptureDual, countdownActive, dropStep1Url, dispatchTwoPass, facingMode, startStream],
  );

  /**
   * R29 — probe-first entry into dual mode: both cameras are actually
   * opened before dual mode is entered. If the phone/browser can't run
   * both at once, today's single-camera mode resumes and the notice
   * explains why — dual is never faked.
   *
   * R30 — the probe is the v2 in `lib/camera/dualCapture` (low-first
   * video-only pairings, step-down on HAL rejections, settle +
   * frame-flow liveness, deviceId pairing). The microphone is fetched
   * only AFTER both cameras pass, on its own audio-only call, and
   * merged onto the rear stream; a mic failure never blocks dual —
   * it records silently and says so.
   */
  const enterDualMode = useCallback(async () => {
    if (!onCaptureDual || countdownActive) return;
    setDualNotice(null);
    setDualDetails(null);
    setDualWhyOpen(false);
    setDualMicMissing(false);
    setDualBusy(true);
    stopStream();
    try {
      const gum = navigator.mediaDevices?.getUserMedia
        ? (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c)
        : null;
      const result = await probeDualCamera(
        {
          getUserMedia: gum,
          enumerateDevices: navigator.mediaDevices?.enumerateDevices
            ? () => navigator.mediaDevices.enumerateDevices()
            : null,
          framesFlowing: probeStreamFramesFlowing,
        },
        { canvasWidth, canvasHeight },
      );
      if (!result.available) {
        // Diagnostic gold for the next field report: the banner gets
        // the plain-words details line, the console gets the same.
        console.warn(`[RiddimRoom Studio] Dual camera unavailable — ${result.details}`);
        setDualNotice(DUAL_UNAVAILABLE_MESSAGE);
        setDualDetails(result.details);
        setDualWhyOpen(false);
        void startStream();
        return;
      }
      // Mic LAST, separate call (R30): merged onto the rear stream so
      // the rear recorder captures it; failure = silent dual + note.
      const mic = await attachMicrophone(gum, result.rearStream);
      if (!mic.ok) setDualMicMissing(true);
      streamRef.current = result.rearStream;
      frontStreamRef.current = result.frontStream;
      if (videoRef.current) {
        videoRef.current.srcObject = result.rearStream;
        await videoRef.current.play().catch(() => {});
      }
      setDualMode(true);
      setIsReady(true);
    } finally {
      setDualBusy(false);
    }
  }, [onCaptureDual, countdownActive, stopStream, canvasWidth, canvasHeight, startStream]);

  // R29 — attach the front stream to its corner preview once dual mode
  // renders it.
  useEffect(() => {
    if (dualMode && frontVideoRef.current && frontStreamRef.current) {
      frontVideoRef.current.srcObject = frontStreamRef.current;
      void frontVideoRef.current.play().catch(() => {});
    }
  }, [dualMode]);

  // R31 — in two-pass step 2 the corner preview shows the SAME single
  // stream the step-2 recorder records (the front camera, held in
  // `streamRef` — there is no second stream in this flow). Runs when
  // the phase enters step2-live and again when the re-acquired front
  // stream reports ready.
  useEffect(() => {
    if (twoPassPhase === 'step2-live' && frontVideoRef.current && streamRef.current) {
      frontVideoRef.current.srcObject = streamRef.current;
      void frontVideoRef.current.play().catch(() => {});
    }
  }, [twoPassPhase, isReady]);

  /** R29 — leave dual mode and resume today's single-camera stream. */
  const exitDualMode = useCallback(() => {
    stopStream();
    setDualMode(false);
    void startStream();
  }, [stopStream, startStream]);

  useEffect(() => {
    startStream();
    return () => stopStream();
  }, [startStream, stopStream]);

  useEffect(() => () => stopStream(), [stopStream]);

  const takePhoto = useCallback(() => {
    const video = videoRef.current;
    if (!video || !isReady) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setError('This browser could not create a capture canvas.');
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (blob) onCapture({ kind: 'photo', blob });
        else setError('Failed to capture photo.');
      },
      'image/jpeg',
      0.92,
    );
  }, [isReady, onCapture]);

  /**
   * R24 WS-P4a: drive the camera's real zoom. A failed applyConstraints
   * (device busy, value raced a re-acquire, …) must never kill the
   * stream — the slider simply doesn't take effect.
   *
   * R32 Phase 3 — the apply is now an EASED RAMP (~300ms, the pure
   * maths in `lib/camera/motionCoach`): each animation frame applies
   * the eased value between the currently-applied zoom and the
   * slider's target, so the view glides instead of jumping. A new
   * slider input mid-ramp retargets from the current animated value.
   * A rejected apply stops the ramp silently — the same swallowed
   * failure behaviour as the direct call it replaces.
   */
  const applyZoom = useCallback((value: number) => {
    setZoomValue(value);
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track?.applyConstraints) return;
    const now = performance.now();
    const ramp = zoomRampRef.current
      ? retargetZoomRamp(zoomRampRef.current.ramp, value, now)
      : createZoomRamp(zoomAppliedRef.current, value, now);
    if (zoomRampRef.current) cancelAnimationFrame(zoomRampRef.current.raf);
    const state: { ramp: ZoomRamp; raf: number } = { ramp, raf: 0 };
    zoomRampRef.current = state;
    const step = () => {
      if (zoomRampRef.current !== state) return;
      const v = zoomRampValueAt(state.ramp, performance.now());
      zoomAppliedRef.current = v;
      void track
        .applyConstraints({ advanced: [{ zoom: v } as MediaTrackConstraintSet] })
        .catch(() => {
          // Stop the ramp silently (pre-Phase-3 behaviour: a failed
          // zoom apply is swallowed, the stream is never touched).
          if (zoomRampRef.current === state) zoomRampRef.current = null;
        });
      if (zoomRampRef.current !== state) return;
      if (isZoomRampDone(state.ramp, performance.now())) {
        zoomRampRef.current = null;
        return;
      }
      state.raf = requestAnimationFrame(step);
    };
    state.raf = requestAnimationFrame(step);
  }, []);

  /**
   * R32 Phase 2 — tap-to-focus: a tap on the preview element itself
   * (controls are separate elements, so they never reach this
   * handler) asks the track to focus/expose at that point, where
   * pointsOfInterest is offered. Coordinates are normalised against
   * the preview box, x flipped for the mirrored front preview so the
   * tapped point is the focused point. A gold ring marks the tap for
   * ~600ms (fading over the last stretch). Best-effort: a rejected
   * apply just means no ring.
   */
  const handlePreviewTap = useCallback(
    (e: React.MouseEvent<HTMLVideoElement>) => {
      // R36 WS-4 — tap-focus is gated OFF during a take: mid-take,
      // only the ramped zoom and the torch may apply constraints.
      if (!controlCaps?.pointsOfInterest || !isReady || isRecording || pendingVideo || pendingDual) return;
      const track = streamRef.current?.getVideoTracks()[0];
      if (!track?.applyConstraints) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const mirrored = facingMode === 'user' && !dualMode;
      // The ring marks the point as SEEN on screen; the constraint
      // gets the same tap in image space (x flipped when mirrored).
      const seenPoint = normalisedTapPoint(e.clientX, e.clientY, rect, false);
      const point = normalisedTapPoint(e.clientX, e.clientY, rect, mirrored);
      void track
        .applyConstraints({ advanced: [{ pointsOfInterest: [{ x: point.x, y: point.y }] } as MediaTrackConstraintSet] })
        .then(() => {
          focusRingTimersRef.current.forEach((t) => window.clearTimeout(t));
          setFocusPoint(seenPoint);
          setFocusRingFading(false);
          focusRingTimersRef.current = [
            window.setTimeout(() => setFocusRingFading(true), 450),
            window.setTimeout(() => setFocusPoint(null), 620),
          ];
        })
        .catch(() => {});
    },
    [controlCaps, isReady, isRecording, pendingVideo, pendingDual, facingMode, dualMode],
  );

  /**
   * R32 Phase 2 — the Lock toggle. Lock: apply each offered system's
   * manual plan (pinned at its current settings) INDEPENDENTLY — one
   * system's rejection never blocks the others — then read the
   * settings back and claim ONLY the systems that now read 'manual'.
   * Unlock: hand each locked system back to 'continuous' and clear
   * the chip + note.
   */
  const toggleLock = useCallback(async () => {
    // R36 WS-4 — Lock is gated OFF during a take (the button is also
    // disabled then): a lock/unlock apply mid-recording is exactly
    // the automatic-feeling constraint churn this round removes.
    if (isRecordingRef.current) return;
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track?.applyConstraints || !controlCaps) return;
    if (lockedSystems.length > 0) {
      for (const step of buildUnlockPlan(lockedSystems)) {
        try {
          await track.applyConstraints({ advanced: [step.constraints as MediaTrackConstraintSet] });
        } catch {
          // Best-effort per system — the stream is likely gone anyway.
        }
      }
      setLockedSystems([]);
      setLockNote(null);
      return;
    }
    const plan = buildLockPlan(controlCaps, track.getSettings?.() ?? {});
    for (const step of plan) {
      try {
        await track.applyConstraints({ advanced: [step.constraints as MediaTrackConstraintSet] });
      } catch {
        // This system refused — the read-back below simply won't claim it.
      }
    }
    const locked = lockedSystemsFromSettings(
      track.getSettings?.() ?? {},
      plan.map((s) => s.system),
    );
    setLockedSystems(locked);
    setLockNote(exposureLockNote(controlCaps, locked));
  }, [controlCaps, lockedSystems]);

  /**
   * R32 Phase 2 — exposure compensation slider: the value is clamped
   * to the capability range/step by the pure helper; applies are
   * throttled while dragging and always land on release.
   */
  const applyExposureCompensation = useCallback(
    (rawValue: number, force = false) => {
      // R36 WS-4 — the brightness slider is gated OFF during a take
      // (and disabled in the UI then): no exposure applies mid-take.
      if (isRecordingRef.current) return;
      const range = controlCaps?.exposure?.compensationRange;
      if (!range) return;
      const value = clampExposureCompensation(rawValue, range);
      setExposureCompValue(value);
      const now = performance.now();
      if (!force && now - lastCompApplyRef.current < 120) return;
      lastCompApplyRef.current = now;
      const track = streamRef.current?.getVideoTracks()[0];
      if (!track?.applyConstraints) return;
      void track
        .applyConstraints({ advanced: [{ exposureCompensation: value } as MediaTrackConstraintSet] })
        .catch(() => {});
    },
    [controlCaps],
  );

  /**
   * R32 Phase 2 — torch toggle (rear camera, only where the track
   * offers it). State flips only when the apply succeeds; any stream
   * change resets it via stopStream (the track — and its light — is
   * gone).
   */
  const toggleTorch = useCallback(() => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track?.applyConstraints || !controlCaps?.torch) return;
    const next = !torchOn;
    void track
      .applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
      .then(() => setTorchOn(next))
      .catch(() => {});
  }, [controlCaps, torchOn]);

  /**
   * The MediaRecorder creation fallback chain, shared by single and
   * dual recording: tier options with the preferred codec → tier
   * options without mimeType → bare. On total failure it sets the same
   * error message the single path always used and returns null.
   *
   * R32 Phase 1 — the preferred codec now comes from the codec ladder
   * in `captureQuality` (MP4/H.264 first where supported — hardware
   * encode on Android — then VP9, VP8, bare WebM), or from this
   * phone's saved proven mime for the facing when one exists
   * (`preferredMimeType`, tried first). Bitrates are fps-aware via
   * the track's reported settings (see `recorderOptionsForTrackSettings`).
   */
  const createRecorder = useCallback((stream: MediaStream, preferredMimeType?: string): MediaRecorder | null => {
    // R24 WS-P1: bitrate by the tier the device ACTUALLY negotiated
    // (the video track's reported settings), not the browser default.
    const trackSettings = stream.getVideoTracks()[0]?.getSettings?.();
    const isSupported = (mime: string): boolean => {
      try {
        return typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function'
          ? MediaRecorder.isTypeSupported(mime)
          : false;
      } catch {
        return false;
      }
    };
    const ladderMime = pickRecorderMimeType(isSupported);
    const candidates: Array<string | undefined> = [];
    if (preferredMimeType && isSupported(preferredMimeType)) candidates.push(preferredMimeType);
    const ladderCandidate = ladderMime === '' ? undefined : ladderMime;
    if (!candidates.includes(ladderCandidate)) candidates.push(ladderCandidate);
    if (!candidates.includes(undefined)) candidates.push(undefined);
    for (const mimeType of candidates) {
      try {
        return new MediaRecorder(stream, recorderOptionsForTrackSettings(trackSettings, mimeType));
      } catch {
        // This codec/options combination is what the browser rejects —
        // fall through to the next candidate, exactly as the old
        // fixed chain fell through from VP9 to no-mimeType to bare.
      }
    }
    try {
      return new MediaRecorder(stream);
    } catch (err: any) {
      setError(`This browser cannot record video: ${err?.message || err}`);
      return null;
    }
  }, []);

  /**
   * R32 Phase 1 — start measuring presented vs expected frames on the
   * element that displays `stream`, for the recording about to start.
   * The tracker reports null at stop when the browser has no
   * frame-callback support — the receipt then omits the estimate.
   */
  const beginFrameDropTracking = useCallback(
    (video: HTMLVideoElement | null, stream: MediaStream): FrameDropTracker | null => {
      if (!video) return null;
      const settings = stream.getVideoTracks()[0]?.getSettings?.() as { frameRate?: number } | undefined;
      const nominalFps =
        typeof settings?.frameRate === 'number' && settings.frameRate > 0 ? settings.frameRate : fpsChoiceRef.current;
      const tracker = createFrameDropTracker({ nominalFps });
      tracker.start(video);
      return tracker;
    },
    [],
  );

  /** R32 Phase 1 — build the honest receipt for one finished recording.
   *  R41 WS-B — `negotiation`, when the caller passes it, is the
   *  per-take snapshot of the stream's two-stage negotiation (asked
   *  rung + exact-retry outcome), so the receipt can state asked vs
   *  granted. Callers without one (dual) pass nothing. */
  const receiptForRecording = useCallback(
    (
      settings: { width?: number; height?: number; frameRate?: number } | null | undefined,
      mimeType: string,
      blob: Blob,
      startedAtMs: number,
      frameDropEstimate: FrameDropEstimate | null,
      negotiation?: {
        asked: { shortSide: number; frameRate: number; width: number; height: number };
        exactRetried: boolean;
        usedExact: boolean;
        orientationMismatch: boolean;
      } | null,
    ): CaptureReceipt =>
      buildCaptureReceipt({
        trackSettings: settings ?? null,
        mimeType,
        blobSize: blob.size,
        durationSeconds: Math.max(0, (performance.now() - startedAtMs) / 1000),
        droppedFramesEstimate: frameDropEstimate?.droppedFramesEstimate ?? null,
        expectedFramesEstimate: frameDropEstimate?.expectedFrames ?? null,
        asked: negotiation ? negotiation.asked : null,
        exactRetryAttempted: negotiation?.exactRetried,
        exactRetryUsed: negotiation?.usedExact,
        orientationMismatch: negotiation?.orientationMismatch,
      }),
    [],
  );

  /** The current stream's negotiation, snapshotted for one take (null for streams that never negotiated). */
  const negotiationSnapshotForTake = useCallback(() => {
    const n = lastNegotiationRef.current;
    if (!n) return null;
    return {
      asked: {
        shortSide: n.asked.shortSide,
        frameRate: n.asked.frameRate,
        width: n.asked.width,
        height: n.asked.height,
      },
      exactRetried: n.exactRetried,
      usedExact: n.usedExact,
      orientationMismatch: n.orientationMismatch,
    };
  }, []);

  /**
   * R41 Step 3 Rung B — steady one finished take before it becomes
   * project media, and restate its receipt for the file that will
   * actually be saved: the size becomes the saved file's size, the
   * timing line records the outcome ("Steadied to an even 30fps" /
   * "Original timing kept"), everything else — capture facts, asked
   * vs granted, the orientation verdict, the drop estimate — carries
   * over untouched. `steadyCameraTake` never throws and never loses
   * the take: any decline returns the recorded blob unchanged.
   */
  const steadyTakeForProject = useCallback(
    async (blob: Blob, receipt: CaptureReceipt): Promise<{ blob: Blob; receipt: CaptureReceipt }> => {
      const outcome = await steadyCameraTake(blob, { targetFps: receipt.actualFps });
      const finalReceipt = buildCaptureReceipt({
        trackSettings: {
          width: receipt.actualWidth > 0 ? receipt.actualWidth : undefined,
          height: receipt.actualHeight > 0 ? receipt.actualHeight : undefined,
          frameRate: receipt.actualFps > 0 ? receipt.actualFps : undefined,
        },
        mimeType: outcome.blob.type || receipt.mimeType,
        blobSize: outcome.blob.size,
        durationSeconds: receipt.durationSeconds,
        droppedFramesEstimate: receipt.droppedFramesEstimate ?? null,
        expectedFramesEstimate: receipt.expectedFramesEstimate ?? null,
        asked:
          receipt.askedShortSide > 0
            ? {
                shortSide: receipt.askedShortSide,
                frameRate: receipt.askedFps,
                width: receipt.askedWidth,
                height: receipt.askedHeight,
              }
            : null,
        exactRetryAttempted: receipt.exactRetryAttempted,
        exactRetryUsed: receipt.exactRetryUsed,
        orientationMismatch: receipt.orientationMismatch,
        timingOutcome: outcome.status === 'steadied' ? 'steadied' : 'original',
        steadiedFps: outcome.status === 'steadied' ? outcome.plan.targetFps : undefined,
      });
      return { blob: outcome.blob, receipt: finalReceipt };
    },
    [],
  );

  /**
   * R29 — record BOTH cameras at once. The mic is on the rear stream
   * only (R30: merged there by `attachMicrophone` after the video-only
   * probe; the front stream never carries audio) — there is exactly
   * one audio source. The two recorders start back-to-back on one
   * performance.now() anchor; the measured delta travels with the
   * result so the pair can be lined up on the timeline.
   *
   * R30 — first, ONE best-effort raise of the rear toward 1440p now
   * that both streams are proven live (the probe deliberately opened
   * low, inside the guaranteed concurrent envelope). The helper
   * swallows any refusal, and the recorder tiers below are read from
   * the track settings AFTER the attempt, so a successful raise is
   * recorded at its real tier.
   */
  const startDualRecording = useCallback(async () => {
    if (!dualMode || !isReady || !streamRef.current || !frontStreamRef.current) return;
    await tryRaiseRearResolution(streamRef.current, canvasWidth, canvasHeight);
    // R32 Phase 1 — settings snapshots for the receipts, taken AFTER
    // the best-effort raise so they describe the streams as recorded.
    const rearSettings = streamRef.current.getVideoTracks()[0]?.getSettings?.() ?? null;
    const frontSettings = frontStreamRef.current.getVideoTracks()[0]?.getSettings?.() ?? null;
    const rearRecorder = createRecorder(streamRef.current, provenMimeFor('environment'));
    if (!rearRecorder) return;
    const frontRecorder = createRecorder(frontStreamRef.current);
    if (!frontRecorder) return;
    dualChunksRef.current = { rear: [], front: [] };
    dualStoppedRef.current = 0;
    rearRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) dualChunksRef.current.rear.push(e.data);
    };
    frontRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) dualChunksRef.current.front.push(e.data);
    };
    // R32 Phase 1 — frame-drop measurement on the REAR recording (the
    // main picture), via its live preview element. Local to this
    // recording; stopped in handleDualStop.
    let rearTracker: FrameDropTracker | null = null;
    const handleDualStop = () => {
      dualStoppedRef.current += 1;
      if (dualStoppedRef.current < 2) return;
      const mainBlob = new Blob(dualChunksRef.current.rear, { type: rearRecorder.mimeType || 'video/webm' });
      const frontBlob = new Blob(dualChunksRef.current.front, { type: frontRecorder.mimeType || 'video/webm' });
      const rearEstimate = rearTracker?.stop() ?? null;
      rearTracker = null;
      const rearStartMs = dualStartRef.current?.rearStartMs ?? performance.now();
      const frontStartMs = dualStartRef.current?.frontStartMs ?? rearStartMs;
      const mainReceipt = receiptForRecording(rearSettings, rearRecorder.mimeType, mainBlob, rearStartMs, rearEstimate);
      const frontReceipt = receiptForRecording(frontSettings, frontRecorder.mimeType, frontBlob, frontStartMs, null);
      saveProvenProfile('environment', rearSettings, rearRecorder.mimeType, fpsChoiceRef.current, {
        outcome: rearEstimate
          ? { droppedFrames: rearEstimate.droppedFramesEstimate, expectedFrames: rearEstimate.expectedFrames }
          : null,
        census: censusSessionRef.current['environment'] ?? null,
      });
      // R41 Step 3 Rung B — both takes are steadied before the pair
      // can become project media (see the single path); the measured
      // start delta is captured now, before the async step, and the
      // review then shows the very files the project will get.
      const startDeltaMs = dualStartRef.current ? dualStartRef.current.frontStartMs - dualStartRef.current.rearStartMs : 0;
      stopStream();
      setSteadyingTake(true);
      void (async () => {
        const main = await steadyTakeForProject(mainBlob, mainReceipt);
        const front = await steadyTakeForProject(frontBlob, frontReceipt);
        setSteadyingTake(false);
        setPendingDual({
          mainBlob: main.blob,
          mainUrl: URL.createObjectURL(main.blob),
          frontBlob: front.blob,
          frontUrl: URL.createObjectURL(front.blob),
          startDeltaMs,
          mainReceipt: main.receipt,
          frontReceipt: front.receipt,
        });
        dualStartRef.current = null;
        frontRecorderRef.current = null;
        recorderRef.current = null;
      })();
    };
    rearRecorder.onstop = handleDualStop;
    frontRecorder.onstop = handleDualStop;
    const anchorMs = performance.now();
    // R41 F02 — 250ms timeslice: chunks stream in as the take records
    // instead of one whole-take in-memory Blob at stop (assembly is
    // unchanged — ondataavailable already appends in order).
    rearRecorder.start(250);
    const rearStartMs = performance.now();
    frontRecorder.start(250);
    const frontStartMs = performance.now();
    rearTracker = beginFrameDropTracking(videoRef.current, streamRef.current);
    dualStartRef.current = { anchorMs, rearStartMs, frontStartMs };
    recorderRef.current = rearRecorder;
    frontRecorderRef.current = frontRecorder;
    setIsRecording(true);
    setRecordSeconds(0);
  }, [dualMode, isReady, createRecorder, stopStream, canvasWidth, canvasHeight, beginFrameDropTracking, receiptForRecording, steadyTakeForProject]);

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || !isReady) return;
    if (dualMode) {
      void startDualRecording();
      return;
    }
    // R32 Phase 1 — two-step profile lock: when step 1 starts, pin
    // the choices in force so step 2 reuses exactly them.
    if (twoPassPhaseRef.current === 'step1-live') {
      twoPassLockRef.current = { quality: qualityChoiceRef.current, fps: fpsChoiceRef.current };
    }
    chunksRef.current = [];
    const settingsSnapshot = stream.getVideoTracks()[0]?.getSettings?.() ?? null;
    // R41 WS-B — this take's asked-vs-granted snapshot, taken from
    // the stream's negotiation before the recorder exists.
    const negotiationSnapshot = negotiationSnapshotForTake();
    const recorder = createRecorder(stream, provenMimeFor(facingModeRef.current));
    if (!recorder) {
      // A failed start must not leave a camera test armed.
      testModeRef.current = false;
      setIsTestingCamera(false);
      diagModeRef.current = false;
      setIsDiagRecording(false);
      return;
    }
    // R41 WS-A — a diagnostics take additionally starts the RAW
    // viewfinder frame-series recorder + the longtask collector.
    // Both live only for this take; onstop stops them into the pack.
    if (diagModeRef.current) {
      diagAskedRef.current = lastNegotiationRef.current?.asked ?? null;
      diagRecorderInfoRef.current = {
        mimeType: recorder.mimeType,
        videoBitsPerSecond:
          typeof recorder.videoBitsPerSecond === 'number'
            ? recorder.videoBitsPerSecond
            : recorderOptionsForTrackSettings(settingsSnapshot, recorder.mimeType).videoBitsPerSecond ?? 0,
        audioBitsPerSecond:
          typeof recorder.audioBitsPerSecond === 'number'
            ? recorder.audioBitsPerSecond
            : recorderOptionsForTrackSettings(settingsSnapshot, recorder.mimeType).audioBitsPerSecond ?? 0,
      };
      const rawRecorder = createRawFrameSeriesRecorder();
      if (videoRef.current) rawRecorder.start(videoRef.current);
      diagRawRecorderRef.current = rawRecorder;
      const longtasks = createLongtaskCollector({
        createObserver:
          typeof PerformanceObserver !== 'undefined'
            ? (callback) =>
                new PerformanceObserver((list) => callback({ getEntries: () => list.getEntries() as unknown[] }))
            : null,
        supportedEntryTypes:
          typeof PerformanceObserver !== 'undefined' && Array.isArray(PerformanceObserver.supportedEntryTypes)
            ? PerformanceObserver.supportedEntryTypes
            : null,
      });
      longtasks.start();
      diagLongtaskRef.current = longtasks;
    }
    let tracker: FrameDropTracker | null = null;
    let startedAtMs = 0;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'video/webm' });
      // R32 Phase 1 — the honest receipt for this recording, and the
      // proven-settings save (a recording that finished is proof the
      // settings work on this phone).
      const estimate = tracker?.stop() ?? null;
      tracker = null;
      const receipt = receiptForRecording(settingsSnapshot, recorder.mimeType, blob, startedAtMs, estimate, negotiationSnapshot);
      const ceilingUpdate = negotiationSnapshot
        ? provenCeilingUpdate({
            askedShortSide: negotiationSnapshot.asked.shortSide,
            askedFps: negotiationSnapshot.asked.frameRate,
            grantedFps: grantedFps(settingsSnapshot),
          })
        : ({ kind: 'none' } as const);
      if (ceilingUpdate.kind === 'clear') clearProvenFpsCeiling(browserLocalStorage(), facingModeRef.current);
      saveProvenProfile(facingModeRef.current, settingsSnapshot, recorder.mimeType, fpsChoiceRef.current, {
        quality: qualityChoiceRef.current,
        outcome: estimate
          ? { droppedFrames: estimate.droppedFramesEstimate, expectedFrames: estimate.expectedFrames }
          : null,
        census: censusSessionRef.current[facingModeRef.current] ?? null,
        ceiling: ceilingUpdate.kind === 'set' ? ceilingUpdate.ceiling : undefined,
      });
      // R41 WS-A — a diagnostics take ends here: stop the collectors,
      // build the evidence pack, and hold blob + pack for the result
      // panel (download report / save clip / use / discard). The take
      // is NOT routed to the normal review — its panel carries those
      // same choices for this clip.
      if (diagModeRef.current) {
        diagModeRef.current = false;
        setIsDiagRecording(false);
        const frameSeries = diagRawRecorderRef.current?.stop() ?? { timestampsMs: [], presentedFrames: [] };
        diagRawRecorderRef.current = null;
        const longtaskSummary = diagLongtaskRef.current?.stop() ?? {
          available: false,
          count: 0,
          over200Count: 0,
          longestMs: 0,
          entries: [],
        };
        diagLongtaskRef.current = null;
        const recorderInfo = diagRecorderInfoRef.current ?? {
          mimeType: recorder.mimeType,
          videoBitsPerSecond: 0,
          audioBitsPerSecond: 0,
        };
        diagRecorderInfoRef.current = null;
        const pack = buildDiagnosticsEvidencePack({
          createdAt: new Date().toISOString(),
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
          facing: facingModeRef.current,
          qualityChoice: qualityChoiceRef.current,
          fpsChoice: fpsChoiceRef.current,
          durationSeconds: Math.max(0, (performance.now() - startedAtMs) / 1000),
          asked: diagAskedRef.current,
          granted: settingsSnapshot
            ? {
                width: settingsSnapshot.width ?? 0,
                height: settingsSnapshot.height ?? 0,
                frameRate: settingsSnapshot.frameRate ?? 0,
              }
            : null,
          exactRetryAttempted: negotiationSnapshot?.exactRetried ?? false,
          exactRetryUsed: negotiationSnapshot?.usedExact ?? false,
          mimeType: recorderInfo.mimeType,
          recorderVideoBitsPerSecond: recorderInfo.videoBitsPerSecond,
          recorderAudioBitsPerSecond: recorderInfo.audioBitsPerSecond,
          census: censusSessionRef.current[facingModeRef.current] ?? null,
          frameSeries,
          longtasks: longtaskSummary,
        });
        diagAskedRef.current = null;
        stopStream();
        setDiagResult({ pack, blob, url: URL.createObjectURL(blob), receipt });
        return;
      }
      // R32 Phase 1 — "Test my camera": the test take is measured and
      // profiled above, then DISCARDED — it never reaches a review
      // state, the timeline or the project. The live camera restarts
      // behind the results card.
      if (testModeRef.current) {
        testModeRef.current = false;
        setIsTestingCamera(false);
        setTestReceipt(receipt);
        stopStream();
        void startStream();
        return;
      }
      // R41 Step 3 Rung B — the take is steadied to an even frame
      // rate BEFORE it can become project media; the review below
      // therefore shows (and the flow retains) the very file the
      // project will get, with the receipt restated for it. The
      // live stream stops first — the camera doesn't need to stay
      // hot while the file is prepared — and the "Steadying your
      // take…" state covers the surface until the review is ready.
      stopStream();
      setSteadyingTake(true);
      void (async () => {
        const final = await steadyTakeForProject(blob, receipt);
        setSteadyingTake(false);
        // R31 — in two-pass step 1 this same stop also feeds the flow:
        // the blob becomes the machine's main take, and the flow retains
        // its OWN object URL for it in `step1UrlRef` (separate from the
        // review URL `pendingVideo` gets below — that one is revoked
        // when the review clears, this one must live into step 2).
        if (twoPassPhaseRef.current === 'step1-live') {
          dropStep1Url();
          step1UrlRef.current = URL.createObjectURL(final.blob);
          step1ReceiptRef.current = final.receipt;
          dispatchTwoPass({ type: 'step1-recorded', blob: final.blob });
        }
        // Hold for the review state (see `pendingVideo`) instead of handing
        // off immediately — the review <video> replaces the live preview
        // in the same frame.
        setPendingVideo({ blob: final.blob, url: URL.createObjectURL(final.blob), receipt: final.receipt });
      })();
    };
    // R41 F02 — 250ms timeslice, as on the dual paths (see there).
    recorder.start(250);
    startedAtMs = performance.now();
    tracker = beginFrameDropTracking(videoRef.current, stream);
    recorderRef.current = recorder;
    setIsRecording(true);
    setRecordSeconds(0);
  }, [isReady, stopStream, dualMode, startDualRecording, createRecorder, dropStep1Url, dispatchTwoPass, beginFrameDropTracking, receiptForRecording, startStream, negotiationSnapshotForTake, steadyTakeForProject]);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    // R29 — in dual mode the front recorder stops too; in single mode
    // this ref is always null, so this is a no-op there.
    frontRecorderRef.current?.stop();
    frontRecorderRef.current = null;
    setIsRecording(false);
  }, []);

  /**
   * R31 — step-1 review "Use this — next step": keep the main take
   * and move to step 2. Clearing `pendingVideo` revokes ONLY the
   * review's own URL (its effect) — the retained step-1 URL in
   * `step1UrlRef` is a separate URL for the same blob and survives.
   * Step 2 records on the FRONT camera: switching `facingMode`
   * re-acquires via the startStream effect; if step 1 was itself
   * flipped to the front camera, start the (stopped) stream directly.
   */
  const keepStep1 = useCallback(() => {
    dispatchTwoPass({ type: 'keep-step1' });
    setPendingVideo(null);
    if (facingMode !== 'user') {
      setFacingMode('user');
    } else {
      // R32 Phase 1 — pass step 1's locked choices explicitly: this
      // call happens in the same tick as the phase transition, before
      // the phase ref inside startStream has caught up.
      void startStream(twoPassLockRef.current ?? undefined);
    }
  }, [dispatchTwoPass, facingMode, startStream]);

  /**
   * R31 — record step 2: the front camera over the kept main take's
   * playback. Deliberately NOT the single path (`startRecording`'s
   * onstop routes to `pendingVideo`); this dedicated recorder routes
   * its stop to `pendingDual` with the pair + measured delta.
   *
   * Start order is the alignment: the recorder starts FIRST, then
   * playback is driven from frame 0. `recorderStartMs` is taken just
   * after `recorder.start()`; the playback anchor is the playback
   * element's one-time 'playing' event (first frames actually
   * presented), with the moment playback was driven as the fallback
   * anchor when 'playing' never fires. The playback element is NOT
   * muted — the main video plays with sound while the front stream
   * (whose microphone is live) records, which is exactly what
   * `TWO_PASS_STEP2_TIP` warns about. Playback 'ended' auto-stops
   * the recording (see the element's `onEnded` in the JSX).
   * The recorder lives in `recorderRef`, so the existing Stop
   * button, REC timer and 10-minute cap all work unchanged.
   */
  const startStep2Recording = useCallback(() => {
    const stream = streamRef.current;
    const mainBlob = twoPass.mainBlob;
    const mainUrl = step1UrlRef.current;
    if (!stream || !isReady || !mainBlob || !mainUrl) return;
    // R32 Phase 1 — step 2 records on the FRONT camera with step 1's
    // locked profile; its proven mime (when saved) is the front one.
    const settingsSnapshot = stream.getVideoTracks()[0]?.getSettings?.() ?? null;
    // R41 WS-B — step 2's stream went through startStream too, so it
    // carries its own negotiation snapshot for its receipt.
    const negotiationSnapshot = negotiationSnapshotForTake();
    const recorder = createRecorder(stream, provenMimeFor('user'));
    if (!recorder) return;
    step2ChunksRef.current = [];
    // R32 Phase 1 — frame-drop measurement on the element that shows
    // the front stream in step 2 (the corner preview).
    let tracker: FrameDropTracker | null = null;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) step2ChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const frontBlob = new Blob(step2ChunksRef.current, { type: recorder.mimeType || 'video/webm' });
      const anchors = step2AnchorsRef.current;
      const recorderStartMs = anchors?.recorderStartMs ?? performance.now();
      const playbackStartMs = anchors?.playbackAnchorMs ?? anchors?.fallbackAnchorMs ?? recorderStartMs;
      const startDeltaMs = twoPassStartDeltaMs(playbackStartMs, recorderStartMs);
      step2AnchorsRef.current = null;
      // R32 Phase 1 — receipts for the pair review: step 2's own, and
      // step 1's carried over (rebuilt bare only in the impossible
      // case the step-1 receipt is missing — size/fps then honestly
      // read as unknown rather than invented).
      const estimate = tracker?.stop() ?? null;
      tracker = null;
      const frontReceipt = receiptForRecording(settingsSnapshot, recorder.mimeType, frontBlob, recorderStartMs, estimate, negotiationSnapshot);
      const mainReceipt =
        step1ReceiptRef.current ??
        buildCaptureReceipt({ trackSettings: null, mimeType: mainBlob.type, blobSize: mainBlob.size, durationSeconds: 0 });
      const ceilingUpdate = negotiationSnapshot
        ? provenCeilingUpdate({
            askedShortSide: negotiationSnapshot.asked.shortSide,
            askedFps: negotiationSnapshot.asked.frameRate,
            grantedFps: grantedFps(settingsSnapshot),
          })
        : ({ kind: 'none' } as const);
      if (ceilingUpdate.kind === 'clear') clearProvenFpsCeiling(browserLocalStorage(), 'user');
      saveProvenProfile('user', settingsSnapshot, recorder.mimeType, fpsChoiceRef.current, {
        quality: twoPassLockRef.current?.quality ?? qualityChoiceRef.current,
        outcome: estimate
          ? { droppedFrames: estimate.droppedFramesEstimate, expectedFrames: estimate.expectedFrames }
          : null,
        census: censusSessionRef.current['user'] ?? null,
        ceiling: ceilingUpdate.kind === 'set' ? ceilingUpdate.ceiling : undefined,
      });
      // R41 Step 3 Rung B — the step-2 take is steadied before the
      // pair can become project media; the step-1 take was already
      // steadied at its own stop, so only this take passes through
      // here. The pair review then shows the files the project gets.
      stopStream();
      setSteadyingTake(true);
      void (async () => {
        const front = await steadyTakeForProject(frontBlob, frontReceipt);
        setSteadyingTake(false);
        // Transfer the retained step-1 URL into pendingDual: clearing
        // the ref hands ownership to the pendingDual effect, which
        // revokes it when the review clears.
        step1UrlRef.current = null;
        dispatchTwoPass({ type: 'step2-recorded', blob: front.blob, startDeltaMs });
        setPendingDual({
          mainBlob,
          mainUrl,
          frontBlob: front.blob,
          frontUrl: URL.createObjectURL(front.blob),
          startDeltaMs,
          mainReceipt,
          frontReceipt: front.receipt,
        });
      })();
    };
    // R41 F02 — 250ms timeslice, as on the other record paths.
    recorder.start(250);
    tracker = beginFrameDropTracking(frontVideoRef.current, stream);
    const recorderStartMs = performance.now();
    recorderRef.current = recorder;
    const anchors: { recorderStartMs: number; playbackAnchorMs: number | null; fallbackAnchorMs: number } = {
      recorderStartMs,
      playbackAnchorMs: null,
      fallbackAnchorMs: recorderStartMs,
    };
    step2AnchorsRef.current = anchors;
    const playback = step2PlaybackRef.current;
    if (playback) {
      playback.currentTime = 0;
      anchors.fallbackAnchorMs = performance.now();
      const onPlaying = () => {
        anchors.playbackAnchorMs = performance.now();
      };
      playback.addEventListener('playing', onPlaying, { once: true });
      void playback.play().catch(() => {});
    }
    setIsRecording(true);
    setRecordSeconds(0);
  }, [isReady, createRecorder, stopStream, dispatchTwoPass, twoPass.mainBlob, beginFrameDropTracking, receiptForRecording, negotiationSnapshotForTake, steadyTakeForProject]);

  /** Review-state confirm: hand the SAME CaptureResult to the normal path or the overlay path, per the user's pick. */
  const confirmPendingVideo = useCallback(
    (asOverlay: boolean) => {
      if (!pendingVideo) return;
      const result: CaptureResult = { kind: 'video', blob: pendingVideo.blob, receipt: pendingVideo.receipt };
      recordTakeHealthFromReceipt(pendingVideo.receipt, idToken);
      setPendingVideo(null);
      if (asOverlay && onCaptureAsOverlay) onCaptureAsOverlay(result);
      else onCapture(result);
    },
    [pendingVideo, onCapture, onCaptureAsOverlay, idToken],
  );

  /** Review-state discard: drop the recording and return to the live camera. */
  const discardPendingVideo = useCallback(() => {
    setPendingVideo(null);
    void startStream();
  }, [startStream]);

  /** R29 dual review confirm: hand BOTH recordings to the caller together. */
  const confirmDual = useCallback(() => {
    if (!pendingDual || !onCaptureDual) return;
    const payload: CaptureDualResult = {
      main: { kind: 'video', blob: pendingDual.mainBlob, receipt: pendingDual.mainReceipt },
      overlay: { kind: 'video', blob: pendingDual.frontBlob, receipt: pendingDual.frontReceipt },
      startDeltaMs: pendingDual.startDeltaMs,
      layout: dualLayout,
    };
    recordTakeHealthFromReceipt(pendingDual.mainReceipt, idToken);
    setPendingDual(null);
    onCaptureDual(payload);
  }, [pendingDual, onCaptureDual, dualLayout, idToken]);

  /** R29 dual review discard: drop both recordings and re-probe back into dual mode. */
  const discardDual = useCallback(() => {
    setPendingDual(null);
    void enterDualMode();
  }, [enterDualMode]);

  /**
   * R31 — two-pass "Add as a pair": the existing dual confirm (the pair is
   * structurally a dual pair), plus flow cleanup — the machine exits
   * after the handoff. The retained step-1 URL was already
   * transferred into `pendingDual`, so `exitTwoPass`'s URL drop is a
   * no-op here; the pendingDual effect revokes the review URLs.
   */
  const confirmDualTwoPass = useCallback(() => {
    confirmDual();
    exitTwoPass();
  }, [confirmDual, exitTwoPass]);

  /**
   * R31 — retake step 2 from the two-pass review: KEEP the step-1
   * take. Its blob survives in the machine, but its URL is the one
   * transferred into `pendingDual` — which the pendingDual cleanup
   * revokes when the review clears. So BEFORE clearing, mint a FRESH
   * object URL for the main blob into `step1UrlRef`; the stale one
   * is then revoked harmlessly. The front stream is re-acquired
   * directly (facingMode is already 'user').
   */
  const retakeStep2 = useCallback(() => {
    const mainBlob = twoPass.mainBlob ?? pendingDual?.mainBlob;
    if (mainBlob) {
      dropStep1Url();
      step1UrlRef.current = URL.createObjectURL(mainBlob);
    }
    dispatchTwoPass({ type: 'retake-step2' });
    setPendingDual(null);
    void startStream();
  }, [twoPass.mainBlob, pendingDual, dropStep1Url, dispatchTwoPass, startStream]);

  /**
   * R31 — start over from the two-pass review: drop the pair and go
   * back to step 1. No fresh URL is minted — the step-1 take is
   * being dropped too; clearing `pendingDual` revokes the
   * transferred URL, and the camera aims back at the rear for a new
   * step 1 (switching `facingMode` re-acquires; if it is somehow
   * already the rear camera, start directly).
   */
  const startOverTwoPass = useCallback(() => {
    dropStep1Url();
    step1ReceiptRef.current = null;
    dispatchTwoPass({ type: 'start-over' });
    setPendingDual(null);
    if (facingMode !== 'environment') {
      setFacingMode('environment');
    } else {
      void startStream();
    }
  }, [dropStep1Url, dispatchTwoPass, facingMode, startStream]);

  /**
   * R32 Phase 1 — "Test my camera": a guided 10-second test on the
   * current camera through the NORMAL single recorder (test mode
   * flags its stop: measure + save the proven profile, show the
   * receipt card, discard the take). Nothing is added anywhere.
   */
  const startCameraTest = useCallback(() => {
    if (!isReady || isRecording || countdownActive || dualMode || twoPassPhase !== 'off' || pendingVideo || pendingDual) return;
    setTestReceipt(null);
    testModeRef.current = true;
    setIsTestingCamera(true);
    startRecording();
  }, [isReady, isRecording, countdownActive, dualMode, twoPassPhase, pendingVideo, pendingDual, startRecording]);

  // The test auto-stops at 10 seconds (the normal 10-minute cap
  // effect below still applies to every other recording).
  useEffect(() => {
    if (isTestingCamera && isRecording && recordSeconds >= 10) {
      stopRecording();
    }
  }, [isTestingCamera, isRecording, recordSeconds, stopRecording]);

  /**
   * R41 WS-A — start the diagnostics session: one guided
   * 60-second take through the NORMAL single record path (so the
   * evidence reflects shipped behaviour, two-stage negotiation
   * included), flagged so its stop builds the evidence pack
   * instead of the normal review. Uses the current camera, facing
   * and quality selection, exactly as the intro screen states.
   */
  const startDiagnosticsSession = useCallback(() => {
    if (!isReady || isRecording || countdownActive || dualMode || twoPassPhase !== 'off' || pendingVideo || pendingDual) return;
    setDiagIntroOpen(false);
    setDiagResult(null);
    setTestReceipt(null);
    diagModeRef.current = true;
    setIsDiagRecording(true);
    startRecording();
  }, [isReady, isRecording, countdownActive, dualMode, twoPassPhase, pendingVideo, pendingDual, startRecording]);

  // The diagnostics take auto-stops at the script's 60 seconds.
  useEffect(() => {
    if (isDiagRecording && isRecording && recordSeconds >= DIAGNOSTICS_TOTAL_SECONDS) {
      stopRecording();
    }
  }, [isDiagRecording, isRecording, recordSeconds, stopRecording]);

  /** Download a blob as a file (the report JSON / the test clip). Nothing is uploaded, ever. */
  const downloadBlobFile = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }, []);

  const downloadDiagnosticsReport = useCallback(() => {
    if (!diagResult) return;
    const json = diagnosticsReportJson(diagResult.pack);
    downloadBlobFile(new Blob([json], { type: 'application/json' }), 'camera-smoothness-report.json');
  }, [diagResult, downloadBlobFile]);

  const downloadDiagnosticsClip = useCallback(() => {
    if (!diagResult) return;
    const extension = diagResult.blob.type.includes('mp4') ? 'mp4' : 'webm';
    downloadBlobFile(diagResult.blob, `camera-smoothness-clip.${extension}`);
  }, [diagResult, downloadBlobFile]);

  /**
   * Diagnostics result "Use this clip": the normal confirm path,
   * health line included — the clip becomes project media, so it is
   * steadied like any other take first (Rung B). The "Save the test
   * clip" download above is NOT this path: it keeps delivering the
   * raw recorded file, because that file is the measurement
   * instrument for capture truth.
   */
  const useDiagnosticsClip = useCallback(() => {
    if (!diagResult) return;
    const snapshot = diagResult;
    setSteadyingTake(true);
    void (async () => {
      const final = await steadyTakeForProject(snapshot.blob, snapshot.receipt);
      recordTakeHealthFromReceipt(final.receipt, idToken);
      setSteadyingTake(false);
      setDiagResult(null);
      onCapture({ kind: 'video', blob: final.blob, receipt: final.receipt });
    })();
  }, [diagResult, onCapture, idToken, steadyTakeForProject]);

  /** Diagnostics result "Discard": drop the clip + pack and return to the live camera. */
  const discardDiagnostics = useCallback(() => {
    setDiagResult(null);
    void startStream();
  }, [startStream]);

  useEffect(() => {
    if (!isRecording) return;
    const interval = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [isRecording]);

  // "Universal 30-second media standard" — automatic stop at the limit,
  // rather than relying on the user to notice the timer and click Stop
  // themselves. Fires as soon as `recordSeconds` reaches the cap.
  useEffect(() => {
    if (isRecording && recordSeconds >= MAX_MEDIA_SECONDS) {
      stopRecording();
    }
  }, [isRecording, recordSeconds, stopRecording]);

  // R32 Phase 2 — light meter sampler: draw the live preview into a
  // tiny (<= 96px wide) offscreen canvas and analyse it with the
  // pure meter. Runs only while a single-camera stream is live
  // and warmed up — never during review, dual mode or two-pass step
  // 2 (whose main frame is playback, not the camera) — and stops
  // with the stream. It only ever ADVISES; it never touches the
  // user's quality/fps choices.
  //
  // R36 WS-4 — schedule + output discipline: BEFORE a take the meter
  // samples at the full ~4Hz; WHILE RECORDING it slows to at most
  // 1/sec and the zebra recomputation is PAUSED (the grid keeps its
  // last pre-take painting), so the canvas analysis pass never runs
  // at 4Hz during a take. Outputs: the full reading goes to a ref;
  // the pill state and the advice line reach React state ONLY on
  // value transitions (the gates in readoutGate); the zebra cells
  // are painted by direct DOM writes.
  useEffect(() => {
    if (!warmedUp || !isReady || dualMode || isStep2Phase || pendingVideo || pendingDual || error) return;
    let cancelled = false;
    const canvas = document.createElement('canvas');
    const recording = isRecording;
    const sample = () => {
      const video = videoRef.current;
      if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return;
      const width = 96;
      const height = Math.max(1, Math.round((width * video.videoHeight) / video.videoWidth));
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      try {
        ctx.drawImage(video, 0, 0, width, height);
        const image = ctx.getImageData(0, 0, width, height);
        if (cancelled) return;
        // R41 Step 3 Rung A, Part 2 (F05) — while recording the zebra
        // result is discarded under the zebraRecomputedWhile gate
        // below, so don't pay for the per-cell zebra maths at all.
        const result = analyzeLightSample({
          data: image.data,
          width,
          height,
          format: 'rgba',
          computeZebra: zebraRecomputedWhile(recording),
        });
        lightResultRef.current = result;
        if (lightStateGateRef.current.push(result.state)) {
          setLightState(result.state);
        }
        const advice = lightAdvice(result, {
          demandingCapture: qualityChoice !== 'hd' || fpsChoice === 60,
          torchAvailable: facingMode === 'environment' && controlCaps?.torch === true,
        });
        if (meterAdviceGateRef.current.push(advice)) {
          setMeterAdviceText(advice);
        }
        if (zebraRecomputedWhile(recording)) {
          // R40 P-38: keep the grid before painting it — the cells
          // may not be mounted yet (the container mounts only once
          // anyOn flips), and the mount paint reads this ref.
          lastZebraCellsRef.current = [...result.zebraCells];
          let anyOn = false;
          result.zebraCells.forEach((flagged, i) => {
            if (flagged) anyOn = true;
            const cell = zebraCellRefs.current[i];
            if (cell) cell.style.display = flagged ? 'block' : 'none';
          });
          if (zebraAnyGateRef.current.push(anyOn)) {
            setZebraAnyOn(anyOn);
          }
        }
      } catch {
        // A frame that can't be read (stream mid-swap) is skipped —
        // the next tick samples again.
      }
    };
    sample();
    const interval = window.setInterval(sample, meterIntervalMs(recording));
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [warmedUp, isReady, dualMode, isStep2Phase, pendingVideo, pendingDual, error, isRecording, qualityChoice, fpsChoice, facingMode, controlCaps]);

  // R40 P-38 — when the zebra container (re)mounts on a false→true
  // toggle, paint every cell immediately from the last computed grid
  // instead of leaving fresh hidden cells until the next sample.
  useLayoutEffect(() => {
    if (!zebraAnyOn || isStep2Phase || pendingVideo || pendingDual) return;
    zebraCellRefs.current.forEach((cell, i) => paintZebraCell(cell, i));
  }, [zebraAnyOn, isStep2Phase, pendingVideo, pendingDual, paintZebraCell]);

  // R32 Phase 3 — motion sampler: while the steady-start countdown
  // is up OR a recording is running, sample motion at ~4Hz. Gyro is
  // primary (DeviceMotion rotationRate, accumulated into a rolling
  // window); the frame-difference estimate (successive tiny preview
  // frames, light-meter style) is the fallback when no gyro answers.
  // All decisions are the pure module's; this effect only collects.
  // Note the sampler never prompts for motion permission — where a
  // platform gates motion events behind one, the gyro simply stays
  // silent and the frame-diff fallback carries the coach.
  useEffect(() => {
    if (!countdownActive && !isRecording) return;
    const buffer = motionBufferRef.current;
    buffer.gyro = [];
    buffer.diffs = [];
    buffer.lastFrame = null;
    levelHistoryRef.current = [];
    // R41 Step 3 Rung A, Part 2 (F03/F04) — while recording, sensor
    // events enter the buffer at most ~1Hz; before a take (the
    // countdown) every event is accepted, exactly as before. This
    // timestamp is owned by this effect and resets on every setup
    // (the effect re-runs when isRecording flips).
    let lastAcceptedMotionMs = 0;
    const onMotion = (e: DeviceMotionEvent) => {
      const sample = gyroSampleFromRotationRate(e.rotationRate);
      if (sample) {
        const nowMs = performance.now();
        if (!motionSampleAccepted(lastAcceptedMotionMs, nowMs, isRecording)) return;
        lastAcceptedMotionMs = nowMs;
        buffer.gyro.push(sample);
        if (buffer.gyro.length > 12) buffer.gyro.shift();
      }
    };
    window.addEventListener('devicemotion', onMotion);
    const canvas = document.createElement('canvas');
    const tick = () => {
      const video = dualMode
        ? videoRef.current
        : twoPassPhase === 'step2-live'
          ? frontVideoRef.current
          : videoRef.current;
      if (video && video.videoWidth > 0 && video.videoHeight > 0) {
        const width = 48;
        const height = Math.max(1, Math.round((width * video.videoHeight) / video.videoWidth));
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          try {
            ctx.drawImage(video, 0, 0, width, height);
            const image = ctx.getImageData(0, 0, width, height);
            const frame: FrameSampleInput = { data: image.data, width, height, format: 'rgba' };
            if (buffer.lastFrame) {
              const diff = meanAbsFrameDiff(buffer.lastFrame, frame);
              if (diff !== null) {
                buffer.diffs.push(diff);
                if (buffer.diffs.length > 12) buffer.diffs.shift();
              }
            }
            buffer.lastFrame = frame;
          } catch {
            // A frame that can't be read (stream mid-swap) is skipped.
          }
        }
      }
      const { level } = assessMotion({ gyroSamples: buffer.gyro, frameDiffs: buffer.diffs });
      levelHistoryRef.current = [...levelHistoryRef.current.slice(-39), level];
    };
    tick();
    // R41 Step 3 Rung A, Part 2 — 250ms before a take (countdown
    // included), at most ~1Hz while recording; isRecording is a dep,
    // so the interval is re-created the moment recording flips.
    const interval = window.setInterval(tick, coachIntervalMs(isRecording));
    return () => {
      window.removeEventListener('devicemotion', onMotion);
      window.clearInterval(interval);
    };
  }, [countdownActive, isRecording, dualMode, twoPassPhase]);

  // R32 Phase 3 — the coach pill follows the sampler's level while
  // recording (single, dual and step-2 alike — all share this
  // recording state); it clears the moment recording stops.
  //
  // R36 WS-4 — the pill is painted by DIRECT DOM WRITES, never React
  // state: the pure coach gate (readoutGate) applies hysteresis (a
  // new level must persist across two consecutive samples) and a
  // 500ms minimum between visible changes, so even the DOM paints
  // are rare; the sampler ticks write nothing to React at all.
  useEffect(() => {
    if (!isRecording) {
      coachGateRef.current.reset();
      if (coachPillRef.current) coachPillRef.current.style.display = 'none';
      return;
    }
    const interval = window.setInterval(() => {
      const { level } = assessMotion({
        gyroSamples: motionBufferRef.current.gyro,
        frameDiffs: motionBufferRef.current.diffs,
      });
      const next = coachGateRef.current.push(level, performance.now());
      if (next === undefined) return;
      const pill = coachPillRef.current;
      if (!pill) return;
      if (next === null) {
        pill.style.display = 'none';
        return;
      }
      pill.textContent = next.text;
      pill.className = `absolute bottom-3 left-3 text-[10px] font-bold uppercase tracking-wide text-white rounded px-2 py-1 pointer-events-none ${
        next.tone === 'good' ? 'bg-emerald-600/85' : next.tone === 'warn' ? 'bg-amber-600/90' : 'bg-red-600/90'
      }`;
      pill.style.display = 'block';
      // R41 Step 3 Rung A, Part 2 — this effect only runs while
      // recording, so coachIntervalMs(isRecording) is the ~1Hz
      // in-take cadence here; the pill clears when recording stops.
    }, coachIntervalMs(isRecording));
    return () => window.clearInterval(interval);
  }, [isRecording]);

  /**
   * R32 Phase 3 — finish the steady-start countdown: run the pending
   * recorder start EXACTLY as it would have run without the countdown
   * (the existing start functions and their timestamps are untouched —
   * the countdown happens entirely before them). Also the Skip action.
   */
  const completeCountdown = useCallback(() => {
    const start = countdownPendingRef.current;
    countdownPendingRef.current = null;
    setCountdownActive(false);
    start?.();
  }, []);

  // R32 Phase 3 — the countdown itself: 3-2-1 over three seconds,
  // finishing EARLY the moment the pure steady decision says the
  // phone is still enough, and finishing anyway when the count
  // completes — it never hard-blocks a recording.
  useEffect(() => {
    if (!countdownActive) return;
    // R36 WS-4 — the display state is set only when the DIGIT
    // changes (3 renders per countdown, not ~20): the 150ms tick
    // still polls the early-finish decision at full rate, it just
    // no longer re-renders for a digit that has not moved.
    countdownDisplayGateRef.current.reset();
    if (countdownDisplayGateRef.current.push(3)) setCountdownDisplay(3);
    const startedAt = performance.now();
    const interval = window.setInterval(() => {
      const elapsed = performance.now() - startedAt;
      const digit = countdownDisplayForElapsed(elapsed);
      if (countdownDisplayGateRef.current.push(digit)) {
        setCountdownDisplay(digit);
      }
      if (elapsed >= 3000 || isStillEnough(levelHistoryRef.current)) {
        completeCountdown();
      }
    }, 150);
    return () => window.clearInterval(interval);
  }, [countdownActive, completeCountdown]);

  /**
   * R32 Phase 3 — the Record press, routed through steady-start:
   * with the toggle OFF (or a countdown already running) the start
   * function runs immediately, byte-identical to before; with it ON
   * the start is held behind the countdown overlay.
   */
  const beginWithSteadyStart = useCallback(
    (startFn: () => void) => {
      if (countdownActive) return;
      if (!steadyStartEnabled) {
        startFn();
        return;
      }
      levelHistoryRef.current = [];
      countdownPendingRef.current = startFn;
      setCountdownActive(true);
    },
    [countdownActive, steadyStartEnabled],
  );

  // R32 Phase 3 — level indicator listener: DeviceOrientation
  // beta/gamma → the pure horizon-tilt conversion. The listener only
  // exists while the Level toggle is on.
  //
  // R36 WS-4 — orientation events can fire dozens of times a second
  // while the phone moves; every one used to be a React render.
  // Now the listener paints the horizon line + bubble by direct DOM
  // writes and touches no React state at all.
  useEffect(() => {
    if (!levelEnabled) return;
    const onOrientation = (e: DeviceOrientationEvent) => {
      // R41 Step 3 Rung A, Part 2 (F03) — orientation-driven writes
      // are SUSPENDED while recording: the level freezes at its last
      // pre-take painting and resumes on the next event after stop.
      if (isRecordingRef.current) return;
      const tilt = horizonTiltDegrees(e.beta, e.gamma);
      // R40 P-39: remember the tilt even when the wrap is unmounted
      // (review states) — the remount paint below reads it.
      lastTiltRef.current = tilt;
      const wrap = levelWrapRef.current;
      if (!wrap) return;
      if (tilt === null) {
        wrap.style.display = 'none';
        return;
      }
      paintLevel(tilt);
    };
    window.addEventListener('deviceorientation', onOrientation);
    return () => {
      window.removeEventListener('deviceorientation', onOrientation);
      if (levelWrapRef.current) levelWrapRef.current.style.display = 'none';
    };
  }, [levelEnabled, paintLevel]);

  // R40 P-39 — when the level wrap remounts (back from a review, or
  // the toggle returning it), paint the last known tilt immediately
  // instead of waiting for the next deviceorientation event — a
  // phone held still fires none.
  useLayoutEffect(() => {
    if (!levelEnabled || pendingVideo || pendingDual || error) return;
    const tilt = lastTiltRef.current;
    if (tilt !== null) paintLevel(tilt);
  }, [levelEnabled, pendingVideo, pendingDual, error, paintLevel]);

  /**
   * R32 Phase 3 — the Level toggle. Where the platform requires a
   * permission request (iOS), it is made HERE — from this explicit
   * tap, never automatically; a refusal simply leaves the toggle off.
   * Where no permission API exists, the toggle just enables the
   * listener.
   */
  const toggleLevel = useCallback(async () => {
    if (levelEnabled) {
      setLevelEnabled(false);
      return;
    }
    if (orientationPermissionNeeded()) {
      try {
        const result = await (
          DeviceOrientationEvent as unknown as { requestPermission: () => Promise<string> }
        ).requestPermission();
        if (result !== 'granted') return;
      } catch {
        return;
      }
    }
    setLevelEnabled(true);
  }, [levelEnabled]);

  /** R32 Phase 3 — the steady-start toggle, persisted to localStorage. */
  const toggleSteadyStart = useCallback(() => {
    setSteadyStartEnabled((prev) => {
      const next = !prev;
      saveSteadyStartEnabled(browserLocalStorage(), next);
      return next;
    });
  }, []);

  const nearLimit = recordSeconds >= MAX_MEDIA_SECONDS - 5;

  // R32 Phase 2 — derived viewfinder values. The lock button renders
  // only when at least one system offers a manual mode; the chip
  // text comes from the pure formatter (exactly the proved locks);
  // the meter advice is computed in context (demanding capture =
  // a 4K-class quality choice or 60fps) and never changes a choice.
  const phase2Lockable = controlCaps ? lockableSystems(controlCaps) : [];
  const lockedChip = formatLockedChip(lockedSystems);
  // R36 WS-4 — the advice line is transition-gated state written by
  // the meter sampler (above); step 2's frame is playback, not the
  // camera, so the line never shows there.
  const meterAdvice = isStep2Phase ? null : meterAdviceText;
  const zebraOn = !isStep2Phase && !pendingVideo && !pendingDual && zebraAnyOn;

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center justify-center gap-4 p-6">
      <div
        className="relative w-full max-w-md bg-black rounded-xl overflow-hidden border border-white/10"
        style={{ aspectRatio: previewAspectRatio }}
      >
        {/* WS-P2: front-camera preview is mirrored via CSS ONLY — the
            stream (and therefore every photo/recording from it) stays
            true-to-life. The review <video> below has NO transform. */}
        <video
          ref={videoRef}
          muted
          playsInline
          onClick={handlePreviewTap}
          className="w-full h-full object-cover"
          style={{
            transform: dualMode ? 'none' : previewMirrorTransform(facingMode),
            // R31 — during two-pass step 2 this element holds the same
            // FRONT stream as the corner preview; the step-1 playback
            // is what fills the frame, so this element is hidden.
            display: isStep2Phase ? 'none' : undefined,
          }}
        />
        {/* R31 — step 2: the kept main video plays back full-frame,
            NOT muted (its sound plays while you record — see
            TWO_PASS_STEP2_TIP), no controls, paused at frame 0 until
            step-2 recording drives it. 'ended' auto-stops recording. */}
        {twoPassPhase === 'step2-live' && step1UrlRef.current && (
          <video
            ref={step2PlaybackRef}
            src={step1UrlRef.current}
            playsInline
            onEnded={() => stopRecording()}
            className="absolute inset-0 w-full h-full object-cover bg-black"
            aria-label="Your main video — plays while you record step 2"
          />
        )}
        {/* WS-P3: framing guides — pure DOM/SVG overlay, pointer-events
            none. The recording path captures the media stream, never
            this DOM, so guides can never appear in a recording. Hidden
            while a recording is being reviewed, and during two-pass
            step 2 (the frame is the step-1 playback, not a live shot
            to frame). */}
        {showGuides && !pendingVideo && !error && !isStep2Phase && (
          <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
            {/* rule of thirds */}
            <div className="absolute top-0 bottom-0 w-px bg-white/35" style={{ left: '33.333%' }} />
            <div className="absolute top-0 bottom-0 w-px bg-white/35" style={{ left: '66.666%' }} />
            <div className="absolute left-0 right-0 h-px bg-white/35" style={{ top: '33.333%' }} />
            <div className="absolute left-0 right-0 h-px bg-white/35" style={{ top: '66.666%' }} />
            {/* headroom guide: keep the subject's head below this line */}
            <div className="absolute left-0 right-0 border-t border-dashed border-gold/80" style={{ top: '12%' }}>
              <span className="absolute left-1/2 -translate-x-1/2 -top-4 text-[9px] font-bold uppercase tracking-widest text-gold/90">
                Headroom
              </span>
            </div>
          </div>
        )}
        {/* R32 Phase 2 — zebra stripes: DOM cells over the preview
            where the light meter's grid says highlights are clipping.
            Pointer-events none, and like the guides they can never
            appear in a recording (the stream is captured, not the DOM). */}
        {/* R36 WS-4 — the full cell grid is mounted once (cells start
            hidden); the meter sampler paints flagged cells by direct
            DOM writes, so a zebra change costs no React render. The
            container itself mounts only once a cell has flagged. */}
        {zebraOn && (
          <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
            {Array.from({ length: LIGHT_GRID_COLS * LIGHT_GRID_ROWS }, (_, i) => (
              <div
                key={i}
                ref={(el) => {
                  zebraCellRefs.current[i] = el;
                  // R40 P-38: a fresh cell paints from the last grid
                  // at mount — no one-sample blank beat.
                  paintZebraCell(el, i);
                }}
                className="absolute"
                style={{
                  display: 'none',
                  left: `${((i % LIGHT_GRID_COLS) / LIGHT_GRID_COLS) * 100}%`,
                  top: `${(Math.floor(i / LIGHT_GRID_COLS) / LIGHT_GRID_ROWS) * 100}%`,
                  width: `${100 / LIGHT_GRID_COLS}%`,
                  height: `${100 / LIGHT_GRID_ROWS}%`,
                  background:
                    'repeating-linear-gradient(45deg, rgba(255,70,70,0.4) 0 4px, rgba(255,70,70,0.08) 4px 8px)',
                }}
              />
            ))}
          </div>
        )}
        {/* R32 Phase 2 — tap-to-focus ring: a brief marker at the tap
            point, fading out over ~600ms. DOM only. */}
        {focusPoint && (
          <div
            className={`absolute w-14 h-14 rounded-full border-2 border-gold pointer-events-none transition-opacity duration-200 ${
              focusRingFading ? 'opacity-0' : 'opacity-100'
            }`}
            style={{
              left: `${focusPoint.x * 100}%`,
              top: `${focusPoint.y * 100}%`,
              transform: 'translate(-50%, -50%)',
            }}
            aria-hidden="true"
          />
        )}
        {/* R32 Phase 2 — selfie light: a bright warm frame glow around
            the front preview. Pure DOM light from the screen itself —
            it adds no hardware light and never enters a recording. */}
        {selfieLight && facingMode === 'user' && !dualMode && !isStep2Phase && !pendingVideo && !pendingDual && !error && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              boxShadow:
                'inset 0 0 0 10px rgba(255, 216, 155, 0.95), inset 0 0 90px 28px rgba(255, 196, 120, 0.5)',
            }}
            aria-hidden="true"
          />
        )}
        {/* R32 Phase 2 — light meter pill (top-right; the REC badge
            owns top-left). Live single-camera view only. */}
        {lightState && !isStep2Phase && !pendingVideo && !pendingDual && !error && (
          <div className="absolute top-3 right-3 text-[10px] font-bold uppercase tracking-wide text-white bg-black/50 rounded px-2 py-1 pointer-events-none">
            {lightStateLabel(lightState)}
          </div>
        )}
        {/* R32 Phase 3 — level indicator: a horizon line that stays
            with the real horizon (counter-rotated by the tilt) plus a
            bubble in a track at the top. DOM only, pointer-events
            none — like the guides, it can never enter a recording. */}
        {/* R36 WS-4 — the indicator's wrapper mounts with the Level
            toggle; the orientation listener shows/rotates it by
            direct DOM writes (it starts hidden until a real tilt
            reading arrives). */}
        {levelEnabled && !pendingVideo && !pendingDual && !error && (
          <div ref={levelWrapRef} style={{ display: 'none' }}>
            <div
              className="absolute left-1/2 top-1/2 pointer-events-none"
              style={{ transform: 'translate(-50%, -50%)' }}
              aria-hidden="true"
            >
              <div ref={horizonLineRef} className="w-28 h-0.5 rounded bg-white/70" />
            </div>
            <div
              className="absolute top-3 left-1/2 -translate-x-1/2 w-24 h-4 rounded-full bg-black/45 pointer-events-none"
              aria-hidden="true"
            >
              <div className="absolute top-1/2 left-1/2 w-px h-2 bg-white/50" style={{ transform: 'translate(-50%, -50%)' }} />
              <div ref={levelBubbleRef} className="absolute top-1/2 left-1/2 w-2.5 h-2.5 rounded-full bg-gold" />
            </div>
          </div>
        )}
        {/* R32 Phase 3 — motion coach pill while recording: Smooth /
            Slow down / Too shaky from the live motion level. No pill
            at all when there is no motion signal to judge by. */}
        {/* R36 WS-4 — the pill node mounts while recording but is
            painted (text, tone class, visibility) by direct DOM
            writes from the gated coach effect — it starts hidden
            and stays hidden while there is no motion signal. */}
        {isRecording && (
          <div
            ref={coachPillRef}
            className="absolute bottom-3 left-3 text-[10px] font-bold uppercase tracking-wide text-white rounded px-2 py-1 pointer-events-none bg-emerald-600/85"
            style={{ display: 'none' }}
          />
        )}
        {/* R32 Phase 3 — steady-start countdown overlay: the count
            finishes early once the phone is still enough, finishes
            anyway at zero, and Skip starts right away. It never
            hard-blocks the recording behind it. */}
        {countdownActive && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/50">
            <span className="text-6xl font-black text-white tabular-nums">{countdownDisplay}</span>
            <p className="text-[11px] font-bold uppercase tracking-wide text-white/80 text-center px-6">
              Recording hasn&rsquo;t started yet — hold still and it begins on its own
            </p>
            <button
              onClick={completeCountdown}
              className="min-h-11 px-4 rounded-lg bg-white/15 hover:bg-white/25 text-white text-[11px] font-bold uppercase tracking-wide transition"
            >
              Skip
            </button>
          </div>
        )}
        {isRecording && (
          <>
            <div
              className={`absolute top-3 left-3 flex items-center gap-2 text-white text-xs font-bold px-2 py-1 rounded ${
                nearLimit ? 'bg-amber-600/90' : 'bg-red-600/90'
              }`}
            >
              <span className="w-2 h-2 rounded-full bg-white animate-pulse" /> REC {formatClock(recordSeconds)} / {formatClock(MAX_MEDIA_SECONDS)}
            </div>
            <div className="absolute top-0 left-0 right-0 h-1 bg-white/10">
              <div
                className={`h-full transition-all ${nearLimit ? 'bg-amber-500' : 'bg-red-500'}`}
                style={{ width: `${Math.min(100, (recordSeconds / MAX_MEDIA_SECONDS) * 100)}%` }}
              />
            </div>
          </>
        )}
        {!isRecording && isReady && !pendingVideo && (
          <div className="absolute bottom-3 left-3 right-3 text-center text-[10px] text-white/50 bg-black/40 rounded px-2 py-1">
            Records up to {formatClock(MAX_MEDIA_SECONDS)}
          </div>
        )}
        {pendingVideo && (
          <video
            src={pendingVideo.url}
            controls
            autoPlay
            loop
            playsInline
            className="absolute inset-0 w-full h-full object-cover bg-black"
            aria-label="Review your recording"
          />
        )}
        {/* R29 — front camera live corner preview in dual mode. The
            front preview IS mirrored (R24 rule); the rear main preview
            above is never mirrored in dual mode. R31 — the same
            element/preview serves two-pass step 2 (front stream in
            `streamRef`, attached by the step-2 effect above). */}
        {(dualMode || twoPassPhase === 'step2-live') && !pendingDual && !pendingVideo && !error && (
          <video
            ref={frontVideoRef}
            muted
            playsInline
            aria-label="Front camera preview"
            className="absolute bottom-3 right-3 w-24 rounded-lg border border-white/30 object-cover bg-black pointer-events-none"
            style={{ aspectRatio: previewAspectRatio, transform: previewMirrorTransform('user') }}
          />
        )}
        {/* R29 — dual review: main recording full-frame, front recording
            in the corner. Review shows the files as-is (no transform). */}
        {pendingDual && (
          <>
            <video
              src={pendingDual.mainUrl}
              controls
              autoPlay
              loop
              playsInline
              className="absolute inset-0 w-full h-full object-cover bg-black"
              aria-label="Review your main camera recording"
            />
            <video
              src={pendingDual.frontUrl}
              autoPlay
              loop
              muted
              playsInline
              aria-label="Front camera recording"
              className="absolute bottom-3 right-3 w-24 rounded-lg border border-white/30 object-cover bg-black pointer-events-none"
              style={{ aspectRatio: previewAspectRatio }}
            />
          </>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center p-6 bg-black/80 text-center text-sm text-red-300">
            {error}
          </div>
        )}
        {/* R41 Step 3 (flip fix) — a failed flip keeps the working
            camera live; this banner is how the owner knows the switch
            didn't happen. Dismissible; also cleared on the next flip
            attempt. */}
        {flipNotice && !error && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 max-w-[92%] rounded-lg bg-amber-500/95 px-3 py-2 text-center text-xs font-semibold text-black shadow-lg">
            <span>{flipNotice}</span>
            <button
              type="button"
              onClick={() => setFlipNotice(null)}
              aria-label="Dismiss"
              className="shrink-0 rounded px-1.5 py-0.5 text-sm font-bold leading-none hover:bg-black/10"
            >
              ×
            </button>
          </div>
        )}
      </div>

      {/* R41 Step 3 Rung B — the steadying state: covers the whole
          camera surface while a finished take is re-timed to an even
          frame rate, so nothing can be tapped mid-step and the review
          only appears once the saved file exists. */}
      {steadyingTake && (
        <div
          className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 bg-black/90 p-6 text-center"
          role="status"
          aria-live="polite"
        >
          <p className="text-sm font-bold text-white">Steadying your take…</p>
          <p className="text-[11px] text-white/60">Evening out the frame timing before it joins your project.</p>
        </div>
      )}

      {/* R31 — two-pass step headings, above whichever controls the
          current phase shows (live controls or a review block). */}
      {(twoPassPhase === 'step1-live' || twoPassPhase === 'step1-review') && (
        <div className="flex flex-col items-center gap-1 max-w-md w-full text-center">
          <p className="text-xs font-bold uppercase tracking-wide text-gold">{TWO_PASS_STEP1_HEADING}</p>
          {twoPass.viaDualFallback && <p className="text-[11px] text-white/60">{TWO_PASS_WHY_LINE}</p>}
          <p className="text-[11px] text-white/60">{TWO_PASS_ENTRY_TIP}</p>
        </div>
      )}
      {(twoPassPhase === 'step2-live' || twoPassPhase === 'step2-review') && (
        <div className="flex flex-col items-center gap-1 max-w-md w-full text-center">
          <p className="text-xs font-bold uppercase tracking-wide text-gold">{TWO_PASS_STEP2_HEADING}</p>
          {twoPassPhase === 'step2-live' && <p className="text-[11px] text-white/60">{TWO_PASS_STEP2_TIP}</p>}
        </div>
      )}

      {pendingDual ? (
        <div className="flex flex-col items-center gap-2.5 max-w-md w-full">
          <p className="text-xs text-white/60 text-center">
            {twoPassPhase === 'step2-review'
              ? 'Recorded in two steps — your main video with you over it. If the sound feels off, use Line up the sound in the Overlay panel.'
              : 'Both cameras recorded together. Add as a pair and the main camera becomes your video, with your front camera as the overlay. If the sound feels off, use Line up the sound in the Overlay panel.'}
          </p>
          <ReceiptLines receipt={pendingDual.mainReceipt} label="Main camera" />
          <ReceiptLines receipt={pendingDual.frontReceipt} label="Front camera" />
          {/* R32 Phase 4 — layout choice for the pair: Corner PiP
              (the usual overlay) or Split 50/50 (both clips as equal
              halves). Carried into the placement by Add as a pair. */}
          <div className="flex items-center gap-2 flex-wrap justify-center">
            <span className="text-[11px] font-bold uppercase tracking-wide text-white/50">Layout:</span>
            {(
              [
                { id: 'pip', label: 'Corner PiP' },
                { id: 'split', label: 'Split 50/50' },
              ] as Array<{ id: 'pip' | 'split'; label: string }>
            ).map((choice) => (
              <button
                key={choice.id}
                onClick={() => setDualLayout(choice.id)}
                aria-pressed={dualLayout === choice.id}
                className={`min-h-11 px-3 rounded-lg text-xs font-bold uppercase tracking-wide transition ${
                  dualLayout === choice.id ? 'bg-gold text-black' : 'bg-white/10 hover:bg-white/20 text-white'
                }`}
              >
                {choice.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2.5 flex-wrap justify-center">
            <button
              onClick={twoPassPhase === 'step2-review' ? confirmDualTwoPass : confirmDual}
              className="min-h-11 px-4 rounded-xl bg-gold hover:bg-gold-bright text-black text-xs font-bold uppercase tracking-wide flex items-center gap-2 transition"
            >
              <Clapperboard size={15} /> Add as a pair
            </button>
            <button
              onClick={twoPassPhase === 'step2-review' ? retakeStep2 : discardDual}
              className="min-h-11 px-3 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-bold uppercase tracking-wide transition"
            >
              Retake
            </button>
            {twoPassPhase === 'step2-review' && (
              <button
                onClick={startOverTwoPass}
                className="min-h-11 px-3 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-bold uppercase tracking-wide transition"
              >
                Start over
              </button>
            )}
            <button
              onClick={() => {
                if (twoPassPhase === 'step2-review') exitTwoPass();
                stopStream();
                onClose();
              }}
              className="min-h-11 px-3 rounded-xl bg-white/5 hover:bg-white/10 text-white/70 text-xs font-bold uppercase tracking-wide transition"
            >
              Close
            </button>
          </div>
        </div>
      ) : pendingVideo ? (
        twoPassPhase === 'step1-review' ? (
          <div className="flex flex-col items-center gap-2.5 max-w-md w-full">
            <p className="text-xs text-white/60 text-center">
              That&apos;s your main video. Next, you&apos;ll record yourself over it.
            </p>
            <ReceiptLines receipt={pendingVideo.receipt} />
            <div className="flex items-center gap-2.5 flex-wrap justify-center">
              <button
                onClick={keepStep1}
                className="min-h-11 px-4 rounded-xl bg-gold hover:bg-gold-bright text-black text-xs font-bold uppercase tracking-wide flex items-center gap-2 transition"
              >
                <Clapperboard size={15} /> Use this — next step
              </button>
              <button
                onClick={() => {
                  dropStep1Url();
                  step1ReceiptRef.current = null;
                  dispatchTwoPass({ type: 'retake-step1' });
                  discardPendingVideo();
                }}
                className="min-h-11 px-3 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-bold uppercase tracking-wide transition"
              >
                Retake
              </button>
              <button
                onClick={() => {
                  exitTwoPass();
                  stopStream();
                  onClose();
                }}
                className="min-h-11 px-3 rounded-xl bg-white/5 hover:bg-white/10 text-white/70 text-xs font-bold uppercase tracking-wide transition"
              >
                Close
              </button>
            </div>
          </div>
        ) : overlayOnly ? (
          <div className="flex flex-col items-center gap-2.5 max-w-md w-full">
            <p className="text-xs text-white/60 text-center">
              Your recording is ready. Add it as a talking-head overlay on top of your main video.
            </p>
            <ReceiptLines receipt={pendingVideo.receipt} />
            <div className="flex items-center gap-2.5 flex-wrap justify-center">
              <button
                onClick={() => confirmPendingVideo(true)}
                className="min-h-11 px-4 rounded-xl bg-gold hover:bg-gold-bright text-black text-xs font-bold uppercase tracking-wide flex items-center gap-2 transition"
              >
                <PictureInPicture2 size={15} /> Add as PiP
              </button>
              <button
                onClick={discardPendingVideo}
                className="min-h-11 px-3 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-bold uppercase tracking-wide transition"
              >
                Retake
              </button>
              <button
                onClick={() => {
                  stopStream();
                  onClose();
                }}
                className="min-h-11 px-3 rounded-xl bg-white/5 hover:bg-white/10 text-white/70 text-xs font-bold uppercase tracking-wide transition"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2.5 max-w-md w-full">
            <p className="text-xs text-white/60 text-center">
              Your recording is ready. Add it as your main clip — or as a talking-head overlay on top of your main video.
            </p>
            <ReceiptLines receipt={pendingVideo.receipt} />
            <div className="flex items-center gap-2.5 flex-wrap justify-center">
              <button
                onClick={() => confirmPendingVideo(false)}
                className="min-h-11 px-4 rounded-xl bg-gold hover:bg-gold-bright text-black text-xs font-bold uppercase tracking-wide flex items-center gap-2 transition"
              >
                <Clapperboard size={15} /> Add to timeline
              </button>
              {onCaptureAsOverlay && (
                <button
                  onClick={() => confirmPendingVideo(true)}
                  className="min-h-11 px-4 rounded-xl border border-gold/40 bg-gold/10 hover:bg-gold/20 text-gold text-xs font-bold uppercase tracking-wide flex items-center gap-2 transition"
                >
                  <PictureInPicture2 size={15} /> Use as Overlay (PiP)
                </button>
              )}
              <button
                onClick={discardPendingVideo}
                className="min-h-11 px-3 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-bold uppercase tracking-wide transition"
              >
                Retake
              </button>
              <button
                onClick={() => {
                  stopStream();
                  onClose();
                }}
                className="min-h-11 px-3 rounded-xl bg-white/5 hover:bg-white/10 text-white/70 text-xs font-bold uppercase tracking-wide transition"
              >
                Close
              </button>
            </div>
          </div>
        )
      ) : (
      <div className="flex flex-col items-center gap-3">
        {dualMode && dualMicMissing && (
          <div className="max-w-md w-full rounded-lg bg-amber-500/15 border border-amber-500/30 px-3 py-2 text-[11px] text-amber-200 text-center">
            {DUAL_MIC_UNAVAILABLE_MESSAGE}
          </div>
        )}
        {dualNotice && (
          <div className="flex flex-col gap-2 max-w-md w-full rounded-lg bg-amber-500/15 border border-amber-500/30 px-3 py-2.5 text-amber-200">
            <div className="flex items-start gap-2">
              <p className="flex-1 text-xs font-bold text-amber-100">{dualNotice}</p>
              <button
                onClick={() => {
                  setDualNotice(null);
                  setDualDetails(null);
                  setDualWhyOpen(false);
                }}
                aria-label="Dismiss"
                className="shrink-0 min-h-8 min-w-8 flex items-center justify-center text-amber-200/70 hover:text-amber-100"
              >
                ×
              </button>
            </div>
            {onCaptureDual && twoPassPhase === 'off' && (
              <button
                onClick={() => enterTwoPass(true)}
                className="w-full min-h-11 px-3 flex items-center justify-center rounded-md bg-amber-400 hover:bg-amber-300 text-black text-xs font-bold uppercase tracking-wide"
              >
                Record in two steps instead
              </button>
            )}
            {dualDetails && (
              <div className="flex flex-col items-start gap-1">
                <button
                  type="button"
                  onClick={() => setDualWhyOpen((v) => !v)}
                  aria-expanded={dualWhyOpen}
                  className="text-[11px] font-bold text-amber-200/80 hover:text-amber-100"
                >
                  Why?
                </button>
                {dualWhyOpen && <p className="text-[11px] text-amber-200/70">{dualDetails}</p>}
              </div>
            )}
          </div>
        )}
        {/* R40 P-16 — the pre-Record controls now live in ONE
            "Camera settings" sheet (the app's bottom-sheet pattern).
            On the surface stay only the essentials: the viewfinder,
            Record/Stop, Flip, Photo, Close, Flashlight, Selfie light,
            the light-meter pill and Lock. The sheet's own rows are
            all 44px too (P-15). */}
        {!isRecording && (
          <button
            onClick={() => setCameraSettingsOpen(true)}
            aria-haspopup="dialog"
            className="min-h-11 px-4 inline-flex items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-bold uppercase tracking-wide transition"
          >
            Camera settings
          </button>
        )}
        {cameraSettingsOpen && (
          <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Camera settings">
            <div className="absolute inset-0 bg-black/60" onClick={() => setCameraSettingsOpen(false)} />
            <div
              data-camera-settings-sheet
              className="absolute left-0 right-0 bottom-0 max-h-[80vh] overflow-y-auto bg-[#111111] rounded-t-2xl border-t border-white/10 p-4 flex flex-col gap-4"
              style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold uppercase tracking-wide text-white/70">Camera settings</span>
                <button
                  onClick={() => setCameraSettingsOpen(false)}
                  aria-label="Close camera settings"
                  className="min-h-11 min-w-11 flex items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 text-white text-base leading-none"
                >
                  ×
                </button>
              </div>
              {/* R24 WS-P1: quality + frame-rate chips (moved into the
                  sheet, R40 P-16). Changing a chip re-acquires the
                  stream at the new ladder (disabled while recording —
                  the stream is locked once recording starts). */}
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-bold uppercase tracking-wide text-white/50">Quality</span>
                <div className="flex items-center gap-1 bg-white/5 rounded-lg p-1" role="group" aria-label="Capture quality">
                  {(
                    [
                      { id: 'auto', label: 'Auto' },
                      { id: '4k', label: '4K' },
                      { id: 'hd', label: 'HD' },
                    ] as Array<{ id: CaptureQualityChoice; label: string }>
                  ).map((chip) => (
                    <button
                      key={chip.id}
                      onClick={() => setQualityChoice(chip.id)}
                      disabled={isRecording || dualMode || isStep2Phase}
                      aria-pressed={qualityChoice === chip.id}
                      className={`min-h-11 px-3 inline-flex items-center justify-center text-[11px] font-bold uppercase tracking-wide rounded-md disabled:opacity-40 transition ${
                        qualityChoice === chip.id ? 'bg-gold text-black' : 'text-white/70 hover:bg-white/10'
                      }`}
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-bold uppercase tracking-wide text-white/50">Frame rate</span>
                <div className="flex items-center gap-1 bg-white/5 rounded-lg p-1" role="group" aria-label="Frame rate">
                  {([60, 30] as CaptureFpsChoice[]).map((fps) => (
                    <button
                      key={fps}
                      onClick={() => {
                        // An explicit pick this session beats any saved
                        // device profile from here on.
                        userFpsChoiceRef.current = true;
                        setFpsPickedExplicitly(true);
                        setFpsChoice(fps);
                      }}
                      disabled={isRecording || dualMode || isStep2Phase}
                      aria-pressed={fpsChoice === fps}
                      className={`min-h-11 px-3 inline-flex items-center justify-center text-[11px] font-bold uppercase tracking-wide rounded-md disabled:opacity-40 transition ${
                        fpsChoice === fps ? 'bg-gold text-black' : 'text-white/70 hover:bg-white/10'
                      }`}
                    >
                      {fps} fps
                    </button>
                  ))}
                </div>
                {/* R41 Step 3 Rung A — proven fps ceiling advisory (see provenFpsCeilingText). */}
                {provenCeiling !== null && !fpsPickedExplicitly && qualityChoice !== 'hd' && (
                  <p className="text-[11px] text-white/70 text-center">{provenFpsCeilingText(provenCeiling)}</p>
                )}
              </div>
              {/* R24 WS-P3: guides toggle (in the sheet, R40 P-16) */}
              <button
                onClick={() => setShowGuides((g) => !g)}
                aria-pressed={showGuides}
                className="min-h-11 px-3 w-full flex items-center justify-between rounded-lg bg-white/5 hover:bg-white/10 text-white text-xs font-bold uppercase tracking-wide transition"
              >
                <span>Guides</span>
                <span className={showGuides ? 'text-gold' : 'text-white/50'}>{showGuides ? 'On' : 'Off'}</span>
              </button>
              {/* R32 Phase 3: steady-start toggle — default on, saved
                  on this phone. Off = Record starts at once, as before. */}
              <div className="flex flex-col gap-1.5">
                <button
                  onClick={toggleSteadyStart}
                  aria-pressed={steadyStartEnabled}
                  className="min-h-11 px-3 w-full flex items-center justify-between rounded-lg bg-white/5 hover:bg-white/10 text-white text-xs font-bold uppercase tracking-wide transition"
                >
                  <span>Steady start</span>
                  <span className={steadyStartEnabled ? 'text-gold' : 'text-white/50'}>{steadyStartEnabled ? 'On' : 'Off'}</span>
                </button>
                <p className="text-[10px] text-white/60">
                  Steady start: recording hasn&rsquo;t started during the count — it begins on its own once you hold still.
                </p>
              </div>
              {/* R32 Phase 3: level toggle — renders only where the
                  platform exposes orientation at all. On phones that
                  ask permission first, the tap itself asks. */}
              {deviceOrientationAvailable() && (
                <button
                  onClick={() => void toggleLevel()}
                  aria-pressed={levelEnabled}
                  className="min-h-11 px-3 w-full flex items-center justify-between rounded-lg bg-white/5 hover:bg-white/10 text-white text-xs font-bold uppercase tracking-wide transition"
                >
                  <span>Level</span>
                  <span className={levelEnabled ? 'text-gold' : 'text-white/50'}>{levelEnabled ? 'On' : 'Off'}</span>
                </button>
              )}
              {/* R32 Phase 1 — guided 10-second camera test. Single
                  mode only: it runs the normal single recorder in test
                  mode. */}
              {!dualMode && twoPassPhase === 'off' && !isRecording && (
                <button
                  onClick={() => {
                    setCameraSettingsOpen(false);
                    startCameraTest();
                  }}
                  disabled={!isReady}
                  className="min-h-11 px-3 w-full inline-flex items-center justify-center rounded-lg bg-white/5 hover:bg-white/10 text-white/70 text-xs font-bold uppercase tracking-wide disabled:opacity-40 transition"
                >
                  Test my camera
                </button>
              )}
              {/* R41 WS-A — "What this phone offers": the per-facing
                  capability census in plain words, measured from
                  this phone's own cameras at open. When the browser
                  shares no ranges, the honest fallback line shows
                  instead of a guess. */}
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-bold uppercase tracking-wide text-white/50">What this phone offers</span>
                {(() => {
                  const rearLine = formatCensusOfferLine('environment', censusByFacing['environment']);
                  const frontLine = formatCensusOfferLine('user', censusByFacing['user']);
                  return (
                    <div className="flex flex-col gap-1 rounded-lg bg-white/5 px-3 py-2.5">
                      {rearLine && <p className="text-[11px] text-white/80">{rearLine}</p>}
                      {frontLine && <p className="text-[11px] text-white/80">{frontLine}</p>}
                      {(!rearLine || !frontLine) && <p className="text-[11px] text-white/60">{CENSUS_UNAVAILABLE_TEXT}</p>}
                    </div>
                  );
                })()}
              </div>
              {/* R41 WS-A — diagnostics entry: opens the guided
                  60-second smoothness check's intro screen. */}
              {!dualMode && twoPassPhase === 'off' && !isRecording && (
                <button
                  onClick={() => {
                    setCameraSettingsOpen(false);
                    setDiagIntroOpen(true);
                  }}
                  disabled={!isReady}
                  className="min-h-11 px-3 w-full inline-flex items-center justify-center rounded-lg bg-white/5 hover:bg-white/10 text-white/70 text-xs font-bold uppercase tracking-wide disabled:opacity-40 transition"
                >
                  Check camera smoothness
                </button>
              )}
            </div>
          </div>
        )}
        {/* R36 WS-4 — proven-smooth suggestion: the last take at this
            camera dropped frames, so the step below is offered with
            a one-tap apply. Shown only while the rough quality is
            still the chosen one; ignoring it costs nothing and it is
            NEVER applied automatically. */}
        {profileSuggestion && !isRecording && qualityChoice === profileSuggestion.fromQuality && (
          <div className="flex flex-col items-center gap-1.5 max-w-md w-full rounded-lg bg-white/5 border border-white/15 px-3 py-2.5">
            <p className="text-[11px] text-white/70 text-center">{profileSuggestion.text}</p>
            <button
              onClick={() => setQualityChoice(profileSuggestion.suggestedQuality)}
              className="min-h-11 px-3 flex items-center justify-center rounded-md bg-gold hover:bg-gold-bright text-black text-[11px] font-bold uppercase tracking-wide transition"
            >
              {profileSuggestion.applyLabel}
            </button>
          </div>
        )}
        {isTestingCamera && isRecording && (
          <div className="max-w-md w-full rounded-lg bg-white/5 border border-white/15 px-3 py-2 text-[11px] text-white/80 text-center">
            Recording a 10-second test… move and pan slowly
          </div>
        )}
        {testReceipt && !isRecording && (
          <div className="flex flex-col items-center gap-1.5 max-w-md w-full rounded-lg bg-white/5 border border-white/15 px-3 py-2.5">
            <ReceiptLines receipt={testReceipt} />
            <p className="text-[11px] text-white/50 text-center">
              This test was not added to your project. These settings are saved for this camera.
            </p>
            <button
              onClick={() => setTestReceipt(null)}
              className="min-h-11 px-3 flex items-center justify-center rounded-md bg-white/10 hover:bg-white/20 text-white text-[11px] font-bold"
            >
              Done
            </button>
          </div>
        )}
        {/* R41 WS-A — diagnostics intro: what the check does, in
            plain words, before anything records. */}
        {diagIntroOpen && !isRecording && !diagResult && (
          <div className="flex flex-col items-center gap-2 max-w-md w-full rounded-lg bg-white/5 border border-white/15 px-3 py-3">
            <p className="text-xs font-bold uppercase tracking-wide text-gold">Check camera smoothness</p>
            <p className="text-[11px] text-white/80 text-center">
              This records one 60-second clip with the camera and quality you have picked now, and measures how
              smoothly it records. Nothing is uploaded.
            </p>
            <div className="flex flex-col gap-1 w-full">
              {DIAGNOSTICS_PHASES.map((phase, i) => (
                <p key={phase.id} className="text-[11px] text-white/70 text-center">
                  Step {i + 1} — {phase.label} ({phase.seconds} seconds): {phase.prompt}
                </p>
              ))}
            </div>
            <p className="text-[11px] text-white/60 text-center">
              Follow the prompts on screen while it records. At the end you can download a report and save the clip.
            </p>
            <div className="flex items-center gap-2.5 flex-wrap justify-center">
              <button
                onClick={startDiagnosticsSession}
                disabled={!isReady}
                className="min-h-11 px-4 rounded-xl bg-gold hover:bg-gold-bright text-black text-xs font-bold uppercase tracking-wide disabled:opacity-40 transition"
              >
                Start the check
              </button>
              <button
                onClick={() => setDiagIntroOpen(false)}
                className="min-h-11 px-3 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-bold uppercase tracking-wide transition"
              >
                Not now
              </button>
            </div>
          </div>
        )}
        {/* R41 WS-A — the visible phase indicator during the
            diagnostics take: which step, what to do, time left. */}
        {isDiagRecording && isRecording && (
          <div className="max-w-md w-full rounded-lg bg-gold/15 border border-gold/40 px-3 py-2.5 text-center" aria-live="polite">
            {(() => {
              const { phase, index, secondsLeftInPhase } = diagnosticsPhaseAt(recordSeconds);
              return (
                <>
                  <p className="text-xs font-bold uppercase tracking-wide text-gold">
                    Step {index + 1} of {DIAGNOSTICS_PHASES.length} — {phase.label} · {secondsLeftInPhase}s left
                  </p>
                  <p className="text-[11px] text-white/85">{phase.prompt}</p>
                </>
              );
            })()}
          </div>
        )}
        {/* R41 WS-A — diagnostics result: the plain-words evidence
            summary plus the pack's three artefacts (report download,
            clip save) alongside the normal use / discard choices. */}
        {diagResult && !isRecording && (
          <div className="flex flex-col items-center gap-2 max-w-md w-full rounded-lg bg-white/5 border border-white/15 px-3 py-3">
            <p className="text-xs font-bold uppercase tracking-wide text-gold">Camera check — your results</p>
            <video
              src={diagResult.url}
              controls
              playsInline
              className="w-full max-h-52 rounded-lg bg-black object-contain"
              aria-label="Your camera check clip"
            />
            <div className="flex flex-col gap-0.5 w-full">
              {formatDiagnosticsSummary(diagResult.pack).map((line) => (
                <p key={line} className="text-[11px] text-white/80 text-center">
                  {line}
                </p>
              ))}
            </div>
            <ReceiptLines receipt={diagResult.receipt} />
            <div className="flex items-center gap-2.5 flex-wrap justify-center">
              <button
                onClick={downloadDiagnosticsReport}
                className="min-h-11 px-3 rounded-xl bg-gold hover:bg-gold-bright text-black text-xs font-bold uppercase tracking-wide transition"
              >
                Download report
              </button>
              <button
                onClick={downloadDiagnosticsClip}
                className="min-h-11 px-3 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-bold uppercase tracking-wide transition"
              >
                Save the test clip
              </button>
              <button
                onClick={useDiagnosticsClip}
                className="min-h-11 px-3 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-bold uppercase tracking-wide transition"
              >
                Use this clip
              </button>
              <button
                onClick={discardDiagnostics}
                className="min-h-11 px-3 rounded-xl bg-white/5 hover:bg-white/10 text-white/70 text-xs font-bold uppercase tracking-wide transition"
              >
                Discard
              </button>
            </div>
            <p className="text-[11px] text-white/50 text-center">
              Send the report file and the clip back in chat — together they show exactly what this phone did.
            </p>
          </div>
        )}
        {/* R24 WS-P4a: real camera zoom — rendered ONLY when the live
            track exposes a zoom capability (silent absence otherwise).
            R36 WS-4: the slider stays ENABLED while recording — the
            ramped zoom is one of the two applies allowed mid-take. */}
        {zoomCapability && (
          <label className="flex items-center gap-2 w-full max-w-xs text-white/70">
            <span className="text-[11px] font-bold uppercase tracking-wide">Zoom</span>
            <input
              type="range"
              min={zoomCapability.min}
              max={zoomCapability.max}
              step={zoomCapability.step}
              value={zoomValue}
              onChange={(e) => applyZoom(Number(e.target.value))}
              className="flex-1 accent-amber-400 disabled:opacity-40"
              aria-label="Camera zoom"
            />
            <span className="text-[11px] font-bold tabular-nums w-9 text-right">{zoomValue.toFixed(1)}×</span>
          </label>
        )}
        {/* R32 Phase 2 — light meter advice, in context. Advisory
            only: it never changes the quality/fps chips above. */}
        {warmedUp && !dualMode && meterAdvice && (
          <p className="max-w-md w-full text-center text-[11px] text-white/70">{meterAdvice}</p>
        )}
        {/* R32 Phase 2 — premium viewfinder controls. Every control
            below is capability-gated: it renders only when the live
            track exposed the matching capability at warm-up. */}
        {warmedUp && !dualMode && !isStep2Phase && controlCaps && (
          <div className="flex flex-col items-center gap-2 w-full">
            <div className="flex items-center gap-2 flex-wrap justify-center">
              {phase2Lockable.length > 0 && (
                <button
                  onClick={() => void toggleLock()}
                  disabled={isRecording}
                  aria-pressed={lockedSystems.length > 0}
                  className={`min-h-11 px-3 inline-flex items-center justify-center text-[11px] font-bold uppercase tracking-wide rounded-lg disabled:opacity-40 transition ${
                    lockedSystems.length > 0
                      ? 'bg-gold text-black'
                      : 'bg-white/5 text-white/70 hover:bg-white/10'
                  }`}
                >
                  {lockedSystems.length > 0 ? 'Unlock' : 'Lock focus & light'}
                </button>
              )}
              {lockedChip && (
                <span className="min-h-11 px-3 inline-flex items-center text-[11px] font-bold uppercase tracking-wide rounded-lg bg-gold/15 text-gold">
                  {lockedChip}
                </span>
              )}
              {facingMode === 'environment' && controlCaps.torch && (
                <button
                  onClick={toggleTorch}
                  aria-pressed={torchOn}
                  className={`min-h-11 px-3 inline-flex items-center justify-center text-[11px] font-bold uppercase tracking-wide rounded-lg transition ${
                    torchOn ? 'bg-gold text-black' : 'bg-white/5 text-white/70 hover:bg-white/10'
                  }`}
                >
                  Flashlight
                </button>
              )}
              {facingMode === 'user' && !isStep2Phase && (
                <button
                  onClick={() => setSelfieLight((v) => !v)}
                  aria-pressed={selfieLight}
                  title="A bright frame that lights your face from the screen"
                  className={`min-h-11 px-3 inline-flex items-center justify-center text-[11px] font-bold uppercase tracking-wide rounded-lg transition ${
                    selfieLight ? 'bg-gold text-black' : 'bg-white/5 text-white/70 hover:bg-white/10'
                  }`}
                >
                  Selfie light
                </button>
              )}
            </div>
            {lockNote && (
              <p className="text-[11px] text-amber-200/90 text-center">
                {lockNote} — it will keep adjusting as light changes
              </p>
            )}
            {controlCaps.exposure?.compensationRange && (
              <label className="flex items-center gap-2 w-full max-w-xs text-white/70">
                <span className="text-[11px] font-bold uppercase tracking-wide">Brightness</span>
                <input
                  type="range"
                  min={controlCaps.exposure.compensationRange.min}
                  max={controlCaps.exposure.compensationRange.max}
                  step={controlCaps.exposure.compensationRange.step ?? 0.1}
                  value={exposureCompValue}
                  disabled={isRecording}
                  onChange={(e) => applyExposureCompensation(Number(e.target.value))}
                  onPointerUp={(e) => applyExposureCompensation(Number((e.target as HTMLInputElement).value), true)}
                  onBlur={(e) => applyExposureCompensation(Number(e.target.value), true)}
                  className="flex-1 accent-amber-400 disabled:opacity-40"
                  aria-label="Exposure compensation"
                />
                <span className="text-[11px] font-bold tabular-nums w-9 text-right">
                  {exposureCompValue > 0 ? `+${exposureCompValue}` : `${exposureCompValue}`}
                </span>
              </label>
            )}
          </div>
        )}
      <div className="flex items-center gap-3 flex-wrap justify-center">
        {dualMode ? (
          <button
            onClick={exitDualMode}
            disabled={isRecording}
            className="min-h-11 px-4 inline-flex items-center justify-center text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 disabled:opacity-40 rounded-lg text-white"
          >
            One camera
          </button>
        ) : isStep2Phase ? null : (
          <button
            onClick={() => {
              // A fresh flip attempt clears any earlier flip-failure
              // notice; if this one fails too, startStream raises a
              // new one when it restores the working camera.
              setFlipNotice(null);
              setFacingMode((m) => (m === 'user' ? 'environment' : 'user'));
            }}
            disabled={isRecording}
            className="min-h-11 px-4 inline-flex items-center justify-center text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 disabled:opacity-40 rounded-lg text-white"
          >
            Flip camera
          </button>
        )}
        {!dualMode && !isRecording && onCaptureDual && dualCamCount >= 2 && (
          <button
            onClick={() => void enterDualMode()}
            disabled={dualBusy}
            className="min-h-11 px-4 inline-flex items-center justify-center text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 disabled:opacity-40 rounded-lg text-white"
          >
            {dualBusy ? 'Checking cameras… this can take a few seconds' : 'Record both cameras'}
          </button>
        )}
        {/* R31 — two-pass entry: NO camera-count gate (the flow needs
            only one camera at a time — that is its whole point). */}
        {!dualMode && !isRecording && onCaptureDual && twoPassPhase === 'off' && (
          <button
            onClick={() => enterTwoPass(false)}
            className="min-h-11 px-4 inline-flex items-center justify-center text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 rounded-lg text-white"
          >
            {TWO_PASS_BUTTON_LABEL}
          </button>
        )}
        <button
          onClick={takePhoto}
          disabled={!isReady || isRecording || dualMode || twoPassPhase !== 'off'}
          className="min-h-11 px-5 inline-flex items-center justify-center text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 disabled:opacity-40 rounded-lg text-white"
        >
          Photo
        </button>
        {!isRecording ? (
          <button
            onClick={() =>
              beginWithSteadyStart(twoPassPhase === 'step2-live' ? startStep2Recording : startRecording)
            }
            disabled={!isReady}
            className="min-h-11 px-5 inline-flex items-center justify-center text-xs font-bold uppercase tracking-wide bg-gold hover:bg-gold-bright disabled:opacity-40 rounded-lg text-black"
          >
            Record
          </button>
        ) : (
          <button
            onClick={stopRecording}
            className="min-h-11 px-5 inline-flex items-center justify-center text-xs font-bold uppercase tracking-wide bg-red-600 hover:bg-red-500 rounded-lg text-white"
          >
            Stop
          </button>
        )}
        <button
          onClick={() => {
            if (twoPassPhase !== 'off') exitTwoPass();
            stopStream();
            onClose();
          }}
          className="min-h-11 px-4 inline-flex items-center justify-center text-xs font-bold uppercase tracking-wide bg-white/5 hover:bg-white/10 rounded-lg text-white/70"
        >
          Close
        </button>
      </div>
      </div>
      )}
    </div>
  );
}
