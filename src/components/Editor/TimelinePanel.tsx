import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX, ZoomIn, ZoomOut } from 'lucide-react';
import type { Project, TimelineItem, Track } from '../../types/timeline';
import { moveItem, trimItemStart, trimItemEnd, splitItemAtTime, formatTimecode, updateItem } from '../../lib/timeline/utils';
import { getAssetPoster } from '../../lib/media/thumbnails';
import { useProject } from '../../context/ProjectContext';
import {
  computeDragTarget,
  createDragSession,
  createSeekThrottler,
  deriveTimelineRows,
  dragPreviewStyle,
  getGhostSplit,
  getPosterStrip,
  getProjectEndSeconds,
  getTimelineExtent,
  recordClipRowRender,
  setPosterStrip,
  type DragSession,
  type DragTarget,
  type TimelineDragMode,
} from './timelinePanelLogic';
import { PipAddButtons } from './PipAddButtons';

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
/** Scrub commits: at most one onSeek per this interval mid-scrub, plus a flush of the final value on release. */
const SCRUB_COMMIT_INTERVAL_MS = 100;

// R40 P-50c — the type coding follows the design law at the top of
// src/index.css (gold #FFD100 as the one accent, cream/white text,
// neutral surfaces; green reserved for success only): a restrained
// gold / white / neutral tint scale that still tells the types apart
// by depth. Colour is never the only signal — every clip also
// carries its type in its label and title, and every lane is named.
const TRACK_COLORS: Record<string, string> = {
  video: 'bg-gold/70',
  image: 'bg-white/50',
  text: 'bg-gold/40',
  caption: 'bg-white/35',
  audio: 'bg-neutral-400/60',
};

interface ActiveDrag {
  session: DragSession;
  clipEl: HTMLElement | null;
  lastTarget: DragTarget | null;
}

// ---------------------------------------------------------------------------
// ClipRow — one timeline clip, memoised (R26 WS-T1 (b)).
//
// Every prop is a primitive, the item object itself (identity-stable for
// items an edit didn't touch — the timeline utils only rebuild the item
// being edited), or a stable panel callback, so React.memo can bail out
// for every row a gesture/playback tick didn't actually change. The row
// render is additionally counted while the perf harness's instrumentation
// is enabled (see timelinePanelLogic), which is how the harness asserts
// exact re-render counts.
// ---------------------------------------------------------------------------

interface ClipRowProps {
  item: TimelineItem;
  trackType: Track['type'];
  /** Scrollable extent (seconds) the row's geometry is relative to. */
  extent: number;
  /** Project end (seconds) — audio past it renders ghosted (WS-A2). */
  projectEnd: number;
  selected: boolean;
  beingDragged: boolean;
  posterUrl: string | undefined;
  clipLabel: string;
  onClipClick: (item: TimelineItem) => void;
  onMouseDragStart: (e: React.MouseEvent, item: TimelineItem, mode: TimelineDragMode) => void;
  onTouchDragStart: (e: React.TouchEvent, item: TimelineItem, mode: TimelineDragMode) => void;
  onToggleMute: (item: TimelineItem) => void;
}

const ClipRow = React.memo(function ClipRow({
  item,
  trackType,
  extent,
  projectEnd,
  selected,
  beingDragged,
  posterUrl,
  clipLabel,
  onClipClick,
  onMouseDragStart,
  onTouchDragStart,
  onToggleMute,
}: ClipRowProps) {
  recordClipRowRender(item.id);
  const left = (item.startTime / extent) * 100;
  const width = Math.max(0.5, ((item.endTime - item.startTime) / extent) * 100);
  // WS-A2 ghosting: the portion of an audio item past the project end
  // line renders muted/ghosted (the stored item is untouched and the
  // overhang stays selectable/trimmable).
  const ghost = getGhostSplit(item, projectEnd);
  // Quick per-clip mute (tweaks round): video and audio items both carry
  // their own `muted`, already honored by preview + export.
  const clipMuted = item.type === 'video' || item.type === 'audio' ? item.muted : null;
  // Trim grips are ALWAYS at least subtly visible instead of hover-only —
  // hover doesn't exist on touch.
  const gripClass = selected ? 'bg-gold/60' : 'bg-white/20 group-hover:bg-white/40';
  const gripBarClass = selected ? 'bg-black/50' : 'bg-white/60';
  return (
    <div
      data-item-id={item.id}
      onClick={(e) => {
        e.stopPropagation();
        onClipClick(item);
      }}
      onMouseDown={(e) => onMouseDragStart(e, item, 'move')}
      onTouchStart={(e) => onTouchDragStart(e, item, 'move')}
      title={`${item.type} — drag to move, drag edges to trim`}
      className={`group absolute top-0.5 bottom-0.5 rounded cursor-grab active:cursor-grabbing touch-none overflow-hidden ${TRACK_COLORS[trackType] || 'bg-white/40'} ${
        selected ? 'ring-2 ring-gold' : ''
      } ${!item.visible ? 'opacity-30' : ''} ${beingDragged ? 'z-20' : ''}`}
      style={{ left: `${left}%`, width: `${width}%` }}
    >
      {posterUrl && (
        <img
          src={posterUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="absolute inset-0 w-full h-full object-cover opacity-55 pointer-events-none"
        />
      )}
      {ghost && (
        <div
          data-testid="clip-ghost"
          data-ghost-start={ghost.ghostStartTime}
          aria-hidden="true"
          className="absolute top-0 bottom-0 bg-black/60 pointer-events-none"
          style={{
            left: `${ghost.ghostOffsetFraction * 100}%`,
            right: 0,
            borderLeft: '1px dashed rgba(255,255,255,0.5)',
            backgroundImage:
              'repeating-linear-gradient(45deg, rgba(255,255,255,0.07) 0 6px, transparent 6px 12px)',
          }}
        />
      )}
      <span className="absolute inset-0 flex items-center px-3 pointer-events-none overflow-hidden">
        <span className="truncate text-[10px] font-semibold leading-none text-white/90 drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]">{clipLabel}</span>
      </span>
      {clipMuted !== null && (
        <button
          type="button"
          aria-label={clipMuted ? 'Unmute this clip' : 'Mute this clip'}
          aria-pressed={clipMuted}
          title={clipMuted ? 'Muted — tap to unmute' : 'Mute this clip’s audio'}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onToggleMute(item);
          }}
          className="absolute right-3 top-1/2 -translate-y-1/2 z-10 w-8 h-8 shrink-0 flex items-center justify-center rounded bg-black/50 hover:bg-black/75 text-white/80"
        >
          {clipMuted ? <VolumeX size={12} className="text-gold" /> : <Volume2 size={12} />}
        </button>
      )}
      {/* Trim handles — layered above the move handler via stopPropagation.
          R27 WS-M4: the hit zone is 24px wide (w-6) for touch; the VISUAL
          bar stays 10px wide (w-2.5, full height) as a centred inner span,
          so the grip looks unchanged. Drag math uses the clip's geometry
          (row width / extent in timelinePanelLogic), never the grip width. */}
      <div
        onMouseDown={(e) => onMouseDragStart(e, item, 'trim-start')}
        onTouchStart={(e) => onTouchDragStart(e, item, 'trim-start')}
        className="absolute left-0 top-0 bottom-0 w-6 cursor-ew-resize touch-none flex items-center justify-center"
      >
        <span className={`w-2.5 h-full flex items-center justify-center pointer-events-none ${gripClass}`}>
          <span className={`w-px h-3 pointer-events-none ${gripBarClass}`} />
        </span>
      </div>
      <div
        onMouseDown={(e) => onMouseDragStart(e, item, 'trim-end')}
        onTouchStart={(e) => onTouchDragStart(e, item, 'trim-end')}
        className="absolute right-0 top-0 bottom-0 w-6 cursor-ew-resize touch-none flex items-center justify-center"
      >
        <span className={`w-2.5 h-full flex items-center justify-center pointer-events-none ${gripClass}`}>
          <span className={`w-px h-3 pointer-events-none ${gripBarClass}`} />
        </span>
      </div>
    </div>
  );
});

/**
 * Multi-track timeline: click-to-seek, click-a-clip-to-select, drag a clip
 * body to move it (`moveItem`), drag its left/right edge to trim
 * (`trimItemStart`/`trimItemEnd`), and a "Cut at Playhead" action
 * (`splitItemAtTime`) for the selected item.
 *
 * R26 WS-T1 (smoothness): a drag/trim gesture no longer mutates the
 * project per pointermove. Moves only compute the target (pure math in
 * timelinePanelLogic) and write the dragged clip's transform/left/width
 * straight to its DOM element; the project commits ONCE on release.
 * Clip rows are memoised (ClipRow), the playhead is driven via a ref +
 * transform, and scrub seeks are throttled — see the perf harness in
 * timelinePerf.test.ts for the measured before/after.
 *
 * R26 WS-A2 (ghosting): the scrollable extent is
 * max(project duration, max item end), so an over-long audio item stays
 * fully reachable; a project end line marks getProjectDuration, and the
 * part of an audio item past it renders ghosted.
 * R36: the end line follows the longest-video law automatically (via
 * getProjectEndSeconds → getProjectDuration) — in a PiP-longest project
 * the line sits at the PiP's end and audio past that line ghosts.
 */
export const TimelinePanel = React.memo(function TimelinePanel({ project, currentTime, onSeek, selectedItemId, onSelectItem }: TimelinePanelProps) {
  const { mutate } = useProject();
  // The track-box column (clip area only, NOT the track-name label column
  // to its left) — clip geometry, the playhead line, and click/scrub-to-
  // seek all measure against THIS element's rect.
  const tracksColumnRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const snapLineRef = useRef<HTMLDivElement>(null);
  const timecodeRef = useRef<HTMLSpanElement>(null);
  const activeDragRef = useRef<ActiveDrag | null>(null);
  /** True once the current/last pointer gesture became a real drag — the following click must not re-seek/select. Survives drag teardown (unlike the drag state itself). */
  const dragMovedRef = useRef(false);
  const [, setDragTick] = useState(0); // re-render on drag start/end only, for cursor/ring styling
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);

  const projectEnd = getProjectEndSeconds(project);
  const extent = Math.max(getTimelineExtent(project), 1);
  const duration = Math.max(projectEnd, 1); // header readout + split maths keep project-duration semantics

  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SECOND);
  const zoomTouchedRef = useRef(false);
  const projectRef = useRef(project);
  projectRef.current = project;
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;
  const extentRef = useRef(extent);
  extentRef.current = extent;
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;

  // Filmstrip posters (polish batch 2 + R26 WS-T1 (d)): one poster per
  // video/image asset, derived once per asset and kept in the module-level
  // strip cache (timelinePanelLogic) keyed by asset id — a remounted panel
  // paints cached posters on its first render without re-requesting them.
  const [posters, setPosters] = useState<Map<string, string>>(() => {
    const initial = new Map<string, string>();
    for (const item of project.items) {
      if (item.type !== 'video' && item.type !== 'image') continue;
      const url = getPosterStrip(item.mediaAssetId);
      if (url) initial.set(item.mediaAssetId, url);
    }
    return initial;
  });
  const posterRequestedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    const wanted = new Map<string, (typeof project.mediaAssets)[string]>();
    for (const item of project.items) {
      if (item.type !== 'video' && item.type !== 'image') continue;
      const asset = project.mediaAssets[item.mediaAssetId];
      if (asset) wanted.set(asset.id, asset);
    }
    wanted.forEach((asset) => {
      const cached = getPosterStrip(asset.id);
      if (cached) {
        setPosters((prev) => (prev.get(asset.id) === cached ? prev : new Map(prev).set(asset.id, cached)));
        return;
      }
      if (posterRequestedRef.current.has(asset.id)) return;
      posterRequestedRef.current.add(asset.id);
      getAssetPoster(asset).then((url) => {
        if (!url || cancelled) return;
        setPosterStrip(asset.id, url);
        setPosters((prev) => {
          if (prev.get(asset.id) === url) return prev;
          const next = new Map(prev);
          next.set(asset.id, url);
          return next;
        });
      });
    });
    return () => {
      cancelled = true;
    };
  }, [project.items, project.mediaAssets]);

  useEffect(() => {
    if (zoomTouchedRef.current) return;
    const w = scrollContainerRef.current?.clientWidth ?? 0;
    if (w > 0) {
      const fit = (w - 88) / extentRef.current; // minus label column + gaps/padding
      setPxPerSec(Math.max(MIN_ZOOM_PX_PER_SECOND, Math.min(MAX_ZOOM_PX_PER_SECOND, Math.max(DEFAULT_PX_PER_SECOND, fit))));
    }
    // Mount-only seed: after this, pxPerSec is user state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Playhead (R26 WS-T1 (c)): driven imperatively — every currentTime /
  // extent / zoom change writes the playhead element's transform and the
  // timecode readout directly, so a playback tick never needs a
  // state-driven re-render of anything but this panel's cheap shell, and
  // memoised rows bail out entirely.
  useEffect(() => {
    const column = tracksColumnRef.current;
    const playhead = playheadRef.current;
    if (column && playhead) {
      const widthPx = column.clientWidth || 1;
      const x = Math.max(0, Math.min(1, currentTime / extent)) * widthPx;
      playhead.style.transform = `translateX(${x}px)`;
    }
    if (timecodeRef.current) {
      timecodeRef.current.textContent = formatTimecode(currentTime);
    }
  }, [currentTime, extent, pxPerSec]);

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
      onSeekRef.current(fraction * extentRef.current);
    },
    [],
  );

  // Scrub (R26 WS-T1 (c)): pointerdown on the track background starts a
  // scrub — the playhead follows the pointer via ref + transform, the
  // timecode readout updates via its ref, and onSeek commits are
  // throttled to one per SCRUB_COMMIT_INTERVAL_MS with a flush of the
  // exact final time on release. Clip mousedowns stopPropagation, so a
  // clip drag never starts a scrub.
  const beginScrub = useCallback((startClientX: number, pointerEvents: { move: string; up: string }) => {
    const column = tracksColumnRef.current;
    if (!column) return;
    const rect = column.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    const throttler = createSeekThrottler(SCRUB_COMMIT_INTERVAL_MS, (t) => onSeekRef.current(t));
    const applyScrub = (clientX: number) => {
      const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const time = fraction * extentRef.current;
      const playhead = playheadRef.current;
      if (playhead) playhead.style.transform = `translateX(${fraction * rect.width}px)`;
      if (timecodeRef.current) timecodeRef.current.textContent = formatTimecode(time);
      throttler.push(time);
      return time;
    };
    applyScrub(startClientX);
    const getX = (ev: MouseEvent | TouchEvent): number | null => {
      if ('touches' in ev) {
        const t = ev.touches[0] ?? ev.changedTouches[0];
        return t ? t.clientX : null;
      }
      return ev.clientX;
    };
    const handleMove = (ev: MouseEvent | TouchEvent) => {
      const clientX = getX(ev);
      if (clientX === null) return;
      if ('touches' in ev) ev.preventDefault();
      applyScrub(clientX);
    };
    const handleUp = (ev: MouseEvent | TouchEvent) => {
      const clientX = getX(ev);
      if (clientX !== null) applyScrub(clientX);
      throttler.flush();
      window.removeEventListener(pointerEvents.move, handleMove as EventListener);
      window.removeEventListener(pointerEvents.up, handleUp as EventListener);
    };
    window.addEventListener(pointerEvents.move, handleMove as EventListener, { passive: false });
    window.addEventListener(pointerEvents.up, handleUp as EventListener);
  }, []);

  // "Final production fix" spec item 3b (mobile touch interaction) — the
  // drag logic reads only (clientX, item, mode, ...) and is driven by a
  // window-level move/up listener pair, so mouse and touch share one
  // implementation. R26: moves write ONLY the dragged clip's DOM style
  // (transform for moves, left/width px for trims) plus the snap line's
  // style — the project mutates exactly once, on release.
  const beginDrag = useCallback(
    (
      startClientX: number,
      clipEl: HTMLElement | null,
      item: TimelineItem,
      mode: TimelineDragMode,
      pointerEvents: { move: string; up: string },
    ) => {
      const column = tracksColumnRef.current;
      const rowWidthPx = column ? column.getBoundingClientRect().width || 1 : 1;
      const snapPoints = [
        0,
        currentTimeRef.current,
        ...projectRef.current.items.filter((i) => i.id !== item.id).flatMap((i) => [i.startTime, i.endTime]),
      ];
      const session = createDragSession({
        itemId: item.id,
        mode,
        startClientX,
        rowWidthPx,
        extentSeconds: extentRef.current,
        originalStartTime: item.startTime,
        originalEndTime: item.endTime,
        snapPoints,
      });
      activeDragRef.current = { session, clipEl, lastTarget: null };
      dragMovedRef.current = false;
      onSelectItem(item.id);
      setDraggingItemId(item.id);
      setDragTick((n) => n + 1);

      const getX = (ev: MouseEvent | TouchEvent): number | null => {
        if ('touches' in ev) {
          const t = ev.touches[0] ?? ev.changedTouches[0];
          return t ? t.clientX : null;
        }
        return ev.clientX;
      };

      const handleMove = (ev: MouseEvent | TouchEvent) => {
        const active = activeDragRef.current;
        if (!active) return;
        const clientX = getX(ev);
        if (clientX === null) return;
        const target = computeDragTarget(active.session, clientX);
        // Below the dead-zone this is still just a click — do NOT preview
        // or (on release) mutate on it. (Previously any mousemove at all
        // called moveItem with preventOverlap, which silently destroyed
        // overlap-based transitions just from clicking a clip.)
        if (!target.moved) return;
        dragMovedRef.current = true;
        active.lastTarget = target;
        if ('touches' in ev) ev.preventDefault(); // stop the page scrolling while dragging on touch
        const el = active.clipEl;
        if (el) {
          const preview = dragPreviewStyle(active.session, target);
          if (preview.translateXPx !== undefined) el.style.transform = `translateX(${preview.translateXPx}px)`;
          if (preview.leftPx !== undefined) el.style.left = `${preview.leftPx}px`;
          if (preview.widthPx !== undefined) el.style.width = `${preview.widthPx}px`;
          el.style.zIndex = '20';
        }
        const snapLine = snapLineRef.current;
        if (snapLine) {
          if (target.snappedTo !== null) {
            snapLine.style.display = 'block';
            snapLine.style.left = `${Math.min(100, Math.max(0, (target.snappedTo / active.session.extentSeconds) * 100))}%`;
          } else {
            snapLine.style.display = 'none';
          }
        }
      };
      const handleUp = () => {
        const active = activeDragRef.current;
        activeDragRef.current = null;
        window.removeEventListener(pointerEvents.move, handleMove as EventListener);
        window.removeEventListener(pointerEvents.up, handleUp);
        const snapLine = snapLineRef.current;
        if (snapLine) snapLine.style.display = 'none';
        if (active) {
          const el = active.clipEl;
          if (el) {
            // Clear the imperative preview BEFORE the commit render, so
            // React's state-driven left/width take over cleanly.
            el.style.transform = '';
            el.style.left = '';
            el.style.width = '';
            el.style.zIndex = '';
          }
          const target = active.lastTarget;
          if (target && target.moved) {
            const { mode, itemId } = active.session;
            // The ONE project commit for the whole gesture.
            if (mode === 'move') mutate((p) => moveItem(p, itemId, target.startTime));
            else if (mode === 'trim-start') mutate((p) => trimItemStart(p, itemId, target.startTime));
            else mutate((p) => trimItemEnd(p, itemId, target.endTime));
          }
        }
        setDraggingItemId(null);
        setDragTick((n) => n + 1);
      };
      window.addEventListener(pointerEvents.move, handleMove as EventListener, { passive: false });
      window.addEventListener(pointerEvents.up, handleUp);
    },
    [mutate, onSelectItem],
  );

  const handleMouseDragStart = useCallback(
    (e: React.MouseEvent, item: TimelineItem, mode: TimelineDragMode) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget as HTMLElement;
      const clipEl = mode === 'move' ? target : target.parentElement;
      beginDrag(e.clientX, clipEl, item, mode, { move: 'mousemove', up: 'mouseup' });
    },
    [beginDrag],
  );

  const handleTouchDragStart = useCallback(
    (e: React.TouchEvent, item: TimelineItem, mode: TimelineDragMode) => {
      const touch = e.touches[0];
      if (!touch) return;
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget as HTMLElement;
      const clipEl = mode === 'move' ? target : target.parentElement;
      beginDrag(touch.clientX, clipEl, item, mode, { move: 'touchmove', up: 'touchend' });
    },
    [beginDrag],
  );

  const handleClipClick = useCallback(
    (item: TimelineItem) => {
      if (dragMovedRef.current) return; // suppress the click that follows a drag
      onSelectItem(item.id);
      onSeek(item.startTime);
    },
    [onSelectItem, onSeek],
  );

  const handleToggleMute = useCallback(
    (item: TimelineItem) => {
      if (item.type !== 'video' && item.type !== 'audio') return;
      mutate((p) => updateItem(p, item.id, { muted: !item.muted }));
    },
    [mutate],
  );

  // R36 WS-2 — rows are DERIVED (timelinePanelLogic.deriveTimelineRows):
  // track rows in track order with PiP / pair-second items pulled out
  // into the labelled Overlay lane group above the main video row.
  // Clips keep every interaction they had — ClipRow is unchanged and
  // drag/trim still commit through moveItem/trimItemStart/trimItemEnd,
  // which never change an item's track or pip status.
  const laneRows = deriveTimelineRows(project);
  const selectedItem = selectedItemId ? project.items.find((i) => i.id === selectedItemId) : undefined;
  const canSplit = !!selectedItem && currentTime > selectedItem.startTime + 0.05 && currentTime < selectedItem.endTime - 0.05;
  const showEndLine = projectEnd > 0 && extent - projectEnd > 0.001;

  // One clip element, shared by track rows and Overlay sub-lanes — the
  // row an item is drawn in is presentation only (see the WS-2 audit
  // in timelinePanelLogic); every prop and interaction is identical.
  const renderClip = (item: TimelineItem, trackType: Track['type']) => {
    // Clip label: the source asset's filename for media items, the
    // content itself for text/captions.
    const clipLabel =
      item.type === 'text'
        ? item.text
        : item.type === 'caption'
          ? item.words.map((w) => w.text).join(' ') || 'Caption'
          : (project.mediaAssets[(item as { mediaAssetId: string }).mediaAssetId]?.fileName ?? item.type);
    const posterUrl =
      item.type === 'video' || item.type === 'image' ? posters.get(item.mediaAssetId) : undefined;
    return (
      <ClipRow
        key={item.id}
        item={item}
        trackType={trackType}
        extent={extent}
        projectEnd={projectEnd}
        selected={item.id === selectedItemId}
        beingDragged={item.id === draggingItemId}
        posterUrl={posterUrl}
        clipLabel={clipLabel}
        onClipClick={handleClipClick}
        onMouseDragStart={handleMouseDragStart}
        onTouchDragStart={handleTouchDragStart}
        onToggleMute={handleToggleMute}
      />
    );
  };
  const trackTypeForItem = (item: TimelineItem): Track['type'] =>
    project.tracks.find((t) => t.id === item.trackId)?.type ?? 'video';

  return (
    <div className="flex flex-col gap-1 bg-white/5 rounded-lg p-3">
      <div className="flex items-center justify-between text-[10px] text-white/40 font-mono mb-1">
        <span ref={timecodeRef}>{formatTimecode(currentTime)}</span>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <button
              onClick={() => zoomBy(1 / ZOOM_STEP)}
              className="min-h-11 min-w-11 flex items-center justify-center rounded bg-white/10 hover:bg-white/20 text-white"
              title="Zoom out timeline"
            >
              <ZoomOut size={14} />
            </button>
            <span className="w-14 text-center">{Math.round(pxPerSec)} px/s</span>
            <button
              onClick={() => zoomBy(ZOOM_STEP)}
              className="min-h-11 min-w-11 flex items-center justify-center rounded bg-white/10 hover:bg-white/20 text-white"
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
            title={canSplit ? 'Cut the selected clip at the playhead' : 'Select a clip and move the playhead inside it to cut'}
          >
            Cut at Playhead
          </button>
          <span>{formatTimecode(duration)} total</span>
        </div>
      </div>
      {project.items.length === 0 && (
        <p className="text-[11px] text-white/35 px-0.5 pb-1">Tap Add Video / Image to add your first clip — it lands here.</p>
      )}
      {/* Horizontally scrollable on narrow viewports — the inner row gets a
          minimum pixel width (pxPerSec * extent) so clips never
          shrink below a comfortably tappable/draggable size on mobile;
          desktop viewports are normally wide enough that this min-width is
          already satisfied and no scrollbar appears. The extent is the
          WS-A2 scrollable extent (max item end), which can exceed the
          project duration when an audio item overhangs the main track. */}
      <div ref={scrollContainerRef} className="overflow-x-auto -mx-3 px-3 sm:mx-0 sm:px-0">
        <div className="flex gap-2 select-none" style={{ minWidth: `${Math.max(1, extent * pxPerSec)}px` }}>
          {/* Label column — plain vertical stack, same row height as the track-box column below so the two stay aligned. */}
          <div className="flex flex-col gap-1 shrink-0 w-16">
            {laneRows.map((row, rowIndex) =>
              row.kind === 'track' ? (
                <span
                  key={row.id}
                  className="h-11 lg:h-8 flex items-center text-[10px] text-white/40 uppercase tracking-wide truncate"
                >
                  {row.track.name}
                </span>
              ) : row.kind === 'overlay' ? (
                <span
                  key={row.id}
                  className="h-11 lg:h-8 flex items-center text-[10px] font-bold text-gold uppercase tracking-wide truncate"
                >
                  {rowIndex === laneRows.findIndex((r) => r.kind !== 'track') ? 'Overlay' : ''}
                </span>
              ) : (
                <span
                  key={row.id}
                  className="h-12 flex items-center text-[10px] font-bold text-gold uppercase tracking-wide truncate"
                >
                  Overlay
                </span>
              ),
            )}
          </div>

          {/* Track-box column — the one true coordinate space for clip position, scrub, and the playhead. */}
          <div
            ref={tracksColumnRef}
            onClick={(e) => seekFromClientX(e.clientX)}
            onMouseDown={(e) => {
              // Background press = scrub start (clip presses stopPropagation before reaching here).
              const targetDataset = (e.target as HTMLElement).dataset;
              if (
                e.target === e.currentTarget ||
                targetDataset?.trackRow !== undefined ||
                targetDataset?.overlayLane !== undefined
              ) {
                beginScrub(e.clientX, { move: 'mousemove', up: 'mouseup' });
              }
            }}
            className="relative flex-1 flex flex-col gap-1 cursor-pointer"
          >
            <div
              ref={playheadRef}
              data-testid="playhead"
              className="absolute top-0 bottom-0 left-0 w-px bg-gold z-10 pointer-events-none"
              style={{ transform: `translateX(0px)` }}
            />
            <div
              ref={snapLineRef}
              aria-hidden="true"
              className="absolute top-0 bottom-0 w-px bg-gold z-20 pointer-events-none shadow-[0_0_6px_rgba(255,209,0,0.9)]"
              style={{ display: 'none' }}
            />
            {showEndLine && (
              <div
                data-testid="project-end-line"
                data-end-seconds={projectEnd}
                title={`Project ends at ${formatTimecode(projectEnd)} — audio past this line is clipped at export`}
                className="absolute top-0 bottom-0 w-0.5 bg-red-400/80 z-30 pointer-events-none"
                style={{ left: `${(projectEnd / extent) * 100}%` }}
              />
            )}
            {laneRows.map((row) => {
              if (row.kind === 'overlay-empty') {
                // WS-1 + WS-2: the empty Overlay lane stays rendered
                // (slim) with the Record PiP / Upload PiP pair inline —
                // the discoverable PiP entry. The buttons dispatch the
                // PiP request events MediaImportPanel listens for.
                return (
                  <div
                    key={row.id}
                    data-overlay-lane={row.id}
                    className="relative h-12 bg-gold/5 border border-dashed border-gold/40 rounded flex items-center px-2"
                  >
                    <div className="flex-1 max-w-md">
                      <PipAddButtons />
                    </div>
                  </div>
                );
              }
              if (row.kind === 'overlay') {
                return (
                  <div
                    key={row.id}
                    data-overlay-lane={row.id}
                    className="relative h-11 lg:h-8 bg-gold/10 border-l-2 border border-gold/40 rounded overflow-hidden"
                  >
                    {row.items.map((item) => renderClip(item, trackTypeForItem(item)))}
                  </div>
                );
              }
              return (
                <div key={row.id} data-track-row={row.track.id} className="relative h-11 lg:h-8 bg-white/5 rounded overflow-hidden">
                  {row.items.map((item) => renderClip(item, row.track.type))}
                </div>
              );
            })}
            {project.tracks.length === 0 && <p className="text-xs text-white/30 py-4 text-center">No tracks yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
});
