import React, { useState } from 'react';
import { ArrowLeftRight, FlipHorizontal2, Volume2, VolumeX } from 'lucide-react';
import { useProject } from '../../context/ProjectContext';
import { addPipOverlay, isPipItem, pipScaleForWidthPercent, pipShapeRefitZoom, pipSyncNudgePatch, pipWidthPercentForScale, swapMainAndPip, PIP_LAYOUTS, PIP_SYNC_NUDGE_MAX_FRAMES, type PipLayoutId } from '../../lib/pip';
import { PipRingControls, PipShapeStrip } from './PipShapeControls';
import { framingSlackPx, pipBoxPx, resolveCropOffset, resolveCropZoom } from '../../lib/render/compositor';
import { updateItem } from '../../lib/timeline/utils';
import type { ImageTimelineItem, MediaAsset, TimelineItem, VideoTimelineItem } from '../../types/timeline';

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
  // R29 — the selected PiP's dual-camera sync nudge, in frames.
  const syncNudgeFrames = selectedPip?.pip?.syncNudgeFrames ?? 0;

  // R24 framing (Flip / crop-zoom / crop-pan): applies to the selected
  // PiP video AND to a selected image overlay — both carry the same
  // optional framing fields, and the shared compositor honours them in
  // preview and export. Pan sliders are enabled per axis exactly when
  // the cover fit has slack on that axis at the current zoom (computed
  // from the real source/box geometry, never from trim slack); when the
  // asset's dimensions are unknown the sliders stay enabled and the
  // compositor's clamping keeps the window in bounds regardless.
  const selectedImage: ImageTimelineItem | null = item && item.type === 'image' ? item : null;
  const framable: VideoTimelineItem | ImageTimelineItem | null = selectedPip ?? selectedImage;
  const patchFramable = (patch: Partial<VideoTimelineItem> & Partial<ImageTimelineItem>) => {
    if (!framable) return;
    mutate((p) => updateItem(p, framable.id, patch));
  };
  const framableAsset = framable ? project.mediaAssets[framable.mediaAssetId] : undefined;
  const srcW = framableAsset?.width ?? 0;
  const srcH = framableAsset?.height ?? 0;
  const cropZoom = resolveCropZoom(framable?.cropZoom);
  let panSlack: { x: number; y: number } | null = null;
  if (framable && srcW > 0 && srcH > 0) {
    let destW = 1;
    let destH = 1;
    if (selectedPip?.pip?.shape === 'circle') {
      destW = 1;
      destH = 1; // the circle's destination is a square
    } else if (selectedPip) {
      const box = pipBoxPx(selectedPip.scale, project.canvasWidth, project.canvasHeight, selectedPip.pip, srcW, srcH);
      destW = box.w;
      destH = box.h;
    } else {
      // Image: the box follows the crop window's (or the image's own)
      // aspect — only the aspect matters for slack.
      const c = framable.crop;
      const aspect = c && c.width > 0 && c.height > 0 ? ((c.height / 100) * srcH) / ((c.width / 100) * srcW) : srcH / srcW;
      destW = 100;
      destH = 100 * aspect;
    }
    panSlack = framingSlackPx(srcW, srcH, destW, destH, framable.crop, cropZoom);
  }
  const canPanX = panSlack ? panSlack.x > 0.5 : true;
  const canPanY = panSlack ? panSlack.y > 0.5 : true;
  const framingModified = !!framable && (cropZoom !== 1 || resolveCropOffset(framable.cropOffsetX) !== 0 || resolveCropOffset(framable.cropOffsetY) !== 0);

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
      <h3 className="text-[11px] font-bold uppercase tracking-wide text-white/50">Picture in picture (PiP)</h3>
      <p className="text-[11px] text-white/40">Talking-head / explainer: overlay a video on top of your main video. Drag + resize on canvas.</p>
      {pipCount > 0 && <p className="text-[11px] text-emerald-400">{pipCount} overlay{pipCount === 1 ? '' : 's'} on timeline</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
      <label className="flex flex-col gap-1 text-xs text-white/60">
        Layout
        <select value={layoutId} onChange={(e) => setLayoutId(e.target.value as PipLayoutId)} className="bg-white/10 rounded px-2 py-2 text-white text-base min-h-11">
          {PIP_LAYOUTS.map((l) => (<option key={l.id} value={l.id}>{l.label}</option>))}
        </select>
      </label>
      {videoAssets.length === 0 && <p className="text-xs text-white/30">Upload or record a video first, then add it as an overlay.</p>}
      <ul className="flex flex-col gap-1">
        {videoAssets.map((asset) => (
          <li key={asset.id} className="flex items-center gap-2 bg-white/5 rounded px-2 py-1.5 text-xs">
            <span className="flex-1 truncate">{asset.fileName}</span>
            <button onClick={() => handleAdd(asset)} className="px-2 py-1 text-[10px] font-bold uppercase bg-white/10 hover:bg-white/20 rounded text-white min-h-11 inline-flex items-center">+ Add as PiP</button>
          </li>
        ))}
      </ul>

      {/* Overlay size + swap — for the selected PiP video. Size writes the
          item's scale (video fills the canvas at scale 1, so scale IS the
          width %); both render paths and the canvas drag handles read the
          same field. Swap trades roles with the main video in one mutate
          (one undo step); each clip keeps its own timing/trim/audio. */}
      {selectedPip && (
        <div className="flex flex-col gap-2 border-t border-white/10 pt-2">
          <span className="font-bold uppercase tracking-wide text-white/40 text-xs">Overlay size</span>
          <div className="flex items-center gap-2 text-xs text-white/60">
            <label className="flex flex-col gap-1 flex-1">
              Width ({pipWidthPercentForScale(selectedPip.scale)}% of screen)
              <input
                type="range"
                min={10}
                max={80}
                step={1}
                value={pipWidthPercentForScale(selectedPip.scale)}
                onChange={(e) => patchSelectedPip({ scale: pipScaleForWidthPercent(Number(e.target.value)) })}
              />
            </label>
            <div className="flex gap-1">
              {([['S', 20], ['M', 32], ['L', 50]] as const).map(([label, pct]) => (
                <button
                  key={label}
                  onClick={() => patchSelectedPip({ scale: pipScaleForWidthPercent(pct) })}
                  className="px-2 py-1 text-[10px] font-bold uppercase bg-white/10 hover:bg-white/20 rounded text-white min-h-11 inline-flex items-center justify-center"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={() => mutate((p) => swapMainAndPip(p, selectedPip.id))}
            className="flex items-center justify-center gap-2 px-3 py-2 bg-gold/15 hover:bg-gold/25 border border-gold/60 text-gold rounded-lg text-xs font-bold uppercase min-h-11"
          >
            <ArrowLeftRight size={13} /> Swap main ↔ overlay
          </button>
          <p className="text-[10px] text-white/30 -mt-1">The overlay becomes the full-screen main video; the main video takes its place in the circle. Timing, trim and each clip's own sound stay with the clip.</p>
          {/* R29 — dual-camera sync nudge: shift the overlay a frame at
              a time against the main clip until lips and sound line up. */}
          <span className="font-bold uppercase tracking-wide text-white/40 text-xs">Line up the sound</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => patchSelectedPip(pipSyncNudgePatch(selectedPip, -1, project.frameRate))}
              className="px-2 py-1 text-[10px] font-bold uppercase bg-white/10 hover:bg-white/20 rounded text-white min-h-11 inline-flex items-center justify-center"
            >
              − 1 frame
            </button>
            <button
              onClick={() => patchSelectedPip(pipSyncNudgePatch(selectedPip, 1, project.frameRate))}
              className="px-2 py-1 text-[10px] font-bold uppercase bg-white/10 hover:bg-white/20 rounded text-white min-h-11 inline-flex items-center justify-center"
            >
              + 1 frame
            </button>
            <span className="text-xs text-white/60">
              {syncNudgeFrames === 0
                ? 'In sync'
                : `${syncNudgeFrames > 0 ? '+' : ''}${syncNudgeFrames} frame${Math.abs(syncNudgeFrames) === 1 ? '' : 's'}`}
            </span>
          </div>
          <p className="text-[10px] text-white/30 -mt-1">Dual-camera recordings can land a few frames off. If the overlay's lips move before you hear the words, tap +; after the words, tap −. Up to {PIP_SYNC_NUDGE_MAX_FRAMES} frames each way.</p>
        </div>
      )}

      {/* R24 Framing — Flip / shape / crop-zoom / crop-pan for the
          selected PiP video or image overlay. Every control writes the
          item's own framing fields; the shared compositor applies them
          identically in preview and export. Zoom is the SOURCE crop
          window (1× = today's cover fit), separate from Width above,
          which sizes the on-screen box. */}
      {framable && (
        <div className="flex flex-col gap-2 border-t border-white/10 pt-2">
          <span className="font-bold uppercase tracking-wide text-white/40 text-xs">Framing</span>
          <button
            onClick={() => patchFramable({ flipX: framable.flipX !== true })}
            aria-pressed={framable.flipX === true}
            className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-bold uppercase min-h-11 border ${
              framable.flipX === true
                ? 'bg-gold/15 hover:bg-gold/25 border-gold/60 text-gold'
                : 'bg-white/10 hover:bg-white/20 border-white/10 text-white'
            }`}
          >
            <FlipHorizontal2 size={13} /> Flip horizontally {framable.flipX === true ? '· On' : ''}
          </button>
          {selectedPip?.pip && (
            <>
              {/* R25 — the nine premium shapes as live thumbnail chips.
                  Changing shape also re-fits the crop-zoom by the new
                  shape's safe factor (pipShapeRefitZoom): pointed/lobed
                  shapes relax a deep zoom so the subject is not left
                  clipped; zoom/pan stay the user's to re-set after. */}
              <PipShapeStrip
                value={selectedPip.pip.shape}
                onChange={(shape) =>
                  patchFramable({
                    pip: { ...selectedPip.pip!, shape },
                    cropZoom: pipShapeRefitZoom(cropZoom, shape),
                  })
                }
              />
              <PipRingControls
                pip={selectedPip.pip}
                onPatch={(p) => patchSelectedPip({ pip: { ...selectedPip.pip!, ...p } })}
              />
              {selectedPip.pip.fit === 'source' && selectedPip.pip.shape !== 'circle' && (
                <p className="text-[10px] text-white/30 -mt-1">Camera framing: the whole recording is shown (head-and-shoulders). The Circle shape crops to a square, as before.</p>
              )}
            </>
          )}
          <label className="flex flex-col gap-1 text-xs text-white/60">
            Zoom ({cropZoom.toFixed(2)}×)
            <input
              type="range"
              min={1}
              max={3}
              step={0.05}
              value={cropZoom}
              onChange={(e) => patchFramable({ cropZoom: Number(e.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-white/60">
            Pan left / right ({Math.round(resolveCropOffset(framable.cropOffsetX) * 100)}%)
            <input
              type="range"
              min={-100}
              max={100}
              step={1}
              value={Math.round(resolveCropOffset(framable.cropOffsetX) * 100)}
              disabled={!canPanX}
              onChange={(e) => patchFramable({ cropOffsetX: Number(e.target.value) / 100 })}
              className="disabled:opacity-30"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-white/60">
            Pan up / down ({Math.round(resolveCropOffset(framable.cropOffsetY) * 100)}%)
            <input
              type="range"
              min={-100}
              max={100}
              step={1}
              value={Math.round(resolveCropOffset(framable.cropOffsetY) * 100)}
              disabled={!canPanY}
              onChange={(e) => patchFramable({ cropOffsetY: Number(e.target.value) / 100 })}
              className="disabled:opacity-30"
            />
          </label>
          {!canPanX && !canPanY && cropZoom === 1 && (
            <p className="text-[10px] text-white/30 -mt-1">The frame fills the box exactly at 1× — zoom in to pan, or the box already shows the whole width/height.</p>
          )}
          {framingModified && (
            <button
              onClick={() => patchFramable({ cropZoom: 1, cropOffsetX: 0, cropOffsetY: 0 })}
              className="self-start px-2 py-1 text-[10px] font-bold uppercase bg-white/10 hover:bg-white/20 rounded text-white min-h-11 inline-flex items-center"
            >
              Reset zoom &amp; pan
            </button>
          )}
        </div>
      )}

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
