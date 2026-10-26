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
 */

export type CaptureResult = { kind: 'photo'; blob: Blob } | { kind: 'video'; blob: Blob };

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
  onClose: () => void;
  /** The project's own canvas dimensions — used to negotiate a matching, non-distorted recording aspect ratio (16:9 / 9:16 / 1:1 / 4:5, whatever the project actually is), and to size the live preview box to match. */
  canvasWidth: number;
  canvasHeight: number;
}

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function CameraCapture({ onCapture, onCaptureAsOverlay, onClose, canvasWidth, canvasHeight }: CameraCaptureProps) {
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

  const previewAspectRatio = canvasWidth > 0 && canvasHeight > 0 ? `${canvasWidth} / ${canvasHeight}` : '9 / 16';

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
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

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || !isReady) return;
    chunksRef.current = [];
    // R24 WS-P1: bitrate by the tier the device ACTUALLY negotiated
    // (the video track's reported settings), not the browser default.
    const trackSettings = stream.getVideoTracks()[0]?.getSettings?.();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(
        stream,
        recorderOptionsForTrackSettings(trackSettings, 'video/webm;codecs=vp9,opus'),
      );
    } catch {
      try {
        // Same tier bitrates without the preferred mimeType, in case
        // the codec string (not the options) is what the browser rejects.
        recorder = new MediaRecorder(stream, recorderOptionsForTrackSettings(trackSettings));
      } catch {
        try {
          recorder = new MediaRecorder(stream);
        } catch (err: any) {
          setError(`This browser cannot record video: ${err?.message || err}`);
          return;
        }
      }
    }
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'video/webm' });
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
  }, [isReady, stopStream]);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setIsRecording(false);
  }, []);

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
          style={{ transform: previewMirrorTransform(facingMode) }}
        />
        {/* WS-P3: framing guides — pure DOM/SVG overlay, pointer-events
            none. The recording path captures the media stream, never
            this DOM, so guides can never appear in a recording. Hidden
            while a recording is being reviewed. */}
        {showGuides && !pendingVideo && !error && (
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
        {error && (
          <div className="absolute inset-0 flex items-center justify-center p-6 bg-black/80 text-center text-sm text-red-300">
            {error}
          </div>
        )}
      </div>

      {pendingVideo ? (
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
      ) : (
      <div className="flex flex-col items-center gap-3">
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
                disabled={isRecording}
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
                disabled={isRecording}
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
      <div className="flex items-center gap-3">
        <button
          onClick={() => setFacingMode((m) => (m === 'user' ? 'environment' : 'user'))}
          disabled={isRecording}
          className="px-3 py-2 text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 disabled:opacity-40 rounded-lg text-white"
        >
          Flip camera
        </button>
        <button
          onClick={takePhoto}
          disabled={!isReady || isRecording}
          className="px-4 py-2 text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 disabled:opacity-40 rounded-lg text-white"
        >
          Photo
        </button>
        {!isRecording ? (
          <button
            onClick={startRecording}
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
