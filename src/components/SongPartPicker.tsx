import React, { useEffect, useRef, useState } from 'react';
import {
  clampWindowStart,
  formatStartTime,
  pxToSeconds,
  type SongPeaks,
} from '../lib/media/songPart';

/**
 * R26 (WS-A3) — the shared song-part picker: the track's waveform
 * with a draggable window of the clip's length over it, the detected
 * hook marked, and the start shown numerically ("starts at 0:42").
 *
 * Controlled: `value` is the effective start in seconds into the
 * source and `onChange` writes it — the parent decides what that
 * means in its own model (Promo: `musicStart`; editor: the item's
 * trim window via `editorWindowForStart`). Dragging is pointer-based:
 * the strip tracks the pointer with local state so the window moves
 * smoothly, and every move also commits the (single-number) value to
 * the parent, so what you see is always what will build.
 */
export interface SongPartPickerProps {
  /** Full source track length, seconds. */
  durationSeconds: number;
  /** Length of the clip the window must fill, seconds. */
  windowSeconds: number;
  /** Effective start, seconds into the source. */
  value: number;
  onChange: (startSeconds: number) => void;
  /** Detected hook position, seconds — drawn as a marker when given. */
  hookSeconds?: number | null;
  /** Waveform peaks for the track; null renders a flat placeholder strip. */
  peaks?: SongPeaks | null;
  disabled?: boolean;
  /** Small caption under the readout, e.g. "Auto — the hook" vs "Your pick". */
  modeLabel?: string;
}

const BAR_COUNT = 96;

export function SongPartPicker({
  durationSeconds,
  windowSeconds,
  value,
  onChange,
  hookSeconds,
  peaks,
  disabled,
  modeLabel,
}: SongPartPickerProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const shown = dragValue ?? value;
  const maxStart = Math.max(0, durationSeconds - windowSeconds);
  const leftPct = durationSeconds > 0 ? (shown / durationSeconds) * 100 : 0;
  const widthPct = durationSeconds > 0 ? Math.min(100, (windowSeconds / durationSeconds) * 100) : 100;
  const hookPct =
    hookSeconds !== null && hookSeconds !== undefined && durationSeconds > 0
      ? Math.min(100, Math.max(0, (hookSeconds / durationSeconds) * 100))
      : null;

  const bars: number[] = (() => {
    if (!peaks || peaks.peaks.length === 0) return new Array(BAR_COUNT).fill(0.25);
    const out: number[] = [];
    for (let i = 0; i < BAR_COUNT; i++) {
      const idx = Math.min(peaks.peaks.length - 1, Math.floor((i / BAR_COUNT) * peaks.peaks.length));
      out.push(Math.max(0.04, peaks.peaks[idx]));
    }
    return out;
  })();

  const startFromPointer = (clientX: number): number | null => {
    const el = stripRef.current;
    if (!el || durationSeconds <= 0) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    // Grab the window by its centre under the pointer, so a tap lands
    // the part you pointed at in the middle of the clip.
    const centerSeconds = pxToSeconds(clientX - rect.left, rect.width, durationSeconds);
    return clampWindowStart(centerSeconds - windowSeconds / 2, windowSeconds, durationSeconds);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    const start = startFromPointer(e.clientX);
    if (start === null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragValue(start);
    onChange(start);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || dragValue === null) return;
    const start = startFromPointer(e.clientX);
    if (start === null) return;
    setDragValue(start);
    onChange(start);
  };

  const endDrag = () => setDragValue(null);

  // If the parent resets the value (e.g. back to Auto) mid-idle, the
  // local drag mirror must not hold a stale position.
  useEffect(() => {
    if (dragValue === null) return;
    if (Math.abs(dragValue - value) < 0.01) setDragValue(null);
  }, [value, dragValue]);

  return (
    <div className="w-full">
      <div
        ref={stripRef}
        role="slider"
        aria-label="Song part — drag to choose which part of the track plays"
        aria-valuemin={0}
        aria-valuemax={Math.round(maxStart * 10) / 10}
        aria-valuenow={Math.round(shown * 10) / 10}
        aria-valuetext={`starts at ${formatStartTime(shown)}`}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (disabled) return;
          const step = e.shiftKey ? 1 : 0.5;
          if (e.key === 'ArrowLeft') onChange(clampWindowStart(shown - step, windowSeconds, durationSeconds));
          if (e.key === 'ArrowRight') onChange(clampWindowStart(shown + step, windowSeconds, durationSeconds));
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={`relative h-16 w-full overflow-hidden rounded-lg border border-white/10 bg-black/40 select-none ${
          disabled ? 'opacity-50' : 'cursor-grab active:cursor-grabbing touch-none'
        }`}
      >
        {/* Waveform bars */}
        <div className="absolute inset-0 flex items-center gap-[1px] px-1" aria-hidden>
          {bars.map((h, i) => (
            <div key={i} className="flex-1 rounded-sm bg-white/25" style={{ height: `${Math.round(h * 88)}%` }} />
          ))}
        </div>
        {/* Selected window */}
        <div
          className="absolute top-0 bottom-0 border-x-2 border-gold bg-gold/20"
          style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
          aria-hidden
        />
        {/* Hook marker */}
        {hookPct !== null && (
          <div className="absolute top-0 bottom-0 pointer-events-none" style={{ left: `${hookPct}%` }} aria-hidden>
            <div className="w-px h-full bg-white/80" />
            <span className="absolute top-0.5 left-1 text-[9px] font-black uppercase tracking-wide text-white/90">
              hook
            </span>
          </div>
        )}
      </div>
      <p className="text-[11px] text-white/50 mt-1.5">
        starts at <span className="text-white font-bold">{formatStartTime(shown)}</span>
        {windowSeconds > 0 && durationSeconds > 0 ? ` · plays ${formatStartTime(shown)} – ${formatStartTime(shown + windowSeconds)}` : ''}
        {modeLabel ? <span className="text-white/35"> · {modeLabel}</span> : null}
      </p>
    </div>
  );
}
