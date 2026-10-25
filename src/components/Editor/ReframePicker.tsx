import React, { useEffect, useRef, useState } from 'react';
import { Check, Frame, X } from 'lucide-react';
import type { CropSettings, ImageTimelineItem, MediaAsset, VideoTimelineItem } from '../../types/timeline';
import { getAssetPoster } from '../../lib/media/thumbnails';

/**
 * Reframe picker (v9) — the SPATIAL twin of the SlotTrimPicker. A preset
 * apply crops every clip to the preset's frame (a fixed-size window over
 * the source); this picker lets the user slide that window over the
 * source still — the kept region is gold-outlined, everything outside
 * is dimmed (cropped away) — and confirm a new position. Window SIZE
 * never changes here (that's the frame's aspect, set by the preset);
 * only its position does. Local state until Confirm; the caller writes
 * the crop through the normal update path (one undo step).
 */
interface ReframePickerProps {
  item: VideoTimelineItem | ImageTimelineItem;
  asset: MediaAsset;
  onConfirm: (crop: CropSettings) => void;
  onCancel: () => void;
}

export function ReframePicker({ item, asset, onConfirm, onCancel }: ReframePickerProps) {
  const crop = item.crop;
  const [pos, setPos] = useState({ x: crop?.x ?? 0, y: crop?.y ?? 0 });
  const [poster, setPoster] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number } | null>(null);

  useEffect(() => {
    let live = true;
    if (item.type === 'image') {
      setPoster(asset.storageUrl);
    } else {
      getAssetPoster(asset).then((url) => {
        if (live) setPoster(url);
      });
    }
    return () => {
      live = false;
    };
  }, [asset, item.type]);

  if (!crop) return null;
  const winW = crop.width;
  const winH = crop.height;
  const srcAspect = asset.width && asset.height ? asset.width / asset.height : 16 / 9;

  const moveTo = (clientX: number, clientY: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const cx = ((clientX - rect.left) / rect.width) * 100;
    const cy = ((clientY - rect.top) / rect.height) * 100;
    setPos({
      x: Math.min(100 - winW, Math.max(0, cx - winW / 2)),
      y: Math.min(100 - winH, Math.max(0, cy - winH / 2)),
    });
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-gold/30 bg-[#101010] p-3">
      <span className="text-[11px] font-bold uppercase tracking-wide text-gold flex items-center gap-1.5">
        <Frame size={12} /> Reframe — slide the window
      </span>
      <p className="text-[11px] text-white/50 leading-snug">
        The gold window is what survives in the preset's frame. Drag it over the part that matters — a face, the
        headline — everything outside is cropped away.
      </p>
      <div
        ref={stageRef}
        className="relative w-full overflow-hidden rounded-lg bg-black touch-none select-none"
        style={{ aspectRatio: String(srcAspect) }}
        onPointerDown={(e) => {
          dragRef.current = { pointerId: e.pointerId };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          moveTo(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (dragRef.current?.pointerId === e.pointerId) moveTo(e.clientX, e.clientY);
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      >
        {poster ? (
          <img src={poster} alt="" className="absolute inset-0 w-full h-full" draggable={false} />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-white/30">Loading still…</div>
        )}
        <div
          className="absolute border-2 border-gold rounded-sm pointer-events-none"
          style={{
            left: `${pos.x}%`,
            top: `${pos.y}%`,
            width: `${winW}%`,
            height: `${winH}%`,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
          }}
        />
      </div>
      <p className="text-[11px] text-white/40">
        Window starts at {pos.x.toFixed(0)}% across, {pos.y.toFixed(0)}% down — {winW.toFixed(0)}% × {winH.toFixed(0)}%
        of the source.
      </p>
      <div className="flex gap-1.5 justify-end">
        <button
          onClick={() => setPos({ x: (100 - winW) / 2, y: (100 - winH) / 2 })}
          className="min-h-10 px-3 text-[11px] font-bold uppercase tracking-wide text-white/60 hover:text-white"
        >
          Centre
        </button>
        <button
          onClick={onCancel}
          className="min-h-10 px-3 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-white text-[11px] font-bold flex items-center gap-1"
        >
          <X size={12} /> Cancel
        </button>
        <button
          onClick={() =>
            onConfirm({
              x: Math.round(pos.x * 100) / 100,
              y: Math.round(pos.y * 100) / 100,
              width: winW,
              height: winH,
            })
          }
          className="min-h-10 px-3 rounded-lg bg-gold hover:bg-gold-bright text-black text-[11px] font-bold flex items-center gap-1"
        >
          <Check size={12} strokeWidth={3} /> Use this frame
        </button>
      </div>
    </div>
  );
}
