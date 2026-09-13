import React, { useCallback, useRef, useState } from 'react';
import { validateMediaFile } from '../../lib/media/validate';
import { uploadMediaFile, type UploadProgressEvent } from '../../lib/media/upload';
import { probeMediaFile, mediaKindForMimeType } from '../../lib/media/probe';
import { MAX_MEDIA_SECONDS } from '../../lib/media/constants';
import { generateTimelineId } from '../../lib/timeline/utils';
import type { MediaAsset } from '../../types/timeline';
import { CameraCapture, type CaptureResult } from './CameraCapture';
import { TrimSelectModal } from './TrimSelectModal';

/**
 * Phase 1 Step 4-5 (Capture + Upload).
 *
 * Owns validation -> upload-with-progress -> retry-on-failure for both file
 * import and live camera capture, and hands the caller a finished
 * `MediaAsset` once bytes are actually in Firebase Storage (never keeps
 * media only in React state — the asset object holds a real Storage
 * download URL, not a local blob URL, by the time onAssetUploaded fires).
 *
 * "Universal 30-second media standard" pass: video/audio files are now
 * probed for duration BEFORE any upload starts. A file at or under
 * `MAX_MEDIA_SECONDS` uploads exactly as before. A file over the limit opens
 * `TrimSelectModal` instead — the user picks a <=30s window, and only that
 * window's `trimStart`/`trimEnd` (passed through to `onAssetUploaded`, then
 * `appendMediaToTimeline`) ever lands on the timeline; the full file is
 * still what gets uploaded to Storage (re-uploading a trimmed blob would
 * need a client-side re-encode, out of scope here — the SELECTED WINDOW is
 * what matters for the product rule, not the bytes at rest in Storage).
 * Camera recordings skip this modal entirely (the camera already
 * auto-stops at the limit) but still get defensively clamped in case of a
 * few hundred ms of stop-latency overshoot.
 */

interface PendingUpload {
  id: string;
  fileName: string;
  file: File;
  progress: number;
  status: 'uploading' | 'error' | 'done';
  error?: string;
}

interface UploadMeta {
  trimStart?: number;
  trimEnd?: number;
  isCameraCapture?: boolean;
}

interface PendingTrimSelection {
  file: File;
  kind: 'video' | 'audio';
  durationSeconds: number;
}

interface MediaImportPanelProps {
  uid: string;
  /** The project's canvas dimensions — threaded down to `CameraCapture` so recording can negotiate a matching, non-distorted aspect ratio. */
  canvasWidth: number;
  canvasHeight: number;
  onAssetUploaded: (asset: MediaAsset, options?: { trimStart?: number; trimEnd?: number }) => void;
}

export function MediaImportPanel({ uid, canvasWidth, canvasHeight, onAssetUploaded }: MediaImportPanelProps) {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [showCamera, setShowCamera] = useState(false);
  const [pendingTrim, setPendingTrim] = useState<PendingTrimSelection | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // "Final production fix" spec item 5 — a dedicated, clearly-visible
  // "Upload Audio" action, distinct from the generic "Upload file" input.
  // Deliberately a SECOND <input accept="audio/*"> wired to the exact same
  // `handleFiles`/`startUpload`/`uploadMediaFile`/`appendMediaToTimeline`
  // pipeline as every other upload, not a parallel audio-upload system —
  // this only changes discoverability (a user shouldn't have to guess that
  // the generic file button also accepts audio), not the underlying flow.
  const audioInputRef = useRef<HTMLInputElement>(null);
  const assetIdByUploadId = useRef<Map<string, string>>(new Map());
  const uploadMetaByUploadId = useRef<Map<string, UploadMeta>>(new Map());

  const runUpload = useCallback(
    (uploadId: string, file: File, assetId: string) => {
      uploadMediaFile({
        uid,
        file,
        assetId,
        onProgress: (evt: UploadProgressEvent) => {
          setPending((list) => list.map((u) => (u.id === uploadId ? { ...u, progress: evt.fraction } : u)));
        },
      })
        .then(({ asset }) => {
          setPending((list) => list.map((u) => (u.id === uploadId ? { ...u, status: 'done', progress: 1 } : u)));
          const meta = uploadMetaByUploadId.current.get(uploadId);
          let trimStart = meta?.trimStart;
          let trimEnd = meta?.trimEnd;
          // Camera recordings skip the trim/select modal (see header
          // comment) but still get a defensive clamp: the auto-stop timer
          // in CameraCapture fires on a 1s tick, so the real recorded
          // duration can land a fraction of a second past the limit —
          // that's clamped here silently rather than surfacing a
          // trim-select prompt for a sub-second timing artifact.
          if (meta?.isCameraCapture && typeof asset.durationSeconds === 'number' && asset.durationSeconds > MAX_MEDIA_SECONDS + 0.05) {
            trimStart = 0;
            trimEnd = MAX_MEDIA_SECONDS;
          }
          onAssetUploaded(asset, trimStart !== undefined || trimEnd !== undefined ? { trimStart, trimEnd } : undefined);
          uploadMetaByUploadId.current.delete(uploadId);
        })
        .catch((err: any) => {
          setPending((list) =>
            list.map((u) => (u.id === uploadId ? { ...u, status: 'error', error: err?.message || 'Upload failed.' } : u)),
          );
        });
    },
    [uid, onAssetUploaded],
  );

  const startUpload = useCallback(
    (file: File, meta?: UploadMeta) => {
      const validation = validateMediaFile(file);
      const uploadId = generateTimelineId('upload');
      if (!validation.valid) {
        setPending((list) => [
          ...list,
          { id: uploadId, fileName: file.name, file, progress: 0, status: 'error', error: validation.error },
        ]);
        return;
      }
      const assetId = generateTimelineId('asset');
      assetIdByUploadId.current.set(uploadId, assetId);
      if (meta) uploadMetaByUploadId.current.set(uploadId, meta);
      setPending((list) => [...list, { id: uploadId, fileName: file.name, file, progress: 0, status: 'uploading' }]);
      runUpload(uploadId, file, assetId);
    },
    [runUpload],
  );

  const retryUpload = useCallback(
    (uploadId: string) => {
      const upload = pending.find((u) => u.id === uploadId);
      if (!upload) return;
      const assetId = assetIdByUploadId.current.get(uploadId) ?? generateTimelineId('asset');
      assetIdByUploadId.current.set(uploadId, assetId);
      setPending((list) => list.map((u) => (u.id === uploadId ? { ...u, status: 'uploading', progress: 0, error: undefined } : u)));
      runUpload(uploadId, upload.file, assetId);
    },
    [pending, runUpload],
  );

  const dismissUpload = useCallback((uploadId: string) => {
    setPending((list) => list.filter((u) => u.id !== uploadId));
    assetIdByUploadId.current.delete(uploadId);
    uploadMetaByUploadId.current.delete(uploadId);
  }, []);

  /**
   * "Universal 30-second media standard" spec item 2 — the actual gate.
   * Probes duration BEFORE uploading a single byte; only video/audio files
   * are duration-limited (images have no intrinsic duration). A probe
   * failure (unusual codec, corrupt file, etc.) falls through to the normal
   * upload path rather than blocking the user — `uploadMediaFile` already
   * has its own best-effort probe-failure fallback, so this mirrors that
   * same "never let a probe quirk block a real upload" policy.
   */
  const intakeFile = useCallback(
    (file: File) => {
      const mimeType = file.type || '';
      const kind = mediaKindForMimeType(mimeType);
      if (kind !== 'video' && kind !== 'audio') {
        startUpload(file);
        return;
      }
      probeMediaFile(file, mimeType)
        .then((probed) => {
          const dur = probed.durationSeconds;
          if (typeof dur === 'number' && Number.isFinite(dur) && dur > MAX_MEDIA_SECONDS + 0.25) {
            setPendingTrim({ file, kind, durationSeconds: dur });
          } else {
            startUpload(file);
          }
        })
        .catch(() => startUpload(file));
    },
    [startUpload],
  );

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      Array.from(files).forEach(intakeFile);
    },
    [intakeFile],
  );

  const handleCapture = useCallback(
    (result: CaptureResult) => {
      setShowCamera(false);
      const extension = result.kind === 'photo' ? 'jpg' : 'webm';
      const mimeType = result.kind === 'photo' ? 'image/jpeg' : (result.blob.type || 'video/webm');
      const file = new File([result.blob], `capture-${Date.now()}.${extension}`, { type: mimeType });
      // Deliberately bypasses intakeFile/probe-then-modal — the camera
      // already auto-stopped this recording at the limit, so a second
      // trim-select prompt right after recording would be redundant
      // friction; runUpload applies a silent defensive clamp instead (see
      // its own comment above).
      startUpload(file, result.kind === 'video' ? { isCameraCapture: true } : undefined);
    },
    [startUpload],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button
          onClick={() => fileInputRef.current?.click()}
          className="px-3 py-2 text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 rounded-lg text-white"
        >
          Upload file
        </button>
        <button
          onClick={() => setShowCamera(true)}
          className="px-3 py-2 text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 rounded-lg text-white"
        >
          Use camera
        </button>
        <button
          onClick={() => audioInputRef.current?.click()}
          className="px-3 py-2 text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 rounded-lg text-white"
          title="Add music, voiceover, or sound effects from your device"
        >
          Upload audio
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,image/*,audio/*"
          multiple
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <input
          ref={audioInputRef}
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg"
          multiple
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      <p className="text-[10px] text-white/30">Videos, songs, and audio are limited to {MAX_MEDIA_SECONDS} seconds per clip.</p>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleFiles(e.dataTransfer.files);
        }}
        className="border border-dashed border-white/15 rounded-lg px-4 py-6 text-center text-xs text-white/40"
      >
        Drag and drop video, image, or audio files here
      </div>

      {pending.length > 0 && (
        <ul className="flex flex-col gap-2">
          {pending.map((upload) => (
            <li key={upload.id} className="flex items-center gap-2 text-xs bg-white/5 rounded-lg px-3 py-2">
              <span className="flex-1 truncate text-white/70">{upload.fileName}</span>
              {upload.status === 'uploading' && (
                <div className="w-24 h-1.5 bg-white/10 rounded overflow-hidden">
                  <div className="h-full bg-emerald-500" style={{ width: `${Math.round(upload.progress * 100)}%` }} />
                </div>
              )}
              {upload.status === 'done' && <span className="text-emerald-400 font-bold">Done</span>}
              {upload.status === 'error' && (
                <>
                  <span className="text-red-400 max-w-[16rem] truncate" title={upload.error}>
                    {upload.error}
                  </span>
                  <button onClick={() => retryUpload(upload.id)} className="text-white/60 hover:text-white underline">
                    Retry
                  </button>
                </>
              )}
              {(upload.status === 'error' || upload.status === 'done') && (
                <button onClick={() => dismissUpload(upload.id)} className="text-white/30 hover:text-white/70">
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {showCamera && (
        <CameraCapture onCapture={handleCapture} onClose={() => setShowCamera(false)} canvasWidth={canvasWidth} canvasHeight={canvasHeight} />
      )}

      {pendingTrim && (
        <TrimSelectModal
          file={pendingTrim.file}
          kind={pendingTrim.kind}
          durationSeconds={pendingTrim.durationSeconds}
          onCancel={() => setPendingTrim(null)}
          onConfirm={({ trimStart, trimEnd }) => {
            const file = pendingTrim.file;
            setPendingTrim(null);
            startUpload(file, { trimStart, trimEnd });
          }}
        />
      )}
    </div>
  );
}
