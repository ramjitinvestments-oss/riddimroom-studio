/**
 * RiddimRoom Studio — timeline utility functions.
 *
 * Pure, dependency-free helpers for building and querying a `Project`. No
 * React, no Firebase, no rendering — those belong to later phase steps
 * (editor UI, storage wiring, render engine respectively). This module is
 * the foundation those steps build on.
 */

import type {
  CaptionTimelineItem,
  Project,
  Track,
  TrackType,
  TimelineItem,
  MediaAsset,
} from '../../types/timeline';
import { ITEM_TYPE_TO_TRACK_TYPE, TIMELINE_SCHEMA_VERSION } from '../../types/timeline';

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generates a random-enough id for tracks/items/assets/projects without
 * pulling in a uuid dependency. Not cryptographically secure — fine for
 * client-generated document/subdocument ids, same trust level as
 * `crypto.randomUUID()` would provide but works in every runtime this
 * project targets (browser, Node, and Node's `esbuild`-bundled server).
 */
export function generateTimelineId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  const timestamp = Date.now().toString(36);
  return `${prefix}_${timestamp}${random}`;
}

// ---------------------------------------------------------------------------
// Project construction
// ---------------------------------------------------------------------------

export interface CreateProjectOptions {
  ownerUid: string;
  name?: string;
  canvasWidth?: number;
  canvasHeight?: number;
  frameRate?: number;
  now?: number;
}

/** Creates a new, empty Project with no tracks and no items. */
export function createEmptyProject(options: CreateProjectOptions): Project {
  const now = options.now ?? Date.now();
  return {
    id: generateTimelineId('project'),
    ownerUid: options.ownerUid,
    name: options.name ?? 'Untitled Project',
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    tracks: [],
    items: [],
    mediaAssets: {},
    canvasWidth: options.canvasWidth ?? 1080,
    canvasHeight: options.canvasHeight ?? 1920,
    frameRate: options.frameRate ?? 30,
    createdAt: now,
    updatedAt: now,
  };
}

export function createTrack(type: TrackType, name: string, order: number): Track {
  return {
    id: generateTimelineId('track'),
    type,
    name,
    order,
    visible: true,
    locked: false,
    ...(type === 'audio' ? { muted: false } : {}),
  };
}

/** Returns a new Project with the track appended. Does not mutate the input. */
export function addTrack(project: Project, track: Track): Project {
  return {
    ...project,
    tracks: [...project.tracks, track],
    updatedAt: Date.now(),
  };
}

/** Returns a new Project with the item appended. Does not mutate the input. */
export function addItem(project: Project, item: TimelineItem): Project {
  return {
    ...project,
    items: [...project.items, item],
    updatedAt: Date.now(),
  };
}

/**
 * Returns a new Project with `itemId` shallow-patched by `patch`. Added in
 * the editor-shell build step (Step 6) once a real UI needed to mutate an
 * item's existing fields (position/timing/text/etc), not just add/remove
 * whole items. `patch` is typed loosely (`Partial<TimelineItem>` would
 * reject a patch object that doesn't include a `type` discriminant even
 * when the caller isn't changing it) — callers are expected to only pass
 * fields valid for that item's actual type; `validateProject`/
 * `assertValidProject` remain the real safety net before persistence.
 */
export function updateItem(project: Project, itemId: string, patch: Record<string, unknown>): Project {
  return {
    ...project,
    items: project.items.map((item) => (item.id === itemId ? ({ ...item, ...patch } as TimelineItem) : item)),
    updatedAt: Date.now(),
  };
}

export function removeItem(project: Project, itemId: string): Project {
  return {
    ...project,
    items: project.items.filter((item) => item.id !== itemId),
    updatedAt: Date.now(),
  };
}

export function removeTrack(project: Project, trackId: string): Project {
  return {
    ...project,
    tracks: project.tracks.filter((track) => track.id !== trackId),
    // Items on a removed track become orphaned; callers should reassign or
    // remove them explicitly (validateProject will flag orphans, it will
    // never silently delete a user's work on their behalf).
    updatedAt: Date.now(),
  };
}

export function addMediaAsset(project: Project, asset: MediaAsset): Project {
  return {
    ...project,
    mediaAssets: { ...project.mediaAssets, [asset.id]: asset },
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/**
 * An item's duration is deliberately NOT a stored field — storing both
 * `startTime`/`endTime` and `duration` would let them drift out of sync
 * (e.g. an edit that updates endTime but forgets duration). It is always
 * derived on demand from the two timestamps that are the source of truth.
 */
export function getItemDuration(item: Pick<TimelineItem, 'startTime' | 'endTime'>): number {
  return item.endTime - item.startTime;
}

/** Total timeline duration: the latest endTime across every item, or 0 for an empty project. */
export function getProjectDuration(project: Project): number {
  if (project.items.length === 0) return 0;
  return Math.max(...project.items.map((item) => item.endTime));
}

/** True if two items' [startTime, endTime) ranges overlap. Half-open so back-to-back items don't count. */
export function itemsOverlapInTime(a: TimelineItem, b: TimelineItem): boolean {
  return a.startTime < b.endTime && b.startTime < a.endTime;
}

// ---------------------------------------------------------------------------
// Editing — move, trim, duration, split
//
// These are the operations the editor UI (TimelinePanel drag/trim handles,
// ItemInspector's duration field, the "Split at playhead" action) actually
// performs. Kept here alongside the other pure Project transforms rather
// than inline in components, same reasoning as `updateItem` above: every
// caller goes through one shared, tested implementation instead of each
// component hand-rolling its own timing math and drifting out of sync with
// `trimStart`/`trimEnd` (a real bug found in this codebase — the inspector
// used to edit `startTime`/`endTime` directly without ever touching the
// matching trim window, so "shortening" a video clip changed its timeline
// slot but not which part of the source video actually played).
// ---------------------------------------------------------------------------

function isTrimmable(item: TimelineItem): item is Extract<TimelineItem, { trimStart: number; trimEnd: number }> {
  return item.type === 'video' || item.type === 'audio';
}

/** True if `[startTime, endTime)` on `trackId` would overlap any item other than `ignoreItemId`. */
export function wouldOverlapOnTrack(
  project: Project,
  trackId: string,
  startTime: number,
  endTime: number,
  ignoreItemId?: string,
): boolean {
  return project.items.some(
    (other) => other.id !== ignoreItemId && other.trackId === trackId && startTime < other.endTime && other.startTime < endTime,
  );
}

export interface MoveItemOptions {
  /** When true (default), a move that would overlap a sibling on the same track is clamped against it instead of applied as-is. */
  preventOverlap?: boolean;
}

/** Translates an item to a new start time, preserving its duration (and, for video/audio, its trim window — moving never re-trims). */
export function moveItem(project: Project, itemId: string, newStartTime: number, options: MoveItemOptions = {}): Project {
  const item = project.items.find((i) => i.id === itemId);
  if (!item) return project;
  const duration = getItemDuration(item);
  let start = Math.max(0, newStartTime);
  let end = start + duration;

  if (options.preventOverlap !== false) {
    const siblings = project.items
      .filter((other) => other.id !== itemId && other.trackId === item.trackId)
      .sort((a, b) => a.startTime - b.startTime);
    for (const sibling of siblings) {
      if (start < sibling.endTime && sibling.startTime < end) {
        // Clamp against whichever side of the sibling we're closer to, rather than rejecting the move outright.
        const clampBefore = sibling.startTime - duration;
        const clampAfter = sibling.endTime;
        start = Math.abs(start - clampBefore) <= Math.abs(start - clampAfter) ? Math.max(0, clampBefore) : clampAfter;
        end = start + duration;
      }
    }
  }

  return updateItem(project, itemId, { startTime: start, endTime: end });
}

/**
 * Moves an item's start edge (a left-side trim drag). For video/audio this
 * also moves `trimStart` by the same source-time delta, so the timeline
 * slot and the source playback window shrink/grow together; for
 * image/text/caption (no source trim concept) it's a plain edge move.
 * `endTime` is never touched — trimming the start never moves the end.
 */
export function trimItemStart(project: Project, itemId: string, newStartTime: number): Project {
  const item = project.items.find((i) => i.id === itemId);
  if (!item) return project;
  const clampedStart = Math.max(0, Math.min(newStartTime, item.endTime - 0.1));

  if (isTrimmable(item)) {
    const speed = item.type === 'video' ? item.speed : 1;
    const deltaSourceSeconds = (clampedStart - item.startTime) * speed;
    const newTrimStart = Math.max(0, item.trimStart + deltaSourceSeconds);
    return updateItem(project, itemId, { startTime: clampedStart, trimStart: newTrimStart });
  }
  return updateItem(project, itemId, { startTime: clampedStart });
}

/**
 * Moves an item's end edge (a right-side trim drag / the inspector's
 * duration field). For video/audio this also moves `trimEnd` by the same
 * source-time delta. `startTime` is never touched.
 */
export function trimItemEnd(project: Project, itemId: string, newEndTime: number): Project {
  const item = project.items.find((i) => i.id === itemId);
  if (!item) return project;
  const clampedEnd = Math.max(item.startTime + 0.1, newEndTime);

  if (isTrimmable(item)) {
    const speed = item.type === 'video' ? item.speed : 1;
    const deltaSourceSeconds = (clampedEnd - item.endTime) * speed;
    const newTrimEnd = Math.max(item.trimStart + 0.1, item.trimEnd + deltaSourceSeconds);
    return updateItem(project, itemId, { endTime: clampedEnd, trimEnd: newTrimEnd });
  }
  return updateItem(project, itemId, { endTime: clampedEnd });
}

/** Sets an item's duration directly (used by the inspector's "Duration" field) by moving its end edge — see `trimItemEnd`. */
export function setItemDuration(project: Project, itemId: string, newDurationSeconds: number): Project {
  const item = project.items.find((i) => i.id === itemId);
  if (!item) return project;
  const duration = Math.max(0.1, newDurationSeconds);
  return trimItemEnd(project, itemId, item.startTime + duration);
}

/**
 * Splits the item at `atTime` (an absolute timeline position) into two
 * items. For video/audio, `trimStart`/`trimEnd` are divided at the matching
 * source-time offset so playback stays correct on both halves. For
 * `caption`, the `words` array is divided at `atTime` so each half keeps
 * only the words that actually fall in its span (captions "remain
 * associated correctly" — no word duplicated or dropped). No-ops (returns
 * `project` unchanged) if `atTime` isn't meaningfully inside the item.
 */
export function splitItemAtTime(project: Project, itemId: string, atTime: number): Project {
  const item = project.items.find((i) => i.id === itemId);
  if (!item) return project;
  const MIN_PIECE = 0.05;
  if (atTime <= item.startTime + MIN_PIECE || atTime >= item.endTime - MIN_PIECE) return project;

  if (item.type === 'caption') {
    const relativeSplit = atTime - item.startTime;
    const firstWords = item.words.filter((w) => w.start < relativeSplit);
    const secondWordsRaw = item.words.filter((w) => w.start >= relativeSplit);
    if (firstWords.length === 0 || secondWordsRaw.length === 0) return project;
    const secondOffset = secondWordsRaw[0].start;
    const secondWords = secondWordsRaw.map((w) => ({ text: w.text, start: w.start - secondOffset, end: w.end - secondOffset }));
    const newItem: CaptionTimelineItem = {
      ...item,
      id: generateTimelineId('item'),
      startTime: item.startTime + secondOffset,
      words: secondWords,
    };
    let next = updateItem(project, itemId, { words: firstWords, endTime: atTime });
    next = addItem(next, newItem);
    return next;
  }

  const newItemId = generateTimelineId('item');
  let firstPatch: Record<string, unknown> = { endTime: atTime };
  let secondExtra: Record<string, unknown> = {};

  if (isTrimmable(item)) {
    const speed = item.type === 'video' ? item.speed : 1;
    const trimSplit = item.trimStart + (atTime - item.startTime) * speed;
    firstPatch = { ...firstPatch, trimEnd: trimSplit };
    secondExtra = { trimStart: trimSplit };
  }

  const newItem: TimelineItem = { ...item, ...secondExtra, id: newItemId, startTime: atTime } as TimelineItem;
  let next = updateItem(project, itemId, firstPatch);
  next = addItem(next, newItem);
  return next;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function getTracksByType(project: Project, type: TrackType): Track[] {
  return project.tracks.filter((track) => track.type === type).sort((a, b) => a.order - b.order);
}

export function getItemsForTrack(project: Project, trackId: string): TimelineItem[] {
  return project.items.filter((item) => item.trackId === trackId);
}

/** All items whose [startTime, endTime) window contains `timeSeconds`, ordered back-to-front by zIndex. */
export function getItemsAtTime(project: Project, timeSeconds: number): TimelineItem[] {
  return project.items
    .filter((item) => item.startTime <= timeSeconds && timeSeconds < item.endTime)
    .sort((a, b) => a.zIndex - b.zIndex);
}

/** All items on tracks of a given type, ordered back-to-front by zIndex — the future renderer's draw order. */
export function getItemsByTrackType(project: Project, trackType: TrackType): TimelineItem[] {
  const trackIds = new Set(getTracksByType(project, trackType).map((track) => track.id));
  return project.items
    .filter((item) => trackIds.has(item.trackId))
    .sort((a, b) => a.zIndex - b.zIndex);
}

/** The one Track a given item type is allowed to live on, per `ITEM_TYPE_TO_TRACK_TYPE`. */
export function expectedTrackTypeFor(item: TimelineItem): TrackType {
  return ITEM_TYPE_TO_TRACK_TYPE[item.type];
}
