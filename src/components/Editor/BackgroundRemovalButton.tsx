import React, { useState } from 'react';
import type { MediaAsset } from '../../types/timeline';
import { useProject } from '../../context/ProjectContext';
import { getBackgroundRemovalProvider } from '../../lib/backgroundRemoval';
import { uploadMediaFile } from '../../lib/media/upload';
import { addMediaAsset } from '../../lib/timeline/utils';

/**
 * Phase 1 Step 7 (Background removal) — processes an existing image
 * MediaAsset client-side and registers the result as a new MediaAsset in
 * the same project (same media/project pipeline every other asset goes
 * through — not a special one-off state). Does not block the rest of
 * Phase 1: this runs entirely client-side with no external credential, so
 * there is no "unavailable credential" path to guard here, only ordinary
 * runtime failure handling.
 */
export function BackgroundRemovalButton({ uid, asset }: { uid: string; asset: MediaAsset }) {
  const { mutate } = useProject();
  const [status, setStatus] = useState<'idle' | 'working' | 'error'>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    setStatus('working');
    setProgress(0);
    setError(null);
    try {
      const sourceRes = await fetch(asset.storageUrl);
      if (!sourceRes.ok) throw new Error(`Could not fetch source image (HTTP ${sourceRes.status}).`);
      const sourceBlob = await sourceRes.blob();

      const provider = getBackgroundRemovalProvider();
      const resultBlob = await provider.removeBackground(sourceBlob, setProgress);

      const file = new File([resultBlob], `${asset.fileName.replace(/\.[^.]+$/, '')}-no-bg.png`, { type: 'image/png' });
      const { asset: newAsset } = await uploadMediaFile({ uid, file });
      mutate((p) => addMediaAsset(p, newAsset));
      setStatus('idle');
    } catch (err: any) {
      setError(err?.message || 'Background removal failed.');
      setStatus('error');
    }
  };

  return (
    <span className="flex items-center gap-1">
      <button
        onClick={handleClick}
        disabled={status === 'working'}
        title="Remove background (adds a new image to your media library)"
        className="text-purple-400 hover:text-purple-300 font-bold disabled:opacity-40"
      >
        {status === 'working' ? `${Math.round(progress * 100)}%` : '✂'}
      </button>
      {error && (
        <span className="text-[10px] text-red-400 truncate max-w-[6rem]" title={error}>
          {error}
        </span>
      )}
    </span>
  );
}
