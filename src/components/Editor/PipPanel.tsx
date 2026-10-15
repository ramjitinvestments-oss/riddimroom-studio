import React, { useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { useProject } from '../../context/ProjectContext';
import { addPipOverlay, isPipItem, PIP_LAYOUTS, type PipLayoutId } from '../../lib/pip';
import { updateItem } from '../../lib/timeline/utils';
import type { MediaAsset, TimelineItem, VideoTimelineItem } from '../../types/timeline';

/**
 * v1 PiP panel — talking-head / explainer overlays.
 * One tap: pick a video from the library, pick a layout, it drops in as a
 * PiP overlay (circled/rounded, on top). Drag/resize on canvas to fine-tune.
 * Screen recording is NOT here (deferred) — this is overlay only.
 *
 * Overlay audio: an overlay video carries its OWN volume/mute, independent
 * of the main clip — preview and export both mix it with those settings.
 * Uploaded overlays start muted (the main video stays primary); camera
 * talking-head takes start with sound on. When a PiP video clip is
 * selected, its controls live right here under "Overlay audio" (the
 * inspector shows the same fields, and the timeline clip has a quick-mute
 * button).
 */
export function PipPanel({ item }: { item?: TimelineItem | null }) {
  const { project, mutate } = useProject();
  const [layoutId, setLayoutId] = useState<PipLayoutId>('bottom-right');
  const [error, setError] = useState<string | null>(null);

  if (!project) return null;
  const videoAssets: MediaAsset[] = Object.values(project.mediaAssets).filter((a) => a.kind === 'video');
  const pipCount = project.items.filter((i) => isPipItem(i)).length;

  // The selected overlay's audio controls apply only when the selection
  // IS a PiP video item — image overlays have no audio to control.
  const selectedPip: VideoTimelineItem | null =
    item && item.type === 'video' && isPipItem(item) ? item : null;
  const patchSelectedPip = (patch: Partial<VideoTimelineItem>) => {
    if (!selectedPip) return;
    mutate((p) => updateItem(p, selectedPip.id, patch));
  };

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

      {/* Overlay audio — the selected PiP video's own volume/mute, the
          same fields the inspector edits and both render paths honor.
          Only rendered for a selected PiP *video*; image overlays have
          no audio section anywhere, by design. */}
      {selectedPip ? (
        <div className="flex flex-col gap-2 border-t border-white/10 pt-2">
          <span className="font-bold uppercase tracking-wide text-white/40 text-xs flex items-center gap-1.5">
            {selectedPip.muted ? <VolumeX size={13} className="text-gold" /> : <Volume2 size={13} />} Overlay audio
          </span>
          <p className="text-[11px] text-white/35 -mt-1">This overlay clip’s own sound only — separate from the main video’s audio. Raise it to hear a talking head over the main clip.</p>
          <div className="flex items-center gap-2 text-xs text-white/60">
            <label className="flex flex-col gap-1 flex-1">
              Volume ({Math.round(selectedPip.volume * 100)}%)
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={selectedPip.volume}
                onChange={(e) => patchSelectedPip({ volume: Number(e.target.value) })}
              />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={selectedPip.muted} onChange={(e) => patchSelectedPip({ muted: e.target.checked })} />
              Mute
            </label>
          </div>
        </div>
      ) : (
        pipCount > 0 && (
          <p className="text-[10px] text-white/30">Select a PiP clip on the timeline to set its volume here — each overlay has its own sound level. Uploaded overlays start muted; camera overlays start with sound on.</p>
        )
      )}
      <p className="text-[10px] text-white/30">Tip: overlays keep their own volume in preview and export — set it under Overlay audio above, in the inspector, or with the mute button on the timeline clip.</p>
    </div>
  );
}
