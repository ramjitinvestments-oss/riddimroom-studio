import React, { useState } from 'react';
import type { MediaAsset } from '../../types/timeline';
import { useProject } from '../../context/ProjectContext';
import { getBackgroundRemovalProvider } from '../../lib/backgroundRemoval';
import { uploadMediaFile } from '../../lib/media/upload';
import { addMediaAsset, linkBackgroundRemovedAsset, retargetItemsToAsset } from '../../lib/timeline/utils';

/**
 * "Final production fix" spec item 4 — Original/Background-Removed toggle
 * for an image asset. Background removal itself is unchanged from the
 * original one-shot button (Phase 1 Step 7): client-side
 * `@imgly/background-removal`, no external credential, produces a real
 * alpha-channel PNG uploaded through the normal media pipeline. What's new
 * is state: once a removed-background sibling exists
 * (`asset.backgroundRemovedAssetId`, set via `linkBackgroundRemovedAsset`),
 * re-toggling never reprocesses — it just flips which asset is "selected"
 * — and selecting a variant also retargets (`retargetItemsToAsset`) any
 * timeline item already placed using this asset pair, so a watermark
 * already on the canvas updates in place rather than requiring the user to
 * delete and re-add it.
 *
 * The "which variant is selected" bit is owned by the parent
 * (`EditorShell`'s media library list), not this component, because the
 * list's own "+ Add to timeline" button for the same row needs to know it
 * too (adding should place whichever variant is currently selected, not
 * always the original) — see `EditorShell.tsx`'s `bgVariantByAssetId`
 * state.
 */
export function BackgroundRemovalButton({
  uid,
  asset,
  isRemovedSelected,
  onSelectVariant,
}: {
  uid: string;
  asset: MediaAsset;
  /** Whether the background-removed variant is currently the selected one for this row. */
  isRemovedSelected: boolean;
  /** Called with the id of the variant (original or removed) the user just selected. */
  onSelectVariant: (assetId: string) => void;
}) {
  const { project, mutate } = useProject();
  const [status, setStatus] = useState<'idle' | 'working' | 'error'>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const removedAsset = asset.backgroundRemovedAssetId ? project?.mediaAssets[asset.backgroundRemovedAssetId] : undefined;

  const selectOriginal = () => {
    if (isRemovedSelected && removedAsset) {
      mutate((p) => retargetItemsToAsset(p, removedAsset.id, asset.id));
    }
    onSelectVariant(asset.id);
  };

  const selectRemoved = async () => {
    if (removedAsset) {
      mutate((p) => retargetItemsToAsset(p, asset.id, removedAsset.id));
      onSelectVariant(removedAsset.id);
      return;
    }
    // First time selecting "Background Removed" for this asset — actually run removal.
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

      mutate((p) => {
        let next = addMediaAsset(p, newAsset);
        next = linkBackgroundRemovedAsset(next, asset.id, newAsset.id);
        next = retargetItemsToAsset(next, asset.id, newAsset.id);
        return next;
      });
      onSelectVariant(newAsset.id);
      setStatus('idle');
    } catch (err: any) {
      setError(err?.message || 'Background removal failed.');
      setStatus('error');
    }
  };

  return (
    <span className="flex items-center gap-1.5">
      <span className="flex rounded overflow-hidden border border-white/15 text-[10px] font-bold uppercase" role="group" aria-label="Background">
        <button
          onClick={selectOriginal}
          disabled={status === 'working'}
          title="Use the original image"
          className={`px-2 py-1 min-h-[24px] transition ${
            !isRemovedSelected ? 'bg-white/20 text-white' : 'text-white/40 hover:text-white/70'
          }`}
        >
          Original
        </button>
        <button
          onClick={selectRemoved}
          disabled={status === 'working'}
          title="Remove background — produces a transparent PNG; the original stays available via the Original option"
          className={`px-2 py-1 min-h-[24px] transition ${
            isRemovedSelected ? 'bg-purple-500/40 text-purple-100' : 'text-white/40 hover:text-white/70'
          }`}
        >
          {status === 'working' ? `${Math.round(progress * 100)}%` : 'Background Removed'}
        </button>
      </span>
      {error && (
        <span className="text-[10px] text-red-400 truncate max-w-[8rem]" title={error} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
