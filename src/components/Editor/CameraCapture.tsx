import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Clapperboard, PictureInPicture2 } from 'lucide-react';
import { MAX_MEDIA_SECONDS } from '../../lib/media/constants';
import {
  buildCaptureAttempts,
  isLadderRetryableError,
  pickRecorderMimeType,
  previewMirrorTransform,
  recorderOptionsForTrackSettings,
  zoomCapabilityFromCapabilities,
  type CaptureFacingMode,
  type CaptureFpsChoice,
  type CaptureQualityChoice,
  type ZoomCapability,
} from '../../lib/camera/captureQuality';
import {
  createFrameDropTracker,
  type FrameDropEstimate,
  type FrameDropTracker,
} from '../../lib/camera/frameDrops';
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
  deviceProfileForFacing,
  loadDeviceProfiles,
  saveDeviceProfile,
  shortSideClassFor,
  type DeviceProfileStorage,
} from '../../lib/camera/deviceProfile';
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
  type LightMeterResult,
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
 * "Add both" choice hands the pair to the caller together, while Retake
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
   * caller through this callback via its "Add both" choice. Omitted =
   * dual mode is never offered.
   */
  onCaptureDual?: (result: CaptureDualResult) => void;
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
): void {
  const width = settings?.width ?? 0;
  const height = settings?.height ?? 0;
  const shortSide = width > 0 && height > 0 ? Math.min(width, height) : 0;
  saveDeviceProfile(browserLocalStorage(), {
    facing,
    shortSideClass: shortSideClassFor(shortSide),
    fps:
      typeof settings?.frameRate === 'number' && settings.frameRate > 0
        ? Math.round(settings.frameRate)
        : fallbackFps,
    mimeType: mimeType ?? '',
  });
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
  const { summary, details, technicalDetails } = formatCaptureReceipt(receipt);
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

export function CameraCapture({ onCapture, onCaptureAsOverlay, onCaptureDual, onClose, canvasWidth, canvasHeight }: CameraCaptureProps) {
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
  // R24 WS-P4a: the live track's zoom capability, when the platform
  // exposes one; null = no zoom control is rendered at all.
  const [zoomCapability, setZoomCapability] = useState<ZoomCapability | null>(null);
  const [zoomValue, setZoomValue] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
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
  /** Two-step lock: the quality + fps captured when step 1 started recording; step 2 must reuse them. */
  const twoPassLockRef = useRef<{ quality: CaptureQualityChoice; fps: CaptureFpsChoice } | null>(null);
  /** The step-1 take's receipt, carried into the step-2 (pendingDual) review. */
  const step1ReceiptRef = useRef<CaptureReceipt | null>(null);
  /** "Test my camera" mode: the next single recording is a 10s test — measured, profiled, then discarded. */
  const testModeRef = useRef(false);
  const [isTestingCamera, setIsTestingCamera] = useState(false);
  const [testReceipt, setTestReceipt] = useState<CaptureReceipt | null>(null);

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
  /** The latest light-meter reading; null until the sampler's first pass. */
  const [lightResult, setLightResult] = useState<LightMeterResult | null>(null);
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
  /** The countdown's displayed number (3, then 2, then 1). */
  const [countdownDisplay, setCountdownDisplay] = useState(3);
  /** The recorder start waiting on the countdown — single, dual (via startRecording) or step-2. */
  const countdownPendingRef = useRef<(() => void) | null>(null);
  /** Rolling motion-level history, written by the motion sampler; the countdown decision reads it. */
  const levelHistoryRef = useRef<MotionLevel[]>([]);
  /** The live motion-coach pill state while recording; null = no pill (no signal, or not recording). */
  const [coachState, setCoachState] = useState<MotionCoachState | null>(null);
  /** Level indicator on/off. Default ON only where enabling it needs no permission prompt on this platform. */
  const [levelEnabled, setLevelEnabled] = useState<boolean>(
    () => deviceOrientationAvailable() && !orientationPermissionNeeded(),
  );
  /** Latest horizon tilt in degrees; null = no orientation signal yet. */
  const [horizonTilt, setHorizonTilt] = useState<number | null>(null);
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
    setLightResult(null);
    // R32 Phase 3 — a stopped stream also stops the zoom ramp (its
    // track is gone), any pending steady-start countdown (its start
    // must never fire into a dead stream) and the coach pill.
    if (zoomRampRef.current) {
      cancelAnimationFrame(zoomRampRef.current.raf);
      zoomRampRef.current = null;
    }
    countdownPendingRef.current = null;
    setCountdownActive(false);
    setCoachState(null);
  }, []);

  const startStream = useCallback(async (override?: { quality: CaptureQualityChoice; fps: CaptureFpsChoice }) => {
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
    const attempts = buildCaptureAttempts({
      canvasWidth,
      canvasHeight,
      facingMode,
      quality: lock?.quality ?? qualityChoice,
      frameRate: lock?.fps ?? fpsChoice,
    });
    let stream: MediaStream | null = null;
    let lastError: unknown = null;
    for (const attempt of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(attempt.constraints);
        break;
      } catch (err) {
        lastError = err;
        if (!isLadderRetryableError(err)) break;
      }
    }
    if (!stream) {
      const err: any = lastError;
      setError(
        err?.name === 'NotAllowedError'
          ? 'Camera/microphone access was denied. Allow access in your browser settings, or use file upload instead.'
          : `Could not start the camera: ${err?.message || err}`,
      );
      return;
    }
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play().catch(() => {});
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
        } else if (phase === 'step2-live' && continuityProfileRef.current) {
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
      if (!controlCaps?.pointsOfInterest || !isReady || pendingVideo || pendingDual) return;
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
    [controlCaps, isReady, pendingVideo, pendingDual, facingMode, dualMode],
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

  /** R32 Phase 1 — build the honest receipt for one finished recording. */
  const receiptForRecording = useCallback(
    (
      settings: { width?: number; height?: number; frameRate?: number } | null | undefined,
      mimeType: string,
      blob: Blob,
      startedAtMs: number,
      frameDropEstimate: FrameDropEstimate | null,
    ): CaptureReceipt =>
      buildCaptureReceipt({
        trackSettings: settings ?? null,
        mimeType,
        blobSize: blob.size,
        durationSeconds: Math.max(0, (performance.now() - startedAtMs) / 1000),
        droppedFramesEstimate: frameDropEstimate?.droppedFramesEstimate ?? null,
        expectedFramesEstimate: frameDropEstimate?.expectedFrames ?? null,
      }),
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
      saveProvenProfile('environment', rearSettings, rearRecorder.mimeType, fpsChoiceRef.current);
      stopStream();
      setPendingDual({
        mainBlob,
        mainUrl: URL.createObjectURL(mainBlob),
        frontBlob,
        frontUrl: URL.createObjectURL(frontBlob),
        startDeltaMs: dualStartRef.current ? dualStartRef.current.frontStartMs - dualStartRef.current.rearStartMs : 0,
        mainReceipt,
        frontReceipt,
      });
      dualStartRef.current = null;
      frontRecorderRef.current = null;
      recorderRef.current = null;
    };
    rearRecorder.onstop = handleDualStop;
    frontRecorder.onstop = handleDualStop;
    const anchorMs = performance.now();
    rearRecorder.start();
    const rearStartMs = performance.now();
    frontRecorder.start();
    const frontStartMs = performance.now();
    rearTracker = beginFrameDropTracking(videoRef.current, streamRef.current);
    dualStartRef.current = { anchorMs, rearStartMs, frontStartMs };
    recorderRef.current = rearRecorder;
    frontRecorderRef.current = frontRecorder;
    setIsRecording(true);
    setRecordSeconds(0);
  }, [dualMode, isReady, createRecorder, stopStream, canvasWidth, canvasHeight, beginFrameDropTracking, receiptForRecording]);

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
    const recorder = createRecorder(stream, provenMimeFor(facingModeRef.current));
    if (!recorder) {
      // A failed start must not leave a camera test armed.
      testModeRef.current = false;
      setIsTestingCamera(false);
      return;
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
      const receipt = receiptForRecording(settingsSnapshot, recorder.mimeType, blob, startedAtMs, estimate);
      saveProvenProfile(facingModeRef.current, settingsSnapshot, recorder.mimeType, fpsChoiceRef.current);
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
      // R31 — in two-pass step 1 this same stop also feeds the flow:
      // the blob becomes the machine's main take, and the flow retains
      // its OWN object URL for it in `step1UrlRef` (separate from the
      // review URL `pendingVideo` gets below — that one is revoked
      // when the review clears, this one must live into step 2).
      if (twoPassPhaseRef.current === 'step1-live') {
        dropStep1Url();
        step1UrlRef.current = URL.createObjectURL(blob);
        step1ReceiptRef.current = receipt;
        dispatchTwoPass({ type: 'step1-recorded', blob });
      }
      // Hold for the review state (see `pendingVideo`) instead of handing
      // off immediately, and stop the live stream while reviewing — the
      // camera doesn't need to stay hot for a decision, and the review
      // <video> replaces the live preview in the same frame.
      stopStream();
      setPendingVideo({ blob, url: URL.createObjectURL(blob), receipt });
    };
    recorder.start();
    startedAtMs = performance.now();
    tracker = beginFrameDropTracking(videoRef.current, stream);
    recorderRef.current = recorder;
    setIsRecording(true);
    setRecordSeconds(0);
  }, [isReady, stopStream, dualMode, startDualRecording, createRecorder, dropStep1Url, dispatchTwoPass, beginFrameDropTracking, receiptForRecording, startStream]);

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
      const frontReceipt = receiptForRecording(settingsSnapshot, recorder.mimeType, frontBlob, recorderStartMs, estimate);
      const mainReceipt =
        step1ReceiptRef.current ??
        buildCaptureReceipt({ trackSettings: null, mimeType: mainBlob.type, blobSize: mainBlob.size, durationSeconds: 0 });
      saveProvenProfile('user', settingsSnapshot, recorder.mimeType, fpsChoiceRef.current);
      // Transfer the retained step-1 URL into pendingDual: clearing
      // the ref hands ownership to the pendingDual effect, which
      // revokes it when the review clears.
      step1UrlRef.current = null;
      dispatchTwoPass({ type: 'step2-recorded', blob: frontBlob, startDeltaMs });
      stopStream();
      setPendingDual({ mainBlob, mainUrl, frontBlob, frontUrl: URL.createObjectURL(frontBlob), startDeltaMs, mainReceipt, frontReceipt });
    };
    recorder.start();
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
  }, [isReady, createRecorder, stopStream, dispatchTwoPass, twoPass.mainBlob, beginFrameDropTracking, receiptForRecording]);

  /** Review-state confirm: hand the SAME CaptureResult to the normal path or the overlay path, per the user's pick. */
  const confirmPendingVideo = useCallback(
    (asOverlay: boolean) => {
      if (!pendingVideo) return;
      const result: CaptureResult = { kind: 'video', blob: pendingVideo.blob, receipt: pendingVideo.receipt };
      setPendingVideo(null);
      if (asOverlay && onCaptureAsOverlay) onCaptureAsOverlay(result);
      else onCapture(result);
    },
    [pendingVideo, onCapture, onCaptureAsOverlay],
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
    setPendingDual(null);
    onCaptureDual(payload);
  }, [pendingDual, onCaptureDual, dualLayout]);

  /** R29 dual review discard: drop both recordings and re-probe back into dual mode. */
  const discardDual = useCallback(() => {
    setPendingDual(null);
    void enterDualMode();
  }, [enterDualMode]);

  /**
   * R31 — two-pass "Add both": the existing dual confirm (the pair is
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
  // tiny (<= 96px wide) offscreen canvas at ~4Hz and analyse it with
  // the pure meter. Runs only while a single-camera stream is live
  // and warmed up — never during review, dual mode or two-pass step
  // 2 (whose main frame is playback, not the camera) — and stops
  // with the stream. It only ever ADVISES; it never touches the
  // user's quality/fps choices.
  useEffect(() => {
    if (!warmedUp || !isReady || dualMode || isStep2Phase || pendingVideo || pendingDual || error) return;
    let cancelled = false;
    const canvas = document.createElement('canvas');
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
        if (!cancelled) {
          setLightResult(analyzeLightSample({ data: image.data, width, height, format: 'rgba' }));
        }
      } catch {
        // A frame that can't be read (stream mid-swap) is skipped —
        // the next tick samples again.
      }
    };
    sample();
    const interval = window.setInterval(sample, 250);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [warmedUp, isReady, dualMode, isStep2Phase, pendingVideo, pendingDual, error]);

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
    const onMotion = (e: DeviceMotionEvent) => {
      const sample = gyroSampleFromRotationRate(e.rotationRate);
      if (sample) {
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
    const interval = window.setInterval(tick, 250);
    return () => {
      window.removeEventListener('devicemotion', onMotion);
      window.clearInterval(interval);
    };
  }, [countdownActive, isRecording, dualMode, twoPassPhase]);

  // R32 Phase 3 — the coach pill follows the sampler's level while
  // recording (single, dual and step-2 alike — all share this
  // recording state); it clears the moment recording stops.
  useEffect(() => {
    if (!isRecording) {
      setCoachState(null);
      return;
    }
    const interval = window.setInterval(() => {
      const { level } = assessMotion({
        gyroSamples: motionBufferRef.current.gyro,
        frameDiffs: motionBufferRef.current.diffs,
      });
      setCoachState(coachStateForLevel(level));
    }, 250);
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
    setCountdownDisplay(3);
    const startedAt = performance.now();
    const interval = window.setInterval(() => {
      const elapsed = performance.now() - startedAt;
      setCountdownDisplay(Math.max(1, 3 - Math.floor(elapsed / 1000)));
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
  useEffect(() => {
    if (!levelEnabled) return;
    const onOrientation = (e: DeviceOrientationEvent) => {
      setHorizonTilt(horizonTiltDegrees(e.beta, e.gamma));
    };
    window.addEventListener('deviceorientation', onOrientation);
    return () => {
      window.removeEventListener('deviceorientation', onOrientation);
      setHorizonTilt(null);
    };
  }, [levelEnabled]);

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
  const meterAdvice =
    lightResult && !isStep2Phase
      ? lightAdvice(lightResult, {
          demandingCapture: qualityChoice !== 'hd' || fpsChoice === 60,
          torchAvailable: facingMode === 'environment' && controlCaps?.torch === true,
        })
      : null;
  const zebraOn = !isStep2Phase && !pendingVideo && !pendingDual && (lightResult?.zebraCells.some(Boolean) ?? false);

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
        {zebraOn && lightResult && (
          <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
            {lightResult.zebraCells.map((flagged, i) =>
              flagged ? (
                <div
                  key={i}
                  className="absolute"
                  style={{
                    left: `${((i % LIGHT_GRID_COLS) / LIGHT_GRID_COLS) * 100}%`,
                    top: `${(Math.floor(i / LIGHT_GRID_COLS) / LIGHT_GRID_ROWS) * 100}%`,
                    width: `${100 / LIGHT_GRID_COLS}%`,
                    height: `${100 / LIGHT_GRID_ROWS}%`,
                    background:
                      'repeating-linear-gradient(45deg, rgba(255,70,70,0.4) 0 4px, rgba(255,70,70,0.08) 4px 8px)',
                  }}
                />
              ) : null,
            )}
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
        {lightResult && !isStep2Phase && !pendingVideo && !pendingDual && !error && (
          <div className="absolute top-3 right-3 text-[10px] font-bold uppercase tracking-wide text-white bg-black/50 rounded px-2 py-1 pointer-events-none">
            {lightStateLabel(lightResult.state)}
          </div>
        )}
        {/* R32 Phase 3 — level indicator: a horizon line that stays
            with the real horizon (counter-rotated by the tilt) plus a
            bubble in a track at the top. DOM only, pointer-events
            none — like the guides, it can never enter a recording. */}
        {levelEnabled && horizonTilt !== null && !pendingVideo && !pendingDual && !error && (
          <>
            <div
              className="absolute left-1/2 top-1/2 pointer-events-none"
              style={{ transform: 'translate(-50%, -50%)' }}
              aria-hidden="true"
            >
              <div
                className={`w-28 h-0.5 rounded ${Math.abs(horizonTilt) <= 2 ? 'bg-emerald-400/90' : 'bg-white/70'}`}
                style={{ transform: `rotate(${-horizonTilt}deg)` }}
              />
            </div>
            <div
              className="absolute top-3 left-1/2 -translate-x-1/2 w-24 h-4 rounded-full bg-black/45 pointer-events-none"
              aria-hidden="true"
            >
              <div className="absolute top-1/2 left-1/2 w-px h-2 bg-white/50" style={{ transform: 'translate(-50%, -50%)' }} />
              <div
                className={`absolute top-1/2 left-1/2 w-2.5 h-2.5 rounded-full ${Math.abs(horizonTilt) <= 2 ? 'bg-emerald-400' : 'bg-gold'}`}
                style={{ transform: `translate(calc(-50% + ${levelBubbleOffsetPx(horizonTilt, 40)}px), -50%)` }}
              />
            </div>
          </>
        )}
        {/* R32 Phase 3 — motion coach pill while recording: Smooth /
            Slow down / Too shaky from the live motion level. No pill
            at all when there is no motion signal to judge by. */}
        {isRecording && coachState && (
          <div
            className={`absolute bottom-3 left-3 text-[10px] font-bold uppercase tracking-wide text-white rounded px-2 py-1 pointer-events-none ${
              coachState.tone === 'good'
                ? 'bg-emerald-600/85'
                : coachState.tone === 'warn'
                  ? 'bg-amber-600/90'
                  : 'bg-red-600/90'
            }`}
          >
            {coachState.text}
          </div>
        )}
        {/* R32 Phase 3 — steady-start countdown overlay: the count
            finishes early once the phone is still enough, finishes
            anyway at zero, and Skip starts right away. It never
            hard-blocks the recording behind it. */}
        {countdownActive && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/50">
            <span className="text-6xl font-black text-white tabular-nums">{countdownDisplay}</span>
            <p className="text-[11px] font-bold uppercase tracking-wide text-white/80 text-center px-6">
              Hold still — recording starts when you are steady
            </p>
            <button
              onClick={completeCountdown}
              className="min-h-9 px-3.5 rounded-lg bg-white/15 hover:bg-white/25 text-white text-[11px] font-bold uppercase tracking-wide transition"
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
      </div>

      {/* R31 — two-pass step headings, above whichever controls the
          current phase shows (live controls or a review block). */}
      {(twoPassPhase === 'step1-live' || twoPassPhase === 'step1-review') && (
        <div className="flex flex-col items-center gap-1 max-w-md w-full text-center">
          <p className="text-xs font-bold uppercase tracking-wide text-gold">{TWO_PASS_STEP1_HEADING}</p>
          {twoPass.viaDualFallback && <p className="text-[11px] text-white/60">{TWO_PASS_WHY_LINE}</p>}
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
              ? 'Recorded in two steps — your main video with you over it, already lined up.'
              : 'Both cameras recorded together. Add both and the main camera becomes your video, with your front camera as the overlay — already lined up.'}
          </p>
          <ReceiptLines receipt={pendingDual.mainReceipt} label="Main camera" />
          <ReceiptLines receipt={pendingDual.frontReceipt} label="Front camera" />
          {/* R32 Phase 4 — layout choice for the pair: Corner PiP
              (the usual overlay) or Split 50/50 (both clips as equal
              halves). Carried into the placement by Add both. */}
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
              <Clapperboard size={15} /> Add both
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
        {/* R24 WS-P1: quality + frame-rate chips. Changing a chip
            re-acquires the stream at the new ladder (disabled while
            recording — the stream is locked once recording starts). */}
        <div className="flex items-center gap-2 flex-wrap justify-center">
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
                className={`px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide rounded-md disabled:opacity-40 transition ${
                  qualityChoice === chip.id ? 'bg-gold text-black' : 'text-white/70 hover:bg-white/10'
                }`}
              >
                {chip.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 bg-white/5 rounded-lg p-1" role="group" aria-label="Frame rate">
            {([60, 30] as CaptureFpsChoice[]).map((fps) => (
              <button
                key={fps}
                onClick={() => {
                  // An explicit pick this session beats any saved
                  // device profile from here on.
                  userFpsChoiceRef.current = true;
                  setFpsChoice(fps);
                }}
                disabled={isRecording || dualMode || isStep2Phase}
                aria-pressed={fpsChoice === fps}
                className={`px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide rounded-md disabled:opacity-40 transition ${
                  fpsChoice === fps ? 'bg-gold text-black' : 'text-white/70 hover:bg-white/10'
                }`}
              >
                {fps} fps
              </button>
            ))}
          </div>
          {/* R24 WS-P3: guides toggle */}
          <button
            onClick={() => setShowGuides((g) => !g)}
            aria-pressed={showGuides}
            className={`px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide rounded-lg transition ${
              showGuides ? 'bg-white/20 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10'
            }`}
          >
            Guides
          </button>
          {/* R32 Phase 3: steady-start toggle — default on, saved on
              this phone. Off = Record starts at once, as before. */}
          <button
            onClick={toggleSteadyStart}
            aria-pressed={steadyStartEnabled}
            className={`px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide rounded-lg transition ${
              steadyStartEnabled ? 'bg-white/20 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10'
            }`}
          >
            Steady start
          </button>
          {/* R32 Phase 3: level toggle — renders only where the
              platform exposes orientation at all. On phones that ask
              permission first, the tap itself asks. */}
          {deviceOrientationAvailable() && (
            <button
              onClick={() => void toggleLevel()}
              aria-pressed={levelEnabled}
              className={`px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide rounded-lg transition ${
                levelEnabled ? 'bg-white/20 text-white' : 'bg-white/5 text-white/60 hover:bg-white/10'
              }`}
            >
              Level
            </button>
          )}
          {/* R32 Phase 1 — guided 10-second camera test. Single mode
              only: it runs the normal single recorder in test mode. */}
          {!dualMode && twoPassPhase === 'off' && !isRecording && (
            <button
              onClick={startCameraTest}
              disabled={!isReady}
              className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide rounded-lg bg-white/5 text-white/70 hover:bg-white/10 disabled:opacity-40 transition"
            >
              Test my camera
            </button>
          )}
        </div>
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
              className="min-h-8 px-2.5 flex items-center justify-center rounded-md bg-white/10 hover:bg-white/20 text-white text-[11px] font-bold"
            >
              Done
            </button>
          </div>
        )}
        {/* R24 WS-P4a: real camera zoom — rendered ONLY when the live
            track exposes a zoom capability (silent absence otherwise). */}
        {zoomCapability && (
          <label className="flex items-center gap-2 w-full max-w-xs text-white/70">
            <span className="text-[11px] font-bold uppercase tracking-wide">Zoom</span>
            <input
              type="range"
              min={zoomCapability.min}
              max={zoomCapability.max}
              step={zoomCapability.step}
              value={zoomValue}
              disabled={isRecording}
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
                  aria-pressed={lockedSystems.length > 0}
                  className={`px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide rounded-lg transition ${
                    lockedSystems.length > 0
                      ? 'bg-gold text-black'
                      : 'bg-white/5 text-white/70 hover:bg-white/10'
                  }`}
                >
                  {lockedSystems.length > 0 ? 'Unlock' : 'Lock focus & light'}
                </button>
              )}
              {lockedChip && (
                <span className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide rounded-lg bg-gold/15 text-gold">
                  {lockedChip}
                </span>
              )}
              {facingMode === 'environment' && controlCaps.torch && (
                <button
                  onClick={toggleTorch}
                  aria-pressed={torchOn}
                  className={`px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide rounded-lg transition ${
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
                  className={`px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wide rounded-lg transition ${
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
                  onChange={(e) => applyExposureCompensation(Number(e.target.value))}
                  onPointerUp={(e) => applyExposureCompensation(Number((e.target as HTMLInputElement).value), true)}
                  onBlur={(e) => applyExposureCompensation(Number(e.target.value), true)}
                  className="flex-1 accent-amber-400"
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
            className="px-3 py-2 text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 disabled:opacity-40 rounded-lg text-white"
          >
            One camera
          </button>
        ) : isStep2Phase ? null : (
          <button
            onClick={() => setFacingMode((m) => (m === 'user' ? 'environment' : 'user'))}
            disabled={isRecording}
            className="px-3 py-2 text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 disabled:opacity-40 rounded-lg text-white"
          >
            Flip camera
          </button>
        )}
        {!dualMode && !isRecording && onCaptureDual && dualCamCount >= 2 && (
          <button
            onClick={() => void enterDualMode()}
            disabled={dualBusy}
            className="px-3 py-2 text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 disabled:opacity-40 rounded-lg text-white"
          >
            {dualBusy ? 'Checking cameras… this can take a few seconds' : 'Record both cameras'}
          </button>
        )}
        {/* R31 — two-pass entry: NO camera-count gate (the flow needs
            only one camera at a time — that is its whole point). */}
        {!dualMode && !isRecording && onCaptureDual && twoPassPhase === 'off' && (
          <button
            onClick={() => enterTwoPass(false)}
            className="px-3 py-2 text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 rounded-lg text-white"
          >
            {TWO_PASS_BUTTON_LABEL}
          </button>
        )}
        <button
          onClick={takePhoto}
          disabled={!isReady || isRecording || dualMode || twoPassPhase !== 'off'}
          className="px-4 py-2 text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 disabled:opacity-40 rounded-lg text-white"
        >
          Photo
        </button>
        {!isRecording ? (
          <button
            onClick={() =>
              beginWithSteadyStart(twoPassPhase === 'step2-live' ? startStep2Recording : startRecording)
            }
            disabled={!isReady}
            className="px-4 py-2 text-xs font-bold uppercase tracking-wide bg-gold hover:bg-gold-bright disabled:opacity-40 rounded-lg text-black"
          >
            Record
          </button>
        ) : (
          <button
            onClick={stopRecording}
            className="px-4 py-2 text-xs font-bold uppercase tracking-wide bg-red-600 hover:bg-red-500 rounded-lg text-white"
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
          className="px-3 py-2 text-xs font-bold uppercase tracking-wide bg-white/5 hover:bg-white/10 rounded-lg text-white/70"
        >
          Close
        </button>
      </div>
      </div>
      )}
    </div>
  );
}
