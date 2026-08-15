/**
 * RiddimRoom Studio — timeline utility functions.
 *
 * Pure, dependency-free helpers for building and querying a `Project`. No
 * React, no Firebase, no rendering — those belong to later phase steps
 * (editor UI, storage wiring, render engine respectively). This module is
 * the foundation those steps build on.
 */

import type {
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
