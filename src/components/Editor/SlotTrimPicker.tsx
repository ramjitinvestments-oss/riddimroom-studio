import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Crop, X } from 'lucide-react';
import type { MediaAsset, VideoTimelineItem } from '../../types/timeline';
import { formatTimecode } from '../../lib/timeline/utils';
import { clampWindowStart, itemTrimWindow, resolveSourceDuration } from '../../lib/timeline/trimWindow';
import { getAssetPoster } from '../../lib/media/thumbnails';

/**
 * Templates v3 — the crop picker. A video item keeps a source window of
 * FIXED length (its current `trimEnd - trimStart`, usually a template
 * slot's size after a full-template apply reduced it); this modal lets
 * the user choose WHICH part of the source survives by sliding that
 * window along a filmstrip of the whole source: the kept window is a
 * gold-highlighted region, everything outside it is dimmed (cropped
 * away), and a readout spells out the exact seconds kept
 * ("using 0:07.5–0:12.5 of 0:30.0").
 *
 * The preview video plays ONLY the window, looping (at the item's own
 * playback speed, so what you hear/see is the real on-timeline result).
 * Confirm reports the new window start; the caller writes
 * trimStart/trimEnd through the normal `updateItem` path (one undo
 * step). Cancel changes nothing — all state here is local until then.
 * Window clamping is the pure `lib/timeline/trimWindow.ts` math.
 */
interface SlotTrimPickerProps {
  item: VideoTimelineItem;
  asset: MediaAsset;
  onConfirm: (trimStart: number) => void;
  onCancel: () => void;
}

export function SlotTrimPicker({ item, asset, onConfirm, onCancel }: SlotTrimPickerProps) {
  const sourceDuration = resolveSourceDuration(item, asset.durationSeconds);
  const { length: windowLength } = itemTrimWindow(item);
  const [windowStart, setWindowStart] = useState(() => clampWindowStart(item.trimStart, windowLength, sourceDuration));
  const [poster, setPoster] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startAtDown: number } | null>(null);
  const windowRef = useRef({ start: windowStart, length: windowLength });
  windowRef.current = { start: windowStart, length: windowLength };

  // Filmstrip backdrop: the same per-asset poster TimelinePanel tiles
  // across its clips (best-effort — the strip still reads via its ticks
  // and dimming when no poster can be produced).
  useEffect(() => {
    let live = true;
    getAssetPoster(asset).then((url) => {
      if (live) setPoster(url);
    });
    return () => {
      live = false;
    };
  }, [asset]);

  // Preview: play only the window, looping, at the item's speed.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.playbackRate = item.speed > 0 ? item.speed : 1;
    try {
      el.currentTime = windowRef.current.start;
    } catch {
      /* not seekable yet */
    }
    el.play().catch(() => {});
    const timer = window.setInterval(() => {
      const { start, length } = windowRef.current;
      if (el.currentTime >= start + length || el.currentTime < start - 0.05) {
        try {
          el.currentTime = start;
        } catch {
          /* not seekable */
        }
        el.play().catch(() => {});
      }
    }, 40);
    return () => window.clearInterval(timer);
  }, [asset.id, item.speed]);

  // When the window slides, re-sync the preview into it immediately.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.currentTime < windowStart || el.currentTime >= windowStart + windowLength) {
      try {
        el.currentTime = windowStart;
      } catch {
        /* not seekable */
      }
    }
  }, [windowStart, windowLength]);

  /** Window start for a pointer x-position: the window centered on that point, clamped. */
  const startCenteredAt = useCallback(
    (clientX: number): number => {
      const strip = stripRef.current;
      if (!strip || sourceDuration <= 0) return windowStart;
      const rect = strip.getBoundingClientRect();
      if (rect.width <= 0) return windowStart;
      const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return clampWindowStart(fraction * sourceDuration - windowLength / 2, windowLength, sourceDuration);
    },
    [sourceDuration, windowLength, windowStart],
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const onWindow = (e.target as HTMLElement).dataset.window === 'true';
    if (onWindow) {
      dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startAtDown: windowStart };
    } else {
      // Tapping the strip outside the window jumps it there (centered
      // on the tap); the same press then continues as a drag from the
      // jumped-to position.
      const jumped = startCenteredAt(e.clientX);
      setWindowStart(jumped);
      dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startAtDown: jumped };
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const strip = stripRef.current;
    if (!strip || sourceDuration <= 0) return;
    const rect = strip.getBoundingClientRect();
    if (rect.width <= 0) return;
    const dxSeconds = ((e.clientX - drag.startX) / rect.width) * sourceDuration;
    setWindowStart(clampWindowStart(drag.startAtDown + dxSeconds, windowLength, sourceDuration));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const ticks = buildTicks(sourceDuration);
  const leftPct = sourceDuration > 0 ? (windowStart / sourceDuration) * 100 : 0;
  const widthPct = sourceDuration > 0 ? (windowLength / sourceDuration) * 100 : 100;

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4">
      <div className="bg-[#111] border border-white/10 rounded-xl p-4 w-full max-w-md flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-bold text-white uppercase tracking-wide flex items-center gap-1.5">
              <Crop size={14} className="text-gold" /> Choose what survives
            </h3>
            <p className="text-[11px] text-white/40 mt-0.5 leading-snug">
              This clip was reduced to {formatTimecode(windowLength)}. Drag the gold window to pick the part of{' '}
              <span className="text-white/70">{asset.fileName}</span> that stays — everything dimmed is cropped out. The window’s length never changes.
            </p>
          </div>
          <button onClick={onCancel} aria-label="Close" className="min-h-10 min-w-10 flex items-center justify-center rounded-lg text-white/50 hover:text-white hover:bg-white/10 shrink-0">
            <X size={16} />
          </button>
        </div>

        <video
          ref={videoRef}
          src={asset.storageUrl}
          className="w-full rounded-lg bg-black max-h-56"
          playsInline
          muted
          loop={false}
        />

        <div
          ref={stripRef}
          className="relative h-16 rounded-lg overflow-hidden bg-[#1a1a1a] border border-white/10 touch-none select-none cursor-ew-resize"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          role="slider"
          aria-label="Crop window position"
          aria-valuemin={0}
          aria-valuemax={Math.round(sourceDuration * 10) / 10}
          aria-valuenow={Math.round(windowStart * 10) / 10}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setWindowStart((s) => clampWindowStart(s - 0.25, windowLength, sourceDuration));
            if (e.key === 'ArrowRight') setWindowStart((s) => clampWindowStart(s + 0.25, windowLength, sourceDuration));
          }}
        >
          {poster && (
            <div
              className="absolute inset-0 opacity-70"
              style={{ backgroundImage: `url(${poster})`, backgroundRepeat: 'repeat-x', backgroundSize: 'auto 100%' }}
            />
          )}
          {/* Dimmed (cropped-away) regions */}
          <div className="absolute inset-y-0 left-0 bg-black/65" style={{ width: `${leftPct}%` }} />
          <div className="absolute inset-y-0 right-0 bg-black/65" style={{ width: `${100 - leftPct - widthPct}%` }} />
          {/* Kept window */}
          <div
            data-window="true"
            className="absolute inset-y-0 border-2 border-gold bg-gold/15 rounded-sm cursor-grab active:cursor-grabbing"
            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
          >
            <div className="absolute inset-y-0 left-0 w-1.5 bg-gold/70 rounded-l-sm" />
            <div className="absolute inset-y-0 right-0 w-1.5 bg-gold/70 rounded-r-sm" />
          </div>
          {/* Time ticks */}
          {ticks.map((t) => (
            <div key={t.seconds} className="absolute bottom-0 top-0 pointer-events-none" style={{ left: `${(t.seconds / sourceDuration) * 100}%` }}>
              <div className="w-px h-2 bg-white/40" />
              <span className="absolute top-2.5 left-0.5 text-[8px] font-mono text-white/60">{t.label}</span>
            </div>
          ))}
        </div>

        <p className="text-xs text-white/60 font-mono">
          using <span className="text-gold font-bold">{formatTimecode(windowStart)}–{formatTimecode(windowStart + windowLength)}</span> of {formatTimecode(sourceDuration)}
        </p>

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="min-h-11 px-3 text-xs font-bold uppercase tracking-wide bg-white/5 hover:bg-white/10 rounded-lg text-white/60"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(windowStart)}
            className="min-h-11 px-4 text-xs font-bold uppercase tracking-wide bg-gold hover:bg-gold-bright text-black rounded-lg flex items-center gap-1.5"
          >
            <Check size={14} strokeWidth={3} /> Use this part
          </button>
        </div>
      </div>
    </div>
  );
}

/** ~6 evenly spaced tick labels across the source (0, …, end). */
function buildTicks(sourceDuration: number): { seconds: number; label: string }[] {
  if (!(sourceDuration > 0)) return [];
  const step = Math.max(1, Math.ceil(sourceDuration / 6));
  const ticks: { seconds: number; label: string }[] = [];
  for (let s = 0; s < sourceDuration; s += step) {
    ticks.push({ seconds: s, label: formatTimecode(s) });
  }
  return ticks;
}
