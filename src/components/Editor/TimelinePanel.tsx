import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import type { Project } from '../../types/timeline';
import { getProjectDuration, getItemsForTrack, moveItem, trimItemStart, trimItemEnd, splitItemAtTime, formatTimecode } from '../../lib/timeline/utils';
import { useProject } from '../../context/ProjectContext';

interface TimelinePanelProps {
  project: Project;
  currentTime: number;
  onSeek: (time: number) => void;
  selectedItemId: string | null;
  onSelectItem: (itemId: string | null) => void;
}

// "Final production fix" spec item 3c (mobile timeline behavior) — below
// this many px-per-second, clips on a narrow viewport get squeezed into
// slivers too thin to tap or drag precisely. Instead of shrinking clips to
// fit the viewport, the tracks area gets a minimum pixel width (scrolled
// horizontally via the wrapping `overflow-x-auto`) so every clip keeps a
// comfortable minimum on-screen width regardless of viewport size.
// Polish batch: that fixed floor is now a user-controlled zoom level
// (`pxPerSec` state, − / + buttons in the header). The default seeds from
// the container's fit on mount (never below the old 40px/s floor feel on
// desktop); the range is wider than a literal 2–40 because the fitted
// default on a wide monitor is already well above 40px/s — capping zoom
// at 40 would have made zoom-in a no-op there.
const DEFAULT_PX_PER_SECOND = 40;
const MIN_ZOOM_PX_PER_SECOND = 8;
const MAX_ZOOM_PX_PER_SECOND = 120;
const ZOOM_STEP = 1.25;
/** Drag/trim snapping window: an edge within this many seconds of the playhead or another clip's edge snaps onto it. */
const SNAP_WINDOW_SECONDS = 0.15;

const TRACK_COLORS: Record<string, string> = {
  video: 'bg-blue-500/70',
  image: 'bg-purple-500/70',
  text: 'bg-amber-500/70',
  caption: 'bg-pink-500/70',
  audio: 'bg-emerald-500/70',
};

type DragMode = 'move' | 'trim-start' | 'trim-end';

interface DragState {
  itemId: string;
  mode: DragMode;
  rowWidthPx: number;
  /** Timeline-total-duration used to convert drag pixels to seconds; fixed at drag start so the conversion doesn't jitter as the project's own duration shifts mid-drag. */
  pxToSecondsDuration: number;
  originalStartTime: number;
  originalEndTime: number;
  /** Snap targets captured at drag start: the playhead time plus every OTHER item's start/end edges. */
  snapPoints: number[];
  startClientX: number;
  /** Set once the drag has moved past a tiny dead-zone, so a plain click (no movement) still reaches onSelectItem/onSeek's click handler without also having dragged. */
  moved: boolean;
}

/**
 * Multi-track timeline: click-to-seek, click-a-clip-to-select, drag a clip
 * body to move it (`moveItem`), drag its left/right edge to trim
 * (`trimItemStart`/`trimItemEnd`), and a "Split at Playhead" action
 * (`splitItemAtTime`) for the selected item. All three are wired to the
 * pure Project-transform helpers in `lib/timeline/utils.ts` — this
 * component only translates pointer pixels to timeline seconds and calls
 * them, it does not keep its own parallel copy of item timing.
 */
export function TimelinePanel({ project, currentTime, onSeek, selectedItemId, onSelectItem }: TimelinePanelProps) {
  const { mutate } = useProject();
  // The track-box column (clip area only, NOT the track-name label column
  // to its left) — clip `left`/`width` percentages, the playhead line, and
  // click-to-seek all measure against THIS element's rect, so a click
  // lands exactly where it visually appears to and the playhead always
  // renders at the same pixel as the time it represents. Previously the
  // playhead was a child of the outer row container (label column +
  // clip column together), so a click at "50% across the clips" and the
  // playhead's own "50%" position disagreed by the label column's width —
  // a real, user-visible timeline misalignment, not just a click-accuracy
  // issue.
  const tracksColumnRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const [, setDragTick] = useState(0); // forces a re-render on drag start/end for cursor/ring styling only
  const duration = Math.max(getProjectDuration(project), 1);
  // Zoom: px-per-second floor for the tracks strip (see the constants
  // above). Seeded once from the container's fit so the default matches
  // the previous "fit the duration, floor of 40px/s" behavior.
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SECOND);
  const zoomTouchedRef = useRef(false);
  const [snapTime, setSnapTime] = useState<number | null>(null);
  const projectRef = useRef(project);
  projectRef.current = project;
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;

  useEffect(() => {
    if (zoomTouchedRef.current) return;
    const w = scrollContainerRef.current?.clientWidth ?? 0;
    if (w > 0 && duration > 0) {
      const fit = (w - 88) / duration; // minus label column + gaps/padding
      setPxPerSec(Math.max(MIN_ZOOM_PX_PER_SECOND, Math.min(MAX_ZOOM_PX_PER_SECOND, Math.max(DEFAULT_PX_PER_SECOND, fit))));
    }
    // Mount-only seed: after this, pxPerSec is user state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const zoomBy = useCallback((factor: number) => {
    zoomTouchedRef.current = true;
    setPxPerSec((v) => Math.max(MIN_ZOOM_PX_PER_SECOND, Math.min(MAX_ZOOM_PX_PER_SECOND, v * factor)));
  }, []);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = tracksColumnRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      onSeek(fraction * duration);
    },
    [duration, onSeek],
  );

  // "Final production fix" spec item 3b (mobile touch interaction) — same
  // approach as PreviewPane.tsx's drag handlers: the core drag logic reads
  // only (clientX, itemId, mode, ...) and is driven by a window-level
  // move/up listener pair, so a mouse call site (mousemove/mouseup) and a
  // touch call site (touchmove/touchend, reading `touches[0]`) share one
  // implementation rather than two hand-kept-in-sync copies.
  const beginDrag = useCallback(
    (
      startClientX: number,
      rowEl: HTMLElement | null,
      itemId: string,
      mode: DragMode,
      originalStartTime: number,
      originalEndTime: number,
      pointerEvents: { move: string; up: string },
    ) => {
      const rowWidthPx = rowEl ? rowEl.getBoundingClientRect().width || 1 : 1;
      const snapPoints = [
        0,
        currentTimeRef.current,
        ...projectRef.current.items.filter((i) => i.id !== itemId).flatMap((i) => [i.startTime, i.endTime]),
      ];
      const state: DragState = {
        itemId,
        mode,
        rowWidthPx,
        pxToSecondsDuration: duration,
        originalStartTime,
        originalEndTime,
        snapPoints,
        startClientX,
        moved: false,
      };
      dragStateRef.current = state;
      onSelectItem(itemId);
      setDragTick((n) => n + 1);

      const getX = (ev: MouseEvent | TouchEvent): number | null => {
        if ('touches' in ev) {
          const t = ev.touches[0] ?? ev.changedTouches[0];
          return t ? t.clientX : null;
        }
        return ev.clientX;
      };

      const handleMove = (ev: MouseEvent | TouchEvent) => {
        const s = dragStateRef.current;
        if (!s) return;
        const clientX = getX(ev);
        if (clientX === null) return;
        const deltaPx = clientX - s.startClientX;
        if (Math.abs(deltaPx) > 2) s.moved = true;
        // Below the dead-zone this is still just a click (or, on a clip whose
        // neighbor it legitimately overlaps for a transition, sub-pixel
        // pointer jitter that a real mouse click almost always produces) —
        // do NOT mutate on it. Previously any mousemove at all, even 0-2px,
        // called moveItem with its default preventOverlap:true, which
        // silently clamped the item back against its sibling and destroyed
        // an already-applied overlap-based transition just from selecting
        // (clicking) one of the two clips involved.
        if (!s.moved) return;
        if ('touches' in ev) ev.preventDefault(); // stop the page from scrolling while dragging a clip on touch
        const deltaSeconds = (deltaPx / s.rowWidthPx) * s.pxToSecondsDuration;
        // Snapping (polish batch): pull the dragged edge onto the nearest
        // snap point (playhead, or another clip's start/end) when it comes
        // within SNAP_WINDOW_SECONDS of it. For a move, EITHER edge of the
        // dragged clip can be the one that snaps — whichever lands closer.
        const snapEdge = (value: number): { value: number; point: number | null } => {
          let best: number | null = null;
          let bestDist = SNAP_WINDOW_SECONDS;
          for (const p of s.snapPoints) {
            const d = Math.abs(value - p);
            if (d <= bestDist) {
              bestDist = d;
              best = p;
            }
          }
          return best === null ? { value, point: null } : { value: best, point: best };
        };
        if (s.mode === 'move') {
          const rawStart = s.originalStartTime + deltaSeconds;
          const itemDur = s.originalEndTime - s.originalStartTime;
          const startSnap = snapEdge(rawStart);
          const endSnap = snapEdge(rawStart + itemDur);
          let newStart = rawStart;
          let snappedTo: number | null = null;
          if (startSnap.point !== null && endSnap.point !== null) {
            if (Math.abs(startSnap.value - rawStart) <= Math.abs(endSnap.value - (rawStart + itemDur))) {
              newStart = startSnap.value;
              snappedTo = startSnap.point;
            } else {
              newStart = endSnap.value - itemDur;
              snappedTo = endSnap.point;
            }
          } else if (startSnap.point !== null) {
            newStart = startSnap.value;
            snappedTo = startSnap.point;
          } else if (endSnap.point !== null) {
            newStart = endSnap.value - itemDur;
            snappedTo = endSnap.point;
          }
          setSnapTime(snappedTo);
          mutate((p) => moveItem(p, s.itemId, newStart));
        } else if (s.mode === 'trim-start') {
          const snapped = snapEdge(s.originalStartTime + deltaSeconds);
          setSnapTime(snapped.point);
          mutate((p) => trimItemStart(p, s.itemId, snapped.value));
        } else {
          const snapped = snapEdge(s.originalEndTime + deltaSeconds);
          setSnapTime(snapped.point);
          mutate((p) => trimItemEnd(p, s.itemId, snapped.value));
        }
      };
      const handleUp = () => {
        dragStateRef.current = null;
        setSnapTime(null);
        setDragTick((n) => n + 1);
        window.removeEventListener(pointerEvents.move, handleMove as EventListener);
        window.removeEventListener(pointerEvents.up, handleUp);
      };
      window.addEventListener(pointerEvents.move, handleMove as EventListener, { passive: false });
      window.addEventListener(pointerEvents.up, handleUp);
    },
    [duration, mutate, onSelectItem],
  );

  const beginMouseDrag = useCallback(
    (e: React.MouseEvent, itemId: string, mode: DragMode, originalStartTime: number, originalEndTime: number) => {
      e.preventDefault();
      e.stopPropagation();
      beginDrag(e.clientX, (e.currentTarget as HTMLElement).parentElement, itemId, mode, originalStartTime, originalEndTime, {
        move: 'mousemove',
        up: 'mouseup',
      });
    },
    [beginDrag],
  );

  const beginTouchDrag = useCallback(
    (e: React.TouchEvent, itemId: string, mode: DragMode, originalStartTime: number, originalEndTime: number) => {
      const touch = e.touches[0];
      if (!touch) return;
      e.preventDefault();
      e.stopPropagation();
      beginDrag(touch.clientX, (e.currentTarget as HTMLElement).parentElement, itemId, mode, originalStartTime, originalEndTime, {
        move: 'touchmove',
        up: 'touchend',
      });
    },
    [beginDrag],
  );

  const sortedTracks = [...project.tracks].sort((a, b) => a.order - b.order);
  const selectedItem = selectedItemId ? project.items.find((i) => i.id === selectedItemId) : undefined;
  const canSplit = !!selectedItem && currentTime > selectedItem.startTime + 0.05 && currentTime < selectedItem.endTime - 0.05;

  return (
    <div className="flex flex-col gap-1 bg-white/5 rounded-lg p-3">
      <div className="flex items-center justify-between text-[10px] text-white/40 font-mono mb-1">
        <span>{formatTimecode(currentTime)}</span>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <button
              onClick={() => zoomBy(1 / ZOOM_STEP)}
              className="min-h-11 min-w-9 flex items-center justify-center rounded bg-white/10 hover:bg-white/20 text-white"
              title="Zoom out timeline"
            >
              <ZoomOut size={14} />
            </button>
            <span className="w-14 text-center">{Math.round(pxPerSec)} px/s</span>
            <button
              onClick={() => zoomBy(ZOOM_STEP)}
              className="min-h-11 min-w-9 flex items-center justify-center rounded bg-white/10 hover:bg-white/20 text-white"
              title="Zoom in timeline"
            >
              <ZoomIn size={14} />
            </button>
          </div>
          <button
            onClick={() => selectedItemId && mutate((p) => splitItemAtTime(p, selectedItemId, currentTime))}
            disabled={!canSplit}
            className={`min-h-11 px-2 py-0.5 rounded uppercase tracking-wide font-bold ${
              canSplit ? 'bg-white/20 hover:bg-white/30 text-white' : 'bg-white/5 text-white/20 cursor-not-allowed'
            }`}
            title={canSplit ? 'Split the selected clip at the playhead' : 'Select a clip and move the playhead inside it to split'}
          >
            Split at Playhead
          </button>
          <span>{formatTimecode(duration)} total</span>
        </div>
      </div>
      {project.items.length === 0 && (
        <p className="text-[11px] text-white/35 px-0.5 pb-1">Tap Upload to add your first clip — it lands here.</p>
      )}
      {/* Horizontally scrollable on narrow viewports — the inner row gets a
          minimum pixel width (pxPerSec * duration) so clips never
          shrink below a comfortably tappable/draggable size on mobile;
          desktop viewports are normally wide enough that this min-width is
          already satisfied and no scrollbar appears. The playhead and
          click-to-seek both measure against `tracksColumnRef`'s own
          rendered width, so they stay correct at any scroll width. */}
      <div ref={scrollContainerRef} className="overflow-x-auto -mx-3 px-3 sm:mx-0 sm:px-0">
        <div className="flex gap-2 select-none" style={{ minWidth: `${Math.max(1, duration * pxPerSec)}px` }}>
          {/* Label column — plain vertical stack, same row height as the track-box column below so the two stay aligned. */}
          <div className="flex flex-col gap-1 shrink-0 w-16">
            {sortedTracks.map((track) => (
              <span
                key={track.id}
                className="h-8 sm:h-6 flex items-center text-[10px] text-white/40 uppercase tracking-wide truncate"
              >
                {track.name}
              </span>
            ))}
          </div>

          {/* Track-box column — the one true coordinate space for clip position, click-to-seek, and the playhead. */}
          <div
            ref={tracksColumnRef}
            onClick={(e) => seekFromClientX(e.clientX)}
            className="relative flex-1 flex flex-col gap-1 cursor-pointer"
          >
            <div
              className="absolute top-0 bottom-0 w-px bg-gold z-10 pointer-events-none"
              style={{ left: `${Math.min(100, (currentTime / duration) * 100)}%` }}
            />
            {snapTime !== null && (
              <div
                className="absolute top-0 bottom-0 w-px bg-gold z-20 pointer-events-none shadow-[0_0_6px_rgba(255,209,0,0.9)]"
                style={{ left: `${Math.min(100, Math.max(0, (snapTime / duration) * 100))}%` }}
              />
            )}
            {sortedTracks.map((track) => {
              const items = getItemsForTrack(project, track.id);
              return (
                <div key={track.id} className="relative h-8 sm:h-6 bg-white/5 rounded overflow-hidden">
                  {items.map((item) => {
                  const left = (item.startTime / duration) * 100;
                  const width = Math.max(0.5, ((item.endTime - item.startTime) / duration) * 100);
                  const isSelected = item.id === selectedItemId;
                  const isBeingDragged = dragStateRef.current?.itemId === item.id;
                  // Clip label: the source asset's filename for media items,
                  // the content itself for text/captions — a timeline of
                  // anonymous colored blocks is unusable once a project has
                  // more than two or three clips.
                  const clipLabel =
                    item.type === 'text'
                      ? item.text
                      : item.type === 'caption'
                        ? item.words.map((w) => w.text).join(' ') || 'Caption'
                        : (project.mediaAssets[(item as { mediaAssetId: string }).mediaAssetId]?.fileName ?? item.type);
                  // Trim grips are ALWAYS at least subtly visible (a faint
                  // grip bar on each edge) instead of hover-only — hover
                  // doesn't exist on touch, so phone users previously had
                  // no signal the edges were draggable at all. On the
                  // selected clip they go solid gold-tinted.
                  const gripClass = isSelected ? 'bg-gold/60' : 'bg-white/20 group-hover:bg-white/40';
                  const gripBarClass = isSelected ? 'bg-black/50' : 'bg-white/60';
                  return (
                    <div
                      key={item.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (dragStateRef.current?.moved) return; // suppress the click that follows a drag
                        onSelectItem(item.id);
                        onSeek(item.startTime);
                      }}
                      onMouseDown={(e) => beginMouseDrag(e, item.id, 'move', item.startTime, item.endTime)}
                      onTouchStart={(e) => beginTouchDrag(e, item.id, 'move', item.startTime, item.endTime)}
                      title={`${item.type} — drag to move, drag edges to trim`}
                      className={`group absolute top-0.5 bottom-0.5 rounded cursor-grab active:cursor-grabbing touch-none overflow-hidden ${TRACK_COLORS[track.type] || 'bg-white/40'} ${
                        isSelected ? 'ring-2 ring-gold' : ''
                      } ${!item.visible ? 'opacity-30' : ''} ${isBeingDragged ? 'z-20' : ''}`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                    >
                      <span className="absolute inset-0 flex items-center px-3 pointer-events-none overflow-hidden">
                        <span className="truncate text-[9px] font-semibold leading-none text-white/90 drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]">{clipLabel}</span>
                      </span>
                      {/* Trim handles — narrow hit zones on each edge, layered above the move handler via stopPropagation; widened from 6px to 10px so they're findable with a fingertip. */}
                      <div
                        onMouseDown={(e) => beginMouseDrag(e, item.id, 'trim-start', item.startTime, item.endTime)}
                        onTouchStart={(e) => beginTouchDrag(e, item.id, 'trim-start', item.startTime, item.endTime)}
                        className={`absolute left-0 top-0 bottom-0 w-2.5 cursor-ew-resize touch-none flex items-center justify-center ${gripClass}`}
                      >
                        <span className={`w-px h-3 pointer-events-none ${gripBarClass}`} />
                      </div>
                      <div
                        onMouseDown={(e) => beginMouseDrag(e, item.id, 'trim-end', item.startTime, item.endTime)}
                        onTouchStart={(e) => beginTouchDrag(e, item.id, 'trim-end', item.startTime, item.endTime)}
                        className={`absolute right-0 top-0 bottom-0 w-2.5 cursor-ew-resize touch-none flex items-center justify-center ${gripClass}`}
                      >
                        <span className={`w-px h-3 pointer-events-none ${gripBarClass}`} />
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {sortedTracks.length === 0 && <p className="text-xs text-white/30 py-4 text-center">No tracks yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
