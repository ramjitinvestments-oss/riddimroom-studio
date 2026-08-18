import React, { useCallback, useRef, useState } from 'react';
import { validateMediaFile } from '../../lib/media/validate';
import { uploadMediaFile, type UploadProgressEvent } from '../../lib/media/upload';
import { generateTimelineId } from '../../lib/timeline/utils';
import type { MediaAsset } from '../../types/timeline';
import { CameraCapture, type CaptureResult } from './CameraCapture';

/**
 * Phase 1 Step 4-5 (Capture + Upload).
 *
 * Owns validation -> upload-with-progress -> retry-on-failure for both file
 * import and live camera capture, and hands the caller a finished
 * `MediaAsset` once bytes are actually in Firebase Storage (never keeps
 * media only in React state — the asset object holds a real Storage
 * download URL, not a local blob URL, by the time onAssetUploaded fires).
 */

interface PendingUpload {
  id: string;
  fileName: string;
  file: File;
  progress: number;
  status: 'uploading' | 'error' | 'done';
  error?: string;
}

interface MediaImportPanelProps {
  uid: string;
  onAssetUploaded: (asset: MediaAsset) => void;
}

export function MediaImportPanel({ uid, onAssetUploaded }: MediaImportPanelProps) {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [showCamera, setShowCamera] = useState(false);
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
          onAssetUploaded(asset);
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
    (file: File) => {
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
  }, []);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      Array.from(files).forEach(startUpload);
    },
    [startUpload],
  );

  const handleCapture = useCallback(
    (result: CaptureResult) => {
      setShowCamera(false);
      const extension = result.kind === 'photo' ? 'jpg' : 'webm';
      const mimeType = result.kind === 'photo' ? 'image/jpeg' : (result.blob.type || 'video/webm');
      const file = new File([result.blob], `capture-${Date.now()}.${extension}`, { type: mimeType });
      startUpload(file);
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

      {showCamera && <CameraCapture onCapture={handleCapture} onClose={() => setShowCamera(false)} />}
    </div>
  );
}
