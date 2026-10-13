import React, { useState } from 'react';
import { useProject } from '../../context/ProjectContext';
import { addPipOverlay, PIP_LAYOUTS, type PipLayoutId } from '../../lib/pip';
import type { MediaAsset } from '../../types/timeline';

/**
 * v1 PiP panel — talking-head / explainer overlays.
 * One tap: pick a video from the library, pick a layout, it drops in as a
 * PiP overlay (muted, circled/rounded, on top). Drag/resize on canvas to fine-tune.
 * Screen recording is NOT here (deferred) — this is overlay only.
 */
export function PipPanel() {
  const { project, mutate } = useProject();
  const [layoutId, setLayoutId] = useState<PipLayoutId>('bottom-right');
  const [error, setError] = useState<string | null>(null);

  if (!project) return null;
  const videoAssets: MediaAsset[] = Object.values(project.mediaAssets).filter((a) => a.kind === 'video');
  const pipCount = project.items.filter((i) => i.type === 'video' && (i as { pip?: { isPip?: boolean } }).pip?.isPip).length;

  const handleAdd = (asset: MediaAsset) => {
    setError(null);
    try {
      mutate((p) => addPipOverlay(p, asset, { layoutId }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not add PiP overlay.');
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-bold uppercase tracking-wide text-white/50">Video overlay (PiP)</h3>
      <p className="text-[11px] text-white/40">Talking-head / explainer: overlay a video on top of your main video. Drag + resize on canvas.</p>
      {pipCount > 0 && <p className="text-[11px] text-emerald-400">{pipCount} overlay{pipCount === 1 ? '' : 's'} on timeline</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
      <label className="flex flex-col gap-1 text-xs text-white/60">
        Layout
        <select value={layoutId} onChange={(e) => setLayoutId(e.target.value as PipLayoutId)} className="bg-white/10 rounded px-2 py-2 text-white min-h-11">
          {PIP_LAYOUTS.map((l) => (<option key={l.id} value={l.id}>{l.label}</option>))}
        </select>
      </label>
      {videoAssets.length === 0 && <p className="text-xs text-white/30">Upload or record a video first, then add it as an overlay.</p>}
      <ul className="flex flex-col gap-1">
        {videoAssets.map((asset) => (
          <li key={asset.id} className="flex items-center gap-2 bg-white/5 rounded px-2 py-1.5 text-xs">
            <span className="flex-1 truncate">{asset.fileName}</span>
            <button onClick={() => handleAdd(asset)} className="px-2 py-1 text-[10px] font-bold uppercase bg-white/10 hover:bg-white/20 rounded text-white min-h-9">+ Add as PiP</button>
          </li>
        ))}
      </ul>
      <p className="text-[10px] text-white/30">Tip: PiP audio is muted by default. Select the PiP clip → unmute in the inspector if you want to hear it.</p>
    </div>
  );
}
