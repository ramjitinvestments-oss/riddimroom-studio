import React, { useRef, useState } from 'react';
import { useProject } from '../../context/ProjectContext';
import { addWatermarkItem } from '../../lib/timeline/insert';
import { validateMediaFile } from '../../lib/media/validate';
import { uploadMediaFile } from '../../lib/media/upload';
import { getProjectDuration } from '../../lib/timeline/utils';

/**
 * Phase 1 Step 8 (Watermark overlay) — adds an `image` timeline item with
 * `role: 'watermark'` (source: EventCam's percentage-based
 * `WatermarkSettings`, generalized in the timeline foundation — see
 * `src/types/timeline.ts`), spanning the whole current project duration by
 * default (a watermark is normally present start-to-finish).
 */
export function WatermarkPanel({ uid }: { uid: string }) {
  const { project, mutate } = useProject();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!project) return null;

  const imageAssets = Object.values(project.mediaAssets).filter((asset) => asset.kind === 'image');

  const placeWatermark = (assetId: string) => {
    const asset = project.mediaAssets[assetId];
    if (!asset) return;
    const duration = Math.max(getProjectDuration(project), 5);
    mutate((p) => addWatermarkItem(p, { asset, atTime: 0, durationSeconds: duration }));
  };

  const handleUpload = async (file: File) => {
    const validation = validateMediaFile(file);
    if (!validation.valid) {
      setError(validation.error || 'Invalid file.');
      return;
    }
    setIsUploading(true);
    setError(null);
    try {
      const { asset } = await uploadMediaFile({ uid, file });
      placeWatermark(asset.id);
    } catch (err: any) {
      setError(err?.message || 'Watermark upload failed.');
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-bold uppercase tracking-wide text-white/50">Watermark</label>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {imageAssets.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {imageAssets.map((asset) => (
            <button
              key={asset.id}
              onClick={() => placeWatermark(asset.id)}
              className="px-2 py-1 text-[10px] bg-white/10 hover:bg-white/20 rounded text-white truncate max-w-[8rem]"
              title={`Use "${asset.fileName}" as watermark`}
            >
              {asset.fileName}
            </button>
          ))}
        </div>
      )}
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={isUploading}
        className="px-3 py-2 text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 disabled:opacity-50 rounded-lg text-white self-start"
      >
        {isUploading ? 'Uploading…' : 'Upload watermark image'}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleUpload(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}
