import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clapperboard, PictureInPicture2 } from 'lucide-react';
import { MAX_MEDIA_SECONDS } from '../../lib/media/constants';

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

/**
 * Roughly "1080p-class" ideal recording dimensions for a given project
 * aspect ratio: the SHORTER side is targeted at 1080px, the longer side
 * derived from the ratio — e.g. 16:9 -> 1920x1080, 9:16 -> 1080x1920, 1:1 ->
 * 1080x1080, 4:5 -> 1080x1350. Passed to `getUserMedia` as `ideal` (never
 * `exact`/`min`) constraints, so a camera that can't reach this just
 * negotiates its own best available match instead of failing outright —
 * "graceful fallback", per the spec.
 */
function idealRecordingDimensions(canvasWidth: number, canvasHeight: number): { width: number; height: number; ratio: number } {
  const ratio = canvasWidth > 0 && canvasHeight > 0 ? canvasWidth / canvasHeight : 9 / 16;
  if (ratio >= 1) {
    return { width: Math.round(1080 * ratio), height: 1080, ratio };
  }
  return { width: 1080, height: Math.round(1080 / ratio), ratio };
}

export function CameraCapture({ onCapture, onCaptureAsOverlay, onClose, canvasWidth, canvasHeight }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
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

  const ideal = useMemo(() => idealRecordingDimensions(canvasWidth, canvasHeight), [canvasWidth, canvasHeight]);
  const previewAspectRatio = canvasWidth > 0 && canvasHeight > 0 ? `${canvasWidth} / ${canvasHeight}` : '9 / 16';

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const startStream = useCallback(async () => {
    setError(null);
    setIsReady(false);
    stopStream();
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera capture is not supported in this browser. Use file upload instead.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode,
          // "ideal", not "exact"/"min" — a device that can't hit 1080p-class
          // or this exact aspect ratio negotiates its own closest match
          // instead of getUserMedia rejecting the request outright. This is
          // what replaces the previous no-constraints-at-all call that
          // silently produced a fixed 640x480 recording regardless of the
          // project's actual format.
          width: { ideal: ideal.width },
          height: { ideal: ideal.height },
          aspectRatio: { ideal: ideal.ratio },
          frameRate: { ideal: 30 },
        },
        audio: true,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setIsReady(true);
    } catch (err: any) {
      setError(
        err?.name === 'NotAllowedError'
          ? 'Camera/microphone access was denied. Allow access in your browser settings, or use file upload instead.'
          : `Could not start the camera: ${err?.message || err}`,
      );
    }
  }, [facingMode, ideal, stopStream]);

  useEffect(() => {
    startStream();
    return () => stopStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facingMode, ideal.width, ideal.height]);

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

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || !isReady) return;
    chunksRef.current = [];
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9,opus' });
    } catch {
      try {
        recorder = new MediaRecorder(stream);
      } catch (err: any) {
        setError(`This browser cannot record video: ${err?.message || err}`);
        return;
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
        <video ref={videoRef} muted playsInline className="w-full h-full object-cover" />
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
            className="px-4 py-2 text-xs font-bold uppercase tracking-wide bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-lg text-white"
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
      )}
    </div>
  );
}
