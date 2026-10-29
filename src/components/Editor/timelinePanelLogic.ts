/**
 * R26 WS-T1 / WS-A2 — pure, framework-free helpers extracted from
 * TimelinePanel so the panel's gesture math, timeline extent, ghost
 * split, seek throttling and poster-strip cache can be unit-tested (and
 * perf-measured) without a DOM. TimelinePanel is the only production
 * consumer; everything here is deterministic given its inputs.
 */
import type { Project, TimelineItem, Track } from '../../types/timeline';
import { getItemsForTrack, getMaxItemEnd, getProjectDuration } from '../../lib/timeline/utils';
import { isPipItem } from '../../lib/pip';

// ---------------------------------------------------------------------------
// WS-A2 — extent, project end line, ghost split
// ---------------------------------------------------------------------------

/**
 * Scrollable timeline extent (seconds): the ruler/scroll area must reach
 * the farthest item end even when that item (an over-long song) extends
 * past the project duration (R36: the longest-video law's duration).
 * `max(getProjectDuration, getMaxItemEnd)` — for ordinary projects the
 * two are equal and nothing changes.
 */
export function getTimelineExtent(project: Project): number {
  return Math.max(getProjectDuration(project), getMaxItemEnd(project));
}

/**
 * The project end (seconds) — where the visible end line is drawn.
 * R36: this follows the new law automatically (it is
 * `getProjectDuration`), so in a PiP-longest project the end line sits
 * at the PiP's end and only audio past THAT line ghosts.
 */
export function getProjectEndSeconds(project: Project): number {
  return getProjectDuration(project);
}

export interface GhostSplit {
  /** Absolute time where the ghosted portion starts (= project end, clamped into the item). */
  ghostStartTime: number;
  /** Offset of the ghost start within the item, 0..1 (0 = item fully ghosted). */
  ghostOffsetFraction: number;
  /** True when the item starts at/after the project end (nothing solid). */
  fullyGhosted: boolean;
}

/**
 * The ghosted portion of an AUDIO item past the project end line, or
 * null when the item doesn't cross it. Only audio items ghost: the
 * stored item keeps its full length (WS-A2 is non-destructive), the
 * timeline just renders the overhang muted so the user can still scroll
 * to it, select it and trim it back.
 */
export function getGhostSplit(item: TimelineItem, projectEndSeconds: number): GhostSplit | null {
  if (item.type !== 'audio') return null;
  if (!(projectEndSeconds > 0)) return null;
  if (item.endTime <= projectEndSeconds) return null;
  const duration = item.endTime - item.startTime;
  if (!(duration > 0)) return null;
  const ghostStartTime = Math.max(item.startTime, projectEndSeconds);
  return {
    ghostStartTime,
    ghostOffsetFraction: (ghostStartTime - item.startTime) / duration,
    fullyGhosted: ghostStartTime <= item.startTime,
  };
}

// ---------------------------------------------------------------------------
// R36 WS-2 — the PiP "Overlay" lane (presentation + placement only)
//
// AUDIT CONCLUSION (what the model does today, verified 2026-10-29):
// tracks are typed ('video' | 'image' | 'text' | 'caption' | 'audio')
// and there is exactly ONE video track. A PiP is a VIDEO item with
// `pip.isPip` set (lib/pip's addPipOverlay / isPipItem) sitting on that
// same video track — the model has NO separate overlay track. A pair's
// second item (R32 PairSettings, role 'second') likewise sits on its
// ordinary track — the video track for a split tile or a camera PiP,
// the image track for an imported image second. Before R36 the
// timeline rendered one row per track, so PiPs and pair seconds were
// drawn inside the main video row (or the image row), interleaved
// with main clips.
//
// WHAT R36 CHANGED (this section + TimelinePanel's row rendering
// only): the timeline now DERIVES a dedicated, labelled "Overlay"
// lane group, presented above the main video row. Every PiP item and
// every pair-second item is pulled out of its track row into the
// Overlay group; overlapping overlay items stack as packed sub-lanes
// (see packOverlaySubLanes). This is a pure derivation over the
// existing model — no item's trackId, pip or pair fields are read
// differently anywhere else, dragging still commits through the same
// moveItem/trim helpers (which never touch trackId or pip), and the
// compositor still draws by item geometry (position/scale/frameRect/
// zIndex), never by lane — so preview = export is preserved by
// construction. An empty Overlay group still yields one slim
// 'overlay-empty' row so the lane (and its Record PiP / Upload PiP
// entry) is always discoverable.
// ---------------------------------------------------------------------------

/**
 * True when an item belongs in the Overlay lane: a PiP item, or the
 * SECOND item of a pair (pair.role === 'second', video or image).
 * A pair's MAIN item is not an overlay — it stays in its track row.
 */
export function isOverlayLaneItem(item: TimelineItem): boolean {
  if (isPipItem(item)) return true;
  return (item.type === 'video' || item.type === 'image') && item.pair?.role === 'second';
}

export interface OverlaySubLane {
  /** Stable row id: 'overlay-0', 'overlay-1', … in packing order. */
  id: string;
  /** Items in this sub-lane, in start-time order, never overlapping. */
  items: TimelineItem[];
}

/**
 * Pack overlay items into sub-lanes: items are ordered by start time
 * (ties: earlier end, then higher zIndex, then id, so the order is
 * fully deterministic), and each item joins the FIRST sub-lane whose
 * last item ends at or before it starts — non-overlapping PiPs share
 * a sub-lane; overlapping PiPs stack in separate sub-lanes.
 */
export function packOverlaySubLanes(items: TimelineItem[]): OverlaySubLane[] {
  const sorted = [...items].sort(
    (a, b) =>
      a.startTime - b.startTime || a.endTime - b.endTime || b.zIndex - a.zIndex || a.id.localeCompare(b.id),
  );
  const lanes: TimelineItem[][] = [];
  for (const item of sorted) {
    const lane = lanes.find((l) => l[l.length - 1].endTime <= item.startTime);
    if (lane) lane.push(item);
    else lanes.push([item]);
  }
  return lanes.map((laneItems, i) => ({ id: `overlay-${i}`, items: laneItems }));
}

/** One row of the timeline as TimelinePanel renders it, top to bottom. */
export type TimelineLaneRow =
  | { kind: 'overlay'; id: string; items: TimelineItem[] }
  | { kind: 'overlay-empty'; id: 'overlay-empty'; items: TimelineItem[] }
  | { kind: 'track'; id: string; track: Track; items: TimelineItem[] };

/**
 * Derive the timeline's rows from a project: one row per track (in
 * track order) with overlay items REMOVED from their track rows, and
 * the Overlay lane group (packed sub-lanes, or one empty row)
 * inserted immediately above the first video track's row — above the
 * main video row. With no video track the group goes first. Every
 * project item appears in exactly one row.
 */
export function deriveTimelineRows(project: Project): TimelineLaneRow[] {
  const tracks = [...project.tracks].sort((a, b) => a.order - b.order);
  const overlayItems = project.items.filter(isOverlayLaneItem);
  const subLanes = packOverlaySubLanes(overlayItems);
  const overlayRows: TimelineLaneRow[] =
    subLanes.length > 0
      ? subLanes.map((lane) => ({ kind: 'overlay' as const, id: lane.id, items: lane.items }))
      : [{ kind: 'overlay-empty' as const, id: 'overlay-empty' as const, items: [] }];

  const rows: TimelineLaneRow[] = [];
  let overlayInserted = false;
  for (const track of tracks) {
    if (!overlayInserted && track.type === 'video') {
      rows.push(...overlayRows);
      overlayInserted = true;
    }
    rows.push({
      kind: 'track',
      id: track.id,
      track,
      items: getItemsForTrack(project, track.id).filter((i) => !isOverlayLaneItem(i)),
    });
  }
  if (!overlayInserted) rows.unshift(...overlayRows);
  return rows;
}

// ---------------------------------------------------------------------------
// Drag / trim gesture math (extracted verbatim from TimelinePanel's
// original inline handleMove, including its snap rules)
// ---------------------------------------------------------------------------

export const DRAG_DEADZONE_PX = 2;
export const SNAP_WINDOW_SECONDS = 0.15;

export type TimelineDragMode = 'move' | 'trim-start' | 'trim-end';

export interface DragSession {
  itemId: string;
  mode: TimelineDragMode;
  startClientX: number;
  /** Width of the timeline coordinate space in px, fixed at drag start. */
  rowWidthPx: number;
  /** Extent (seconds) the row width represents, fixed at drag start so px→s conversion doesn't jitter mid-drag. */
  extentSeconds: number;
  originalStartTime: number;
  originalEndTime: number;
  /** Playhead time + every other item's start/end edges, captured at drag start. */
  snapPoints: number[];
}

export function createDragSession(input: DragSession): DragSession {
  return { ...input };
}

export interface DragTarget {
  startTime: number;
  endTime: number;
  /** The snap point the dragged edge landed on, or null when unsnapped. */
  snappedTo: number | null;
  /** True once the pointer has moved past the dead-zone (a real drag, not a click). */
  moved: boolean;
  deltaPx: number;
  deltaSeconds: number;
}

function snapEdge(value: number, snapPoints: number[]): { value: number; point: number | null } {
  let best: number | null = null;
  let bestDist = SNAP_WINDOW_SECONDS;
  for (const p of snapPoints) {
    const d = Math.abs(value - p);
    if (d <= bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best === null ? { value, point: null } : { value: best, point: best };
}

/** The item's would-be [start,end] for a pointer at `clientX` in this session. */
export function computeDragTarget(session: DragSession, clientX: number): DragTarget {
  const deltaPx = clientX - session.startClientX;
  const moved = Math.abs(deltaPx) > DRAG_DEADZONE_PX;
  const deltaSeconds = (deltaPx / (session.rowWidthPx || 1)) * session.extentSeconds;
  const { originalStartTime: oS, originalEndTime: oE, mode } = session;
  if (mode === 'move') {
    const rawStart = oS + deltaSeconds;
    const itemDur = oE - oS;
    const startSnap = snapEdge(rawStart, session.snapPoints);
    const endSnap = snapEdge(rawStart + itemDur, session.snapPoints);
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
    return { startTime: newStart, endTime: newStart + itemDur, snappedTo, moved, deltaPx, deltaSeconds };
  }
  if (mode === 'trim-start') {
    const snapped = snapEdge(oS + deltaSeconds, session.snapPoints);
    return { startTime: snapped.value, endTime: oE, snappedTo: snapped.point, moved, deltaPx, deltaSeconds };
  }
  const snapped = snapEdge(oE + deltaSeconds, session.snapPoints);
  return { startTime: oS, endTime: snapped.value, snappedTo: snapped.point, moved, deltaPx, deltaSeconds };
}

export interface DragPreviewStyle {
  /** translateX in px for a body move (transform-only, no layout). */
  translateXPx?: number;
  /** Absolute left in px within the track row (trim-start only). */
  leftPx?: number;
  /** Width in px (both trims). */
  widthPx?: number;
}

/**
 * Imperative preview geometry for the dragged clip during a gesture —
 * what the panel writes straight to the clip element's style so no React
 * render (and no project mutation) happens per pointermove. The commit
 * on release uses computeDragTarget's times through the usual utils.
 */
export function dragPreviewStyle(session: DragSession, target: DragTarget): DragPreviewStyle {
  const pxPerSecond = (session.rowWidthPx || 1) / (session.extentSeconds || 1);
  const originalLeftPx = session.originalStartTime * pxPerSecond;
  const originalWidthPx = (session.originalEndTime - session.originalStartTime) * pxPerSecond;
  if (session.mode === 'move') {
    return { translateXPx: (target.startTime - session.originalStartTime) * pxPerSecond };
  }
  if (session.mode === 'trim-start') {
    const leftPx = target.startTime * pxPerSecond;
    return { leftPx, widthPx: originalLeftPx + originalWidthPx - leftPx };
  }
  return { widthPx: (target.endTime - session.originalStartTime) * pxPerSecond };
}

// ---------------------------------------------------------------------------
// Scrub seek throttling — commit time state at most once per interval
// during a scrub drag, always flush the final value on release.
// ---------------------------------------------------------------------------

export interface SeekThrottler {
  push: (time: number) => void;
  flush: () => void;
  cancel: () => void;
}

export function createSeekThrottler(intervalMs: number, commit: (time: number) => void): SeekThrottler {
  let lastCommitAt = Number.NEGATIVE_INFINITY;
  let pending: number | null = null;
  return {
    push(time: number) {
      const now = Date.now();
      if (now - lastCommitAt >= intervalMs) {
        lastCommitAt = now;
        pending = null;
        commit(time);
      } else {
        pending = time;
      }
    },
    flush() {
      if (pending !== null) {
        lastCommitAt = Date.now();
        const value = pending;
        pending = null;
        commit(value);
      }
    },
    cancel() {
      pending = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Per-asset poster strip cache (WS-T1 (d)) — module-level, keyed by asset
// id, so a remounted panel paints already-derived posters synchronously
// on its first render and never re-requests them. (The underlying
// generation in lib/media/thumbnails has its own session cache too; this
// is the panel-side strip cache the task asks for.)
// ---------------------------------------------------------------------------

const posterStripCache = new Map<string, string>();

export function getPosterStrip(assetId: string): string | undefined {
  return posterStripCache.get(assetId);
}

export function setPosterStrip(assetId: string, url: string): void {
  posterStripCache.set(assetId, url);
}

export function clearPosterStripCache(): void {
  posterStripCache.clear();
}

// ---------------------------------------------------------------------------
// Test instrumentation — counts ClipRow renders while enabled. Off by
// default; the perf harness turns it on to assert exact re-render counts.
// ---------------------------------------------------------------------------

let perfEnabled = false;
const rowRenderCounts = new Map<string, number>();
let totalRowRenders = 0;

export function setTimelinePerfEnabled(enabled: boolean): void {
  perfEnabled = enabled;
}

export function recordClipRowRender(itemId: string): void {
  if (!perfEnabled) return;
  totalRowRenders += 1;
  rowRenderCounts.set(itemId, (rowRenderCounts.get(itemId) ?? 0) + 1);
}

export function resetTimelinePerfCounts(): void {
  rowRenderCounts.clear();
  totalRowRenders = 0;
}

export function getTimelinePerfCounts(): { total: number; perItem: Map<string, number> } {
  return { total: totalRowRenders, perItem: new Map(rowRenderCounts) };
}
