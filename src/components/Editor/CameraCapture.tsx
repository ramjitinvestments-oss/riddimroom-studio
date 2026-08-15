import React, { useCallback, useEffect, useRef, useState } from 'react';

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
 */

export type CaptureResult = { kind: 'photo'; blob: Blob } | { kind: 'video'; blob: Blob };

interface CameraCaptureProps {
  onCapture: (result: CaptureResult) => void;
  onClose: () => void;
}

export function CameraCapture({ onCapture, onClose }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [error, setError] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [isReady, setIsReady] = useState(false);

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
        video: { facingMode },
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
  }, [facingMode, stopStream]);

  useEffect(() => {
    startStream();
    return () => stopStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facingMode]);

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
      onCapture({ kind: 'video', blob });
    };
    recorder.start();
    recorderRef.current = recorder;
    setIsRecording(true);
    setRecordSeconds(0);
  }, [isReady, onCapture]);

  useEffect(() => {
    if (!isRecording) return;
    const interval = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [isRecording]);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setIsRecording(false);
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center justify-center gap-4 p-6">
      <div className="relative w-full max-w-md aspect-[9/16] bg-black rounded-xl overflow-hidden border border-white/10">
        <video ref={videoRef} muted playsInline className="w-full h-full object-cover" />
        {isRecording && (
          <div className="absolute top-3 left-3 flex items-center gap-2 bg-red-600/90 text-white text-xs font-bold px-2 py-1 rounded">
            <span className="w-2 h-2 rounded-full bg-white animate-pulse" /> REC {recordSeconds}s
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center p-6 bg-black/80 text-center text-sm text-red-300">
            {error}
          </div>
        )}
      </div>

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
    </div>
  );
}
