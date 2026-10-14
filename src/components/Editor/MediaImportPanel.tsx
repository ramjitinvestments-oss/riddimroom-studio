import React, { useCallback, useRef, useState } from 'react';
import { AudioLines, Camera, Clapperboard, PictureInPicture2 } from 'lucide-react';
import { validateMediaFile } from '../../lib/media/validate';
import { uploadMediaFile, type UploadProgressEvent } from '../../lib/media/upload';
import { probeMediaFile, mediaKindForMimeType } from '../../lib/media/probe';
import { MAX_MEDIA_SECONDS } from '../../lib/media/constants';
import { generateTimelineId } from '../../lib/timeline/utils';
import type { AudioTimelineItem, MediaAsset } from '../../types/timeline';
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

/**
 * Tweaks round — every upload enters through one of three unmistakable
 * actions, and the purpose travels with the upload (through the probe /
 * trim-select modal too) so the finished asset lands where the user
 * asked: 'main' → the main timeline, 'overlay' → a PiP/image overlay,
 * 'audio' → the music/audio track. All three run the exact same
 * validate → probe → upload pipeline; purpose only changes the routing
 * callback at the end.
 */
type UploadPurpose = 'main' | 'overlay' | 'audio';

export interface AssetUploadedOptions {
  trimStart?: number;
  trimEnd?: number;
  /** Audio purpose only — device audio lands as a music-track item. */
  role?: AudioTimelineItem['role'];
}

interface UploadMeta {
  trimStart?: number;
  trimEnd?: number;
  isCameraCapture?: boolean;
  purpose?: UploadPurpose;
}

interface PendingTrimSelection {
  file: File;
  kind: 'video' | 'audio';
  durationSeconds: number;
  purpose: UploadPurpose;
}

interface MediaImportPanelProps {
  uid: string;
  /** The project's canvas dimensions — threaded down to `CameraCapture` so recording can negotiate a matching, non-distorted aspect ratio. */
  canvasWidth: number;
  canvasHeight: number;
  onAssetUploaded: (asset: MediaAsset, options?: AssetUploadedOptions) => void;
  /** "Add Overlay" uploads route here instead (PiP video / corner image overlay). Falls back to `onAssetUploaded` when not provided. */
  onOverlayAssetUploaded?: (asset: MediaAsset, options?: AssetUploadedOptions) => void;
}

export function MediaImportPanel({ uid, canvasWidth, canvasHeight, onAssetUploaded, onOverlayAssetUploaded }: MediaImportPanelProps) {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [showCamera, setShowCamera] = useState(false);
  const [pendingTrim, setPendingTrim] = useState<PendingTrimSelection | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Tweaks round — one hidden input per clear action (main / overlay /
  // audio). All three feed the exact same `handleFiles`/`startUpload`/
  // `uploadMediaFile` pipeline — the separate inputs exist purely so each
  // action can carry its own `accept` filter and routing purpose, not as
  // parallel upload systems.
  const overlayInputRef = useRef<HTMLInputElement>(null);
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
          // Route by the purpose the upload started with (tweaks round):
          // overlay uploads land as PiP/corner overlays, device audio
          // lands on the music track, everything else on the main
          // timeline — all through the caller's existing insert paths.
          const purpose = meta?.purpose ?? 'main';
          const hasTrim = trimStart !== undefined || trimEnd !== undefined;
          if (purpose === 'overlay' && onOverlayAssetUploaded) {
            onOverlayAssetUploaded(asset, hasTrim ? { trimStart, trimEnd } : undefined);
          } else if (purpose === 'audio') {
            onAssetUploaded(asset, { trimStart, trimEnd, role: 'music' });
          } else {
            onAssetUploaded(asset, hasTrim ? { trimStart, trimEnd } : undefined);
          }
          uploadMetaByUploadId.current.delete(uploadId);
        })
        .catch((err: any) => {
          setPending((list) =>
            list.map((u) => (u.id === uploadId ? { ...u, status: 'error', error: err?.message || 'Upload failed.' } : u)),
          );
        });
    },
    [uid, onAssetUploaded, onOverlayAssetUploaded],
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
    (file: File, purpose: UploadPurpose) => {
      const mimeType = file.type || '';
      const kind = mediaKindForMimeType(mimeType);
      if (kind !== 'video' && kind !== 'audio') {
        startUpload(file, { purpose });
        return;
      }
      probeMediaFile(file, mimeType)
        .then((probed) => {
          const dur = probed.durationSeconds;
          if (typeof dur === 'number' && Number.isFinite(dur) && dur > MAX_MEDIA_SECONDS + 0.25) {
            setPendingTrim({ file, kind, durationSeconds: dur, purpose });
          } else {
            startUpload(file, { purpose });
          }
        })
        .catch(() => startUpload(file, { purpose }));
    },
    [startUpload],
  );

  const handleFiles = useCallback(
    (files: FileList | null, purpose: UploadPurpose) => {
      if (!files) return;
      Array.from(files).forEach((file) => intakeFile(file, purpose));
    },
    [intakeFile],
  );

  const startCaptureUpload = useCallback(
    (result: CaptureResult, purpose: UploadPurpose) => {
      setShowCamera(false);
      const extension = result.kind === 'photo' ? 'jpg' : 'webm';
      const mimeType = result.kind === 'photo' ? 'image/jpeg' : (result.blob.type || 'video/webm');
      const file = new File([result.blob], `capture-${Date.now()}.${extension}`, { type: mimeType });
      // Deliberately bypasses intakeFile/probe-then-modal — the camera
      // already auto-stopped this recording at the limit, so a second
      // trim-select prompt right after recording would be redundant
      // friction; runUpload applies a silent defensive clamp instead (see
      // its own comment above). The purpose rides along so a recording
      // the user chose as an overlay in the camera's review state routes
      // to the overlay insert path in `runUpload`, exactly like an
      // "Add Overlay" file upload.
      startUpload(file, result.kind === 'video' ? { isCameraCapture: true, purpose } : { purpose });
    },
    [startUpload],
  );

  const handleCapture = useCallback(
    (result: CaptureResult) => startCaptureUpload(result, 'main'),
    [startCaptureUpload],
  );

  const handleCaptureAsOverlay = useCallback(
    (result: CaptureResult) => {
      // CameraCapture only offers the overlay choice for VIDEO review
      // states; anything else takes the normal path defensively.
      if (result.kind !== 'video' || !onOverlayAssetUploaded) {
        startCaptureUpload(result, 'main');
        return;
      }
      startCaptureUpload(result, 'overlay');
    },
    [startCaptureUpload, onOverlayAssetUploaded],
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Tweaks round — three unmistakable add actions. "Add Video /
          Image" is THE main-timeline action (gold, primary); "Add
          Overlay" and "Add Audio" sit beside it at the same size so a
          first-time user never has to guess which generic "upload"
          button does what. Camera stays as a quieter secondary action. */}
      <div className="flex flex-col gap-2">
        <button
          onClick={() => fileInputRef.current?.click()}
          className="min-h-12 px-4 rounded-xl bg-gold hover:bg-gold-bright text-black text-sm font-bold flex items-center justify-center gap-2 transition"
        >
          <Clapperboard size={18} /> Add Video / Image
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => overlayInputRef.current?.click()}
            className="min-h-12 flex-1 px-3 rounded-xl border border-gold/40 bg-gold/10 hover:bg-gold/20 text-gold text-sm font-bold flex items-center justify-center gap-2 transition"
            title="Add a video or image ON TOP of your main video (talking-head, logo, reaction clip)"
          >
            <PictureInPicture2 size={17} /> Add Overlay
          </button>
          <button
            onClick={() => audioInputRef.current?.click()}
            className="min-h-12 flex-1 px-3 rounded-xl border border-white/15 bg-white/5 hover:bg-white/10 text-white text-sm font-bold flex items-center justify-center gap-2 transition"
            title="Add music, voiceover, or sound effects from your device — lands on the music track"
          >
            <AudioLines size={17} /> Add Audio
          </button>
        </div>
        <button
          onClick={() => setShowCamera(true)}
          className="min-h-10 px-3 rounded-lg text-white/60 hover:text-white hover:bg-white/5 text-xs font-bold flex items-center justify-center gap-1.5 transition"
        >
          <Camera size={14} /> Record with camera instead
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files, 'main');
            e.target.value = '';
          }}
        />
        <input
          ref={overlayInputRef}
          type="file"
          accept="video/*,image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files, 'overlay');
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
            handleFiles(e.target.files, 'audio');
            e.target.value = '';
          }}
        />
      </div>

      <p className="text-[10px] text-white/30">Videos, songs, and audio are limited to {MAX_MEDIA_SECONDS} seconds per clip.</p>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleFiles(e.dataTransfer.files, 'main');
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
                  <div className="h-full bg-gold" style={{ width: `${Math.round(upload.progress * 100)}%` }} />
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
        <CameraCapture
          onCapture={handleCapture}
          onCaptureAsOverlay={onOverlayAssetUploaded ? handleCaptureAsOverlay : undefined}
          onClose={() => setShowCamera(false)}
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
        />
      )}

      {pendingTrim && (
        <TrimSelectModal
          file={pendingTrim.file}
          kind={pendingTrim.kind}
          durationSeconds={pendingTrim.durationSeconds}
          onCancel={() => setPendingTrim(null)}
          onConfirm={({ trimStart, trimEnd }) => {
            const { file, purpose } = pendingTrim;
            setPendingTrim(null);
            startUpload(file, { trimStart, trimEnd, purpose });
          }}
        />
      )}
    </div>
  );
}
