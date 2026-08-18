import React, { useCallback, useRef, useState } from 'react';
import type { Project } from '../../types/timeline';
import { getProjectDuration, getItemsForTrack, moveItem, trimItemStart, trimItemEnd, splitItemAtTime } from '../../lib/timeline/utils';
import { useProject } from '../../context/ProjectContext';

interface TimelinePanelProps {
  project: Project;
  currentTime: number;
  onSeek: (time: number) => void;
  selectedItemId: string | null;
  onSelectItem: (itemId: string | null) => void;
}

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
  const dragStateRef = useRef<DragState | null>(null);
  const [, setDragTick] = useState(0); // forces a re-render on drag start/end for cursor/ring styling only
  const duration = Math.max(getProjectDuration(project), 1);

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

  const beginDrag = useCallback(
    (e: React.MouseEvent, itemId: string, mode: DragMode, originalStartTime: number, originalEndTime: number) => {
      e.preventDefault();
      e.stopPropagation();
      const rowEl = (e.currentTarget as HTMLElement).parentElement;
      const rowWidthPx = rowEl ? rowEl.getBoundingClientRect().width || 1 : 1;
      const state: DragState = {
        itemId,
        mode,
        rowWidthPx,
        pxToSecondsDuration: duration,
        originalStartTime,
        originalEndTime,
        startClientX: e.clientX,
        moved: false,
      };
      dragStateRef.current = state;
      onSelectItem(itemId);
      setDragTick((n) => n + 1);

      const handleMove = (ev: MouseEvent) => {
        const s = dragStateRef.current;
        if (!s) return;
        const deltaPx = ev.clientX - s.startClientX;
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
        const deltaSeconds = (deltaPx / s.rowWidthPx) * s.pxToSecondsDuration;
        if (s.mode === 'move') {
          mutate((p) => moveItem(p, s.itemId, s.originalStartTime + deltaSeconds));
        } else if (s.mode === 'trim-start') {
          mutate((p) => trimItemStart(p, s.itemId, s.originalStartTime + deltaSeconds));
        } else {
          mutate((p) => trimItemEnd(p, s.itemId, s.originalEndTime + deltaSeconds));
        }
      };
      const handleUp = () => {
        dragStateRef.current = null;
        setDragTick((n) => n + 1);
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleUp);
      };
      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleUp);
    },
    [duration, mutate, onSelectItem],
  );

  const sortedTracks = [...project.tracks].sort((a, b) => a.order - b.order);
  const selectedItem = selectedItemId ? project.items.find((i) => i.id === selectedItemId) : undefined;
  const canSplit = !!selectedItem && currentTime > selectedItem.startTime + 0.05 && currentTime < selectedItem.endTime - 0.05;

  return (
    <div className="flex flex-col gap-1 bg-white/5 rounded-lg p-3">
      <div className="flex items-center justify-between text-[10px] text-white/40 font-mono mb-1">
        <span>0:00</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => selectedItemId && mutate((p) => splitItemAtTime(p, selectedItemId, currentTime))}
            disabled={!canSplit}
            className={`px-2 py-0.5 rounded uppercase tracking-wide font-bold ${
              canSplit ? 'bg-white/20 hover:bg-white/30 text-white' : 'bg-white/5 text-white/20 cursor-not-allowed'
            }`}
            title={canSplit ? 'Split the selected clip at the playhead' : 'Select a clip and move the playhead inside it to split'}
          >
            Split at Playhead
          </button>
          <span>{duration.toFixed(1)}s total</span>
        </div>
      </div>
      <div className="flex gap-2 select-none">
        {/* Label column — plain vertical stack, same row height as the track-box column below so the two stay aligned. */}
        <div className="flex flex-col gap-1 shrink-0 w-16">
          {sortedTracks.map((track) => (
            <span key={track.id} className="h-6 flex items-center text-[10px] text-white/40 uppercase tracking-wide truncate">
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
            className="absolute top-0 bottom-0 w-px bg-white z-10 pointer-events-none"
            style={{ left: `${Math.min(100, (currentTime / duration) * 100)}%` }}
          />
          {sortedTracks.map((track) => {
            const items = getItemsForTrack(project, track.id);
            return (
              <div key={track.id} className="relative h-6 bg-white/5 rounded overflow-hidden">
                {items.map((item) => {
                  const left = (item.startTime / duration) * 100;
                  const width = Math.max(0.5, ((item.endTime - item.startTime) / duration) * 100);
                  const isSelected = item.id === selectedItemId;
                  const isBeingDragged = dragStateRef.current?.itemId === item.id;
                  return (
                    <div
                      key={item.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (dragStateRef.current?.moved) return; // suppress the click that follows a drag
                        onSelectItem(item.id);
                        onSeek(item.startTime);
                      }}
                      onMouseDown={(e) => beginDrag(e, item.id, 'move', item.startTime, item.endTime)}
                      title={`${item.type} — drag to move, drag edges to trim`}
                      className={`group absolute top-0.5 bottom-0.5 rounded cursor-grab active:cursor-grabbing ${TRACK_COLORS[track.type] || 'bg-white/40'} ${
                        isSelected ? 'ring-2 ring-white' : ''
                      } ${!item.visible ? 'opacity-30' : ''} ${isBeingDragged ? 'z-20' : ''}`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                    >
                      {/* Trim handles — narrow hit zones on each edge, layered above the move handler via stopPropagation. */}
                      <div
                        onMouseDown={(e) => beginDrag(e, item.id, 'trim-start', item.startTime, item.endTime)}
                        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-white/0 group-hover:bg-white/40"
                      />
                      <div
                        onMouseDown={(e) => beginDrag(e, item.id, 'trim-end', item.startTime, item.endTime)}
                        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-white/0 group-hover:bg-white/40"
                      />
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
  );
}
