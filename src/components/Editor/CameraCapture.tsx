import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Clapperboard, PictureInPicture2 } from 'lucide-react';
import { MAX_MEDIA_SECONDS } from '../../lib/media/constants';
import {
  buildCaptureAttempts,
  isLadderRetryableError,
  previewMirrorTransform,
  recorderOptionsForTrackSettings,
  zoomCapabilityFromCapabilities,
  type CaptureFpsChoice,
  type CaptureQualityChoice,
  type ZoomCapability,
} from '../../lib/camera/captureQuality';
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
 */

export type CaptureResult = { kind: 'photo'; blob: Blob } | { kind: 'video'; blob: Blob };

export interface CaptureDualResult {
  main: CaptureResult;
  overlay: CaptureResult;
  /** Measured start delta between the two recorders (front start − rear start) in ms, on one performance.now() anchor. */
  startDeltaMs: number;
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
  const [pendingVideo, setPendingVideo] = useState<{ blob: Blob; url: string } | null>(null);

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
  // R30 — the failed probe's plain-words diagnosis, shown as the
  // banner's small "Details:" line (and logged to the console).
  const [dualDetails, setDualDetails] = useState<string | null>(null);
  // R30 — true while the dual probe is running (both cameras can take
  // a few seconds to open + settle): the button disables and relabels.
  const [dualBusy, setDualBusy] = useState(false);
  // R30 — the mic call failed after both cameras passed: dual
  // recording proceeds WITHOUT sound and the user is told up front.
  const [dualMicMissing, setDualMicMissing] = useState(false);
  const [dualCamCount, setDualCamCount] = useState(0);
  const [pendingDual, setPendingDual] = useState<{
    mainBlob: Blob;
    mainUrl: string;
    frontBlob: Blob;
    frontUrl: string;
    startDeltaMs: number;
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
  }, []);

  const startStream = useCallback(async () => {
    setError(null);
    setIsReady(false);
    stopStream();
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera capture is not supported in this browser. Use file upload instead.');
      return;
    }
    // R24 WS-P1: walk the constraint ladder in order. A rung that the
    // device rejects as over-constrained / not found falls through to
    // the next rung; the final rung is the pre-R24 permissive ideal-1080
    // request, so capture never hard-fails on resolution grounds. Any
    // other error (permission denied, no device busy, …) aborts at once.
    const attempts = buildCaptureAttempts({
      canvasWidth,
      canvasHeight,
      facingMode,
      quality: qualityChoice,
      frameRate: fpsChoice,
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
        setZoomValue(typeof settings?.zoom === 'number' ? settings.zoom : capability.min);
      }
    } catch {
      setZoomCapability(null);
    }
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
      if (!onCaptureDual) return;
      setDualNotice(null);
      setDualDetails(null);
      dropStep1Url();
      dispatchTwoPass({ type: 'enter', viaDualFallback });
      if (facingMode !== 'environment') {
        setFacingMode('environment');
      } else {
        void startStream();
      }
    },
    [onCaptureDual, dropStep1Url, dispatchTwoPass, facingMode, startStream],
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
    if (!onCaptureDual) return;
    setDualNotice(null);
    setDualDetails(null);
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
  }, [onCaptureDual, stopStream, canvasWidth, canvasHeight, startStream]);

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
   */
  const applyZoom = useCallback((value: number) => {
    setZoomValue(value);
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track?.applyConstraints) return;
    void track
      .applyConstraints({ advanced: [{ zoom: value } as MediaTrackConstraintSet] })
      .catch(() => {});
  }, []);

  /**
   * The MediaRecorder creation fallback chain, shared by single and
   * dual recording: tier options with the preferred codec → tier
   * options without mimeType → bare. On total failure it sets the same
   * error message the single path always used and returns null.
   */
  const createRecorder = useCallback((stream: MediaStream): MediaRecorder | null => {
    // R24 WS-P1: bitrate by the tier the device ACTUALLY negotiated
    // (the video track's reported settings), not the browser default.
    const trackSettings = stream.getVideoTracks()[0]?.getSettings?.();
    try {
      return new MediaRecorder(
        stream,
        recorderOptionsForTrackSettings(trackSettings, 'video/webm;codecs=vp9,opus'),
      );
    } catch {
      try {
        // Same tier bitrates without the preferred mimeType, in case
        // the codec string (not the options) is what the browser rejects.
        return new MediaRecorder(stream, recorderOptionsForTrackSettings(trackSettings));
      } catch {
        try {
          return new MediaRecorder(stream);
        } catch (err: any) {
          setError(`This browser cannot record video: ${err?.message || err}`);
          return null;
        }
      }
    }
  }, []);

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
    const rearRecorder = createRecorder(streamRef.current);
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
    const handleDualStop = () => {
      dualStoppedRef.current += 1;
      if (dualStoppedRef.current < 2) return;
      const mainBlob = new Blob(dualChunksRef.current.rear, { type: rearRecorder.mimeType || 'video/webm' });
      const frontBlob = new Blob(dualChunksRef.current.front, { type: frontRecorder.mimeType || 'video/webm' });
      stopStream();
      setPendingDual({
        mainBlob,
        mainUrl: URL.createObjectURL(mainBlob),
        frontBlob,
        frontUrl: URL.createObjectURL(frontBlob),
        startDeltaMs: dualStartRef.current ? dualStartRef.current.frontStartMs - dualStartRef.current.rearStartMs : 0,
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
    dualStartRef.current = { anchorMs, rearStartMs, frontStartMs };
    recorderRef.current = rearRecorder;
    frontRecorderRef.current = frontRecorder;
    setIsRecording(true);
    setRecordSeconds(0);
  }, [dualMode, isReady, createRecorder, stopStream, canvasWidth, canvasHeight]);

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || !isReady) return;
    if (dualMode) {
      void startDualRecording();
      return;
    }
    chunksRef.current = [];
    const recorder = createRecorder(stream);
    if (!recorder) return;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'video/webm' });
      // R31 — in two-pass step 1 this same stop also feeds the flow:
      // the blob becomes the machine's main take, and the flow retains
      // its OWN object URL for it in `step1UrlRef` (separate from the
      // review URL `pendingVideo` gets below — that one is revoked
      // when the review clears, this one must live into step 2).
      if (twoPassPhaseRef.current === 'step1-live') {
        dropStep1Url();
        step1UrlRef.current = URL.createObjectURL(blob);
        dispatchTwoPass({ type: 'step1-recorded', blob });
      }
      // Hold for the review state (see `pendingVideo`) instead of handing
      // off immediately, and stop the live stream while reviewing — the
      // camera doesn't need to stay hot for a decision, and the review
      // <video> replaces the live preview in the same frame.
      stopStream();
      setPendingVideo({ blob, url: URL.createObjectURL(blob) });
    };
    recorder.start();
    recorderRef.current = recorder;
    setIsRecording(true);
    setRecordSeconds(0);
  }, [isReady, stopStream, dualMode, startDualRecording, createRecorder, dropStep1Url, dispatchTwoPass]);

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
      void startStream();
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
    const recorder = createRecorder(stream);
    if (!recorder) return;
    step2ChunksRef.current = [];
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
      // Transfer the retained step-1 URL into pendingDual: clearing
      // the ref hands ownership to the pendingDual effect, which
      // revokes it when the review clears.
      step1UrlRef.current = null;
      dispatchTwoPass({ type: 'step2-recorded', blob: frontBlob, startDeltaMs });
      stopStream();
      setPendingDual({ mainBlob, mainUrl, frontBlob, frontUrl: URL.createObjectURL(frontBlob), startDeltaMs });
    };
    recorder.start();
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
  }, [isReady, createRecorder, stopStream, dispatchTwoPass, twoPass.mainBlob]);

  /** Review-state confirm: hand the SAME CaptureResult to the normal path or the overlay path, per the user's pick. */
  const confirmPendingVideo = useCallback(
    (asOverlay: boolean) => {
      if (!pendingVideo) return;
      const result: CaptureResult = { kind: 'video', blob: pendingVideo.blob };
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
      main: { kind: 'video', blob: pendingDual.mainBlob },
      overlay: { kind: 'video', blob: pendingDual.frontBlob },
      startDeltaMs: pendingDual.startDeltaMs,
    };
    setPendingDual(null);
    onCaptureDual(payload);
  }, [pendingDual, onCaptureDual]);

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
    dispatchTwoPass({ type: 'start-over' });
    setPendingDual(null);
    if (facingMode !== 'environment') {
      setFacingMode('environment');
    } else {
      void startStream();
    }
  }, [dropStep1Url, dispatchTwoPass, facingMode, startStream]);

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

  const nearLimit = recordSeconds >= MAX_MEDIA_SECONDS - 5;

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
          <div className="flex items-center gap-2 max-w-md w-full rounded-lg bg-amber-500/15 border border-amber-500/30 px-3 py-2 text-[11px] text-amber-200">
            <span className="flex-1">
              {dualNotice}
              {dualDetails && <span className="block mt-0.5 text-amber-200/70">Details: {dualDetails}</span>}
            </span>
            {onCaptureDual && twoPassPhase === 'off' && (
              <button
                onClick={() => enterTwoPass(true)}
                className="shrink-0 min-h-8 px-2.5 flex items-center justify-center rounded-md bg-amber-400/20 hover:bg-amber-400/30 text-amber-100 text-[11px] font-bold"
              >
                Record in two steps instead
              </button>
            )}
            <button
              onClick={() => {
                setDualNotice(null);
                setDualDetails(null);
              }}
              aria-label="Dismiss"
              className="shrink-0 min-h-8 min-w-8 flex items-center justify-center text-amber-200/70 hover:text-amber-100"
            >
              ×
            </button>
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
                disabled={isRecording || dualMode}
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
                onClick={() => setFpsChoice(fps)}
                disabled={isRecording || dualMode}
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
        </div>
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
            {dualBusy ? 'Checking cameras…' : 'Record both cameras'}
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
            onClick={twoPassPhase === 'step2-live' ? startStep2Recording : startRecording}
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
