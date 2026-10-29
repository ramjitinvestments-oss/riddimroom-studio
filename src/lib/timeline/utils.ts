/**
 * RiddimRoom Studio — timeline utility functions.
 *
 * Pure, dependency-free helpers for building and querying a `Project`. No
 * React, no Firebase, no rendering — those belong to later phase steps
 * (editor UI, storage wiring, render engine respectively). This module is
 * the foundation those steps build on.
 */

import type {
  AnimationPreset,
  AnimationSettings,
  CaptionTimelineItem,
  FadeSettings,
  MotionSettings,
  Project,
  Track,
  TrackType,
  TimelineItem,
  MediaAsset,
} from '../../types/timeline';
import { ITEM_TYPE_TO_TRACK_TYPE, TIMELINE_SCHEMA_VERSION } from '../../types/timeline';
import { findTransitionPreset } from '../transitions';
import { DURATION_LIMIT_EPSILON_SECONDS, MAX_FADE_SECONDS, MAX_MEDIA_SECONDS } from '../media/constants';

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
// Background removal pairing ("final production fix" spec item 4) — links
// an original image asset to its processed (background-removed) sibling so
// re-toggling the Original/Background-Removed control never has to
// reprocess the image, and lets any timeline item already using one of the
// pair be flipped over to the other in place.
// ---------------------------------------------------------------------------

/** Records that `removedAssetId` is `originalAssetId`'s background-removed counterpart, both directions. Both must already exist in `project.mediaAssets`. */
export function linkBackgroundRemovedAsset(project: Project, originalAssetId: string, removedAssetId: string): Project {
  const original = project.mediaAssets[originalAssetId];
  const removed = project.mediaAssets[removedAssetId];
  if (!original || !removed) return project;
  return {
    ...project,
    mediaAssets: {
      ...project.mediaAssets,
      [originalAssetId]: { ...original, backgroundRemovedAssetId: removedAssetId },
      [removedAssetId]: { ...removed, originalAssetId },
    },
    updatedAt: Date.now(),
  };
}

/**
 * Re-points every timeline item currently using `fromAssetId` to
 * `toAssetId` instead — position/scale/rotation/opacity and every other
 * per-item field are untouched, only which pixels get drawn changes. This
 * is what makes the background-removal toggle "in place": a watermark
 * already placed on the canvas updates immediately rather than the user
 * having to delete it and re-add the processed version by hand.
 */
export function retargetItemsToAsset(project: Project, fromAssetId: string, toAssetId: string): Project {
  if (fromAssetId === toAssetId) return project;
  let changed = false;
  const items = project.items.map((item) => {
    if ('mediaAssetId' in item && item.mediaAssetId === fromAssetId) {
      changed = true;
      return { ...item, mediaAssetId: toAssetId } as TimelineItem;
    }
    return item;
  });
  if (!changed) return project;
  return { ...project, items, updatedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/**
 * Formats a timeline position/duration as `m:ss.d` (e.g. `0:07.5`,
 * `12:03.0`) — the ONE timecode format the editor UI uses everywhere
 * (transport readout, timeline header), replacing the mix of raw
 * `toFixed(1) + 's'` strings and `0:00` literals components used to
 * hand-roll inconsistently. Negative/NaN input clamps to `0:00.0`.
 */
export function formatTimecode(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, totalSeconds) : 0;
  const tenths = Math.round(safe * 10);
  const minutes = Math.floor(tenths / 600);
  const remTenths = tenths - minutes * 600;
  const seconds = Math.floor(remTenths / 10);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${remTenths % 10}`;
}

/**
 * An item's duration is deliberately NOT a stored field — storing both
 * `startTime`/`endTime` and `duration` would let them drift out of sync
 * (e.g. an edit that updates endTime but forgets duration). It is always
 * derived on demand from the two timestamps that are the source of truth.
 */
export function getItemDuration(item: Pick<TimelineItem, 'startTime' | 'endTime'>): number {
  return item.endTime - item.startTime;
}

/** Latest endTime across EVERY item on every track, or 0 for an empty project — the pre-R26 project-duration rule, kept as an explicit helper for consumers that genuinely need the full timeline extent (e.g. a scrollable timeline ruler that must still reach an over-long audio item, or the explicit Fit-to-project helpers below). `getProjectDuration` itself no longer uses this rule when a main track exists — see `getMainTrackEnd`. */
export function getMaxItemEnd(project: Project): number {
  if (project.items.length === 0) return 0;
  return Math.max(...project.items.map((item) => item.endTime));
}

/**
 * True for the items that constitute MAIN content — the same main-vs-overlay
 * classification the codebase already uses elsewhere:
 * - video items that are not PiP overlays (`lib/pip.ts`'s `isPipItem` /
 *   `findMainVideoForPip`: the main video is the non-PiP video; inlined here
 *   because `pip.ts` imports from this module, so importing it back would
 *   be circular), and
 * - image items with role `photo` or `graphic` (`lib/timeline/insert.ts`'s
 *   `visualClassRank`: photo/graphic are layer class 0, main content, while
 *   overlay/watermark/logo/sticker are class 2 decoration; templates'
 *   slottable-media rule in `lib/templates/apply.ts` is the narrower
 *   photo-only subset of this, and Promo recipes/posters place their main
 *   stage artwork as `graphic`/`photo` images).
 * Text, caption and audio items are never main content, and neither are
 * PiP videos or watermark/logo/sticker/overlay images — those accompany
 * the main content, so they don't count toward the MAIN-track end
 * (`getMainTrackEnd`). (Under the R36 duration law a PiP video still
 * counts toward the PROJECT duration via `getLongestVideoEnd` — main
 * classification and project duration are separate measures now.)
 * Exported for the compositor's R36 hold-last-frame logic, which must
 * find the latest-ending main visual item with this same classification.
 */
export function isMainVisualItem(item: TimelineItem): boolean {
  if (item.type === 'video') return !item.pip?.isPip;
  if (item.type === 'image') return item.role === 'photo' || item.role === 'graphic';
  return false;
}

/**
 * R26 (WS-A2) — the end time (seconds) of the project's PRIMARY VISUAL
 * TRACKS, or null when the project has no main content.
 *
 * "Primary visual track" in this model: the project's `video` and `image`
 * tracks (`createDefaultProject` in `lib/projects/persistence.ts` creates
 * exactly one of each — "Main Video" and the image track that
 * `appendMediaToTimeline`/`lib/promo` place main photos and stage artwork
 * on). Main video/image clips live across those two tracks, not just one:
 * templates pack a sequential reel across both, and Promo builds its main
 * stage from images while other projects use video. So the main end is
 * the latest endTime among MAIN items (see `isMainVisualItem`) sitting on
 * a track of the matching type — an item whose track is missing, or whose
 * track type doesn't match the item, is not on a primary visual track and
 * doesn't count. Null (not 0) when no such track/items exist, so callers
 * can distinguish "no main content" from "main content ending at 0".
 *
 * R36: this remains the MAIN-ONLY measure, kept intact for consumers
 * that genuinely need it (the compositor's hold-last-frame logic needs
 * to know where the main layer itself ends). It is NOT the project
 * duration on its own any more — `getProjectDuration` combines it with
 * `getLongestVideoEnd`.
 */
export function getMainTrackEnd(project: Project): number | null {
  const mainTrackIds = new Set(
    project.tracks.filter((track) => track.type === 'video' || track.type === 'image').map((track) => track.id),
  );
  if (mainTrackIds.size === 0) return null;
  let end: number | null = null;
  for (const item of project.items) {
    if (!mainTrackIds.has(item.trackId) || !isMainVisualItem(item)) continue;
    end = end === null ? item.endTime : Math.max(end, item.endTime);
  }
  return end;
}

/**
 * R36 — the latest endTime among ALL video items on any track, or null
 * when the project has no video items. PiP/overlay videos and pair
 * tiles (split seconds, camera pairs) count exactly like main videos:
 * this is the "longest video" measure the R36 duration law is built
 * on. Track placement is irrelevant here on purpose — a PiP lives on
 * the same video track as the main clip in this model, and an imported
 * pair tile can sit on the image track, so any track filter would
 * silently drop real video content.
 */
export function getLongestVideoEnd(project: Project): number | null {
  let end: number | null = null;
  for (const item of project.items) {
    if (item.type !== 'video') continue;
    end = end === null ? item.endTime : Math.max(end, item.endTime);
  }
  return end;
}

/**
 * Total timeline duration — the R36 LONGEST-VIDEO DURATION LAW (owner
 * decision, superseding R26's PiP exclusion): when at least one of
 * {the main-track end (`getMainTrackEnd`), the longest-video end
 * (`getLongestVideoEnd`)} exists, the duration is the MAX of those
 * present — so a 40s PiP over a 12s main makes a 40s project (R26
 * made it 12s: the PiP was excluded from the main measure and simply
 * clipped), and a 40s main over a 12s PiP still makes 40s. A main
 * photo ending at 20s over a 12s video still makes 20s (the main
 * measure wins when it is longer). When NEITHER exists (audio-only,
 * text-only, caption-only or empty projects), this falls back to the
 * old latest-end-across-every-item rule (`getMaxItemEnd`) exactly, so
 * those projects keep exactly their old duration. Audio NEVER extends
 * a project that has visual/video content: a 3-minute song under a
 * 12s main with no longer video still makes a 12s project, and audio
 * past the project end is clipped at render time.
 *
 * `getMainTrackEnd` above stays intact as the MAIN-ONLY measure for
 * consumers that genuinely need it (e.g. the compositor's hold-last-
 * frame logic, which must know where the main layer itself ends) —
 * it is no longer, on its own, the project duration.
 */
export function getProjectDuration(project: Project): number {
  const mainEnd = getMainTrackEnd(project);
  const longestVideoEnd = getLongestVideoEnd(project);
  if (mainEnd === null && longestVideoEnd === null) return getMaxItemEnd(project);
  return Math.max(mainEnd ?? Number.NEGATIVE_INFINITY, longestVideoEnd ?? Number.NEGATIVE_INFINITY);
}

/**
 * "Universal 30-second media standard" — the PROJECT-level guard, distinct
 * from the per-item cap enforced in `trimItemEnd`/`setItemDuration`/
 * `appendMediaToTimeline` below. Three in-limit clips placed back to back
 * (e.g. 10s + 10s + 10s = 30s) are each individually fine but can still
 * assemble into a project that's too long — this is what catches that case.
 * `ProjectContext`'s `mutate` calls this after every edit and blocks (rather
 * than silently applying) any mutation that would push the total duration
 * past the limit, so the problem surfaces immediately in the editor instead
 * of only at export time. R26: "total duration" here is `getProjectDuration`'s
 * main-track semantics — an over-long audio item under a short main track no
 * longer trips this guard (the song doesn't make the project longer; the
 * per-item cap in `trimItemEnd`/`appendMediaToTimeline` still bounds the
 * audio item itself), while growing the main track past the limit still does.
 * R36: the guard follows the longest-video law automatically (it calls
 * `getProjectDuration`), so a PiP/overlay video that pushes the total past
 * the limit now trips it too — that is the law working, not a regression.
 */
export function projectDurationExceedsLimit(project: Project, maxSeconds: number = MAX_MEDIA_SECONDS): boolean {
  return getProjectDuration(project) > maxSeconds + DURATION_LIMIT_EPSILON_SECONDS;
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
 *
 * "Universal 30-second media standard" — this is the one choke point every
 * duration-extending edit (drag-resize, the inspector's Duration field,
 * `setItemDuration`) ultimately goes through, so the per-item cap is
 * enforced here rather than re-implemented at each call site: `newEndTime`
 * is clamped so the item's resulting duration never exceeds
 * `MAX_MEDIA_SECONDS`, regardless of item type (this is what stops, e.g., an
 * image's on-screen duration from being dragged out past 30s).
 */
export function trimItemEnd(project: Project, itemId: string, newEndTime: number): Project {
  const item = project.items.find((i) => i.id === itemId);
  if (!item) return project;
  const maxEnd = item.startTime + MAX_MEDIA_SECONDS;
  const clampedEnd = Math.max(item.startTime + 0.1, Math.min(newEndTime, maxEnd));

  if (isTrimmable(item)) {
    const speed = item.type === 'video' ? item.speed : 1;
    const deltaSourceSeconds = (clampedEnd - item.endTime) * speed;
    const newTrimEnd = Math.max(item.trimStart + 0.1, item.trimEnd + deltaSourceSeconds);
    return updateItem(project, itemId, { endTime: clampedEnd, trimEnd: newTrimEnd });
  }
  return updateItem(project, itemId, { endTime: clampedEnd });
}

/** Sets an item's duration directly (used by the inspector's "Duration" field) by moving its end edge — see `trimItemEnd`, which is where the 30-second per-item cap is actually enforced (this clamp here is just belt-and-suspenders so the value passed onward is never negative/zero). */
export function setItemDuration(project: Project, itemId: string, newDurationSeconds: number): Project {
  const item = project.items.find((i) => i.id === itemId);
  if (!item) return project;
  const duration = Math.min(Math.max(0.1, newDurationSeconds), MAX_MEDIA_SECONDS);
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
  }  const newItemId = generateTimelineId('item');
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
// Cross-dissolve — a real, user-facing adjacent-clip transition built on
// the fade mechanism the compositor already implements (see
// `lib/render/compositor.ts`'s `computeFadeOpacity`): two adjacent same-
// track items with an overlapping time range and complementary fade-out/
// fade-in genuinely cross-dissolve, because both get drawn (back-to-front
// by zIndex) during the overlap with opposing opacity ramps. This isn't a
// new rendering feature — it's a one-click way to set up the two
// ingredients (overlap + complementary fades) `applyCrossDissolve`'s
// caller (ItemInspector) would otherwise require the user to configure by
// hand across two different items.
// ---------------------------------------------------------------------------

function hasFadeField(item: TimelineItem): item is Extract<TimelineItem, { fade?: FadeSettings } | { fade: FadeSettings }> {
  return item.type === 'video' || item.type === 'image' || item.type === 'text' || item.type === 'audio';
}

/**
 * v1 caption merge: merges two caption items into the first (words
 * re-based to the first item's timeline, second item removed).
 * No-op if either item is missing, not a caption, or the same item.
 */
export function mergeCaptionItems(project: Project, firstId: string, secondId: string): Project {
  if (firstId === secondId) return project;
  const first = project.items.find((i) => i.id === firstId);
  const second = project.items.find((i) => i.id === secondId);
  if (!first || !second || first.type !== 'caption' || second.type !== 'caption') return project;
  const offset = second.startTime - first.startTime;
  const mergedWords = [...first.words, ...second.words.map((w) => ({ text: w.text, start: w.start + offset, end: w.end + offset }))].sort((a, b) => a.start - b.start);
  const newEnd = Math.max(first.endTime, second.endTime);
  let next = updateItem(project, firstId, { words: mergedWords, endTime: newEnd });
  next = { ...next, items: next.items.filter((i) => i.id !== secondId) };
  return next;
}

/**
 * The item on the same track as `itemId` that follows it in time — i.e.
 * the "appropriate neighboring clip" a cross-dissolve control needs to
 * exist before it can offer anything. Returns undefined if there is no
 * item on the same track after this one, or if the nearest one is too far
 * away (more than 2s gap) to plausibly be an intentional back-to-back
 * pairing rather than two unrelated clips.
 */
export function findAdjacentNextItem(project: Project, itemId: string): TimelineItem | undefined {
  const item = project.items.find((i) => i.id === itemId);
  if (!item) return undefined;
  const candidates = project.items
    .filter((i) => i.id !== itemId && i.trackId === item.trackId && i.startTime >= item.startTime)
    .sort((a, b) => a.startTime - b.startTime);
  const next = candidates[0];
  if (!next) return undefined;
  const MAX_ADJACENCY_GAP_SECONDS = 2;
  if (next.startTime - item.endTime > MAX_ADJACENCY_GAP_SECONDS) return undefined;
  return next;
}

/** True if `itemId` and its adjacent next item (see `findAdjacentNextItem`) both support `fade`, i.e. a cross-dissolve control has something real to offer here. */
export function canCrossDissolve(project: Project, itemId: string): boolean {
  const item = project.items.find((i) => i.id === itemId);
  const next = findAdjacentNextItem(project, itemId);
  return !!item && !!next && hasFadeField(item) && hasFadeField(next);
}

/** True if `itemId` and its adjacent next item already overlap by roughly `durationSeconds` — i.e. a cross-dissolve has already been applied here, so the control shouldn't re-apply (and cumulatively re-shift) it. */
export function crossDissolveAlreadyApplied(project: Project, itemId: string, durationSeconds = 0.6): boolean {
  const item = project.items.find((i) => i.id === itemId);
  const next = findAdjacentNextItem(project, itemId);
  if (!item || !next) return false;
  const overlap = item.endTime - next.startTime;
  return overlap >= durationSeconds - 0.05;
}

/**
 * Pulls the adjacent next item on the same track earlier so it overlaps
 * `itemId`'s tail by `durationSeconds`, and sets complementary fade-out
 * (on `itemId`) / fade-in (on the next item) for that same duration — a
 * real cross-dissolve: both clips draw simultaneously during the overlap
 * with opposing opacity ramps, not a cosmetic flag. No-op if there's no
 * adjacent next item or either item lacks a `fade` field (e.g. captions).
 */
export function applyCrossDissolve(project: Project, itemId: string, durationSeconds = 0.6): Project {
  const item = project.items.find((i) => i.id === itemId);
  if (!item) return project;
  const next = findAdjacentNextItem(project, itemId);
  if (!next || !hasFadeField(item) || !hasFadeField(next)) return project;

  const dur = Math.max(0.1, Math.min(durationSeconds, getItemDuration(item), getItemDuration(next)));
  // The overlap is intentional here, so preventOverlap is explicitly off —
  // this is the one legitimate caller of moveItem that WANTS an overlap.
  let next_ = moveItem(project, next.id, item.endTime - dur, { preventOverlap: false });
  const itemFade = (item as { fade?: FadeSettings }).fade;
  const nextFade = (next as { fade?: FadeSettings }).fade;
  next_ = updateItem(next_, item.id, { fade: { fadeInDuration: itemFade?.fadeInDuration ?? 0, fadeOutDuration: dur } });
  next_ = updateItem(next_, next.id, { fade: { fadeInDuration: dur, fadeOutDuration: nextFade?.fadeOutDuration ?? 0 } });
  return next_;
}

// ---------------------------------------------------------------------------
// Real overlap-based transitions — "final production fix" spec item 7's
// "transitions that visually need two clips at once" requirement, and spec
// item 13/14's overlay/transition test matrix. Generalizes the
// cross-dissolve mechanism directly above (same overlap-by-shifting-the-
// next-clip-earlier approach) to ANY preset in the transitions catalog
// (lib/transitions.ts), not just a plain opacity dissolve.
// ---------------------------------------------------------------------------

/** True for the item types that carry an `animation` field (video/image/text) — a transition preset has nothing to animate on a caption or audio item. */
function hasAnimationField(item: TimelineItem): item is Extract<TimelineItem, { animation?: AnimationSettings }> {
  return item.type === 'video' || item.type === 'image' || item.type === 'text';
}

/** True if `itemId` and its adjacent next item (see `findAdjacentNextItem`) both support `animation`, i.e. a transition-at-this-boundary control has something real to offer. */
export function canApplyTransition(project: Project, itemId: string): boolean {
  const item = project.items.find((i) => i.id === itemId);
  const next = findAdjacentNextItem(project, itemId);
  return !!item && !!next && hasAnimationField(item) && hasAnimationField(next);
}

/** True if `itemId` and its adjacent next item already overlap by roughly `durationSeconds` — mirrors `crossDissolveAlreadyApplied` so a transition-picker UI doesn't let a repeated click cumulatively re-shift the same boundary. */
export function transitionAlreadyApplied(project: Project, itemId: string, durationSeconds = 0.6): boolean {
  const item = project.items.find((i) => i.id === itemId);
  const next = findAdjacentNextItem(project, itemId);
  if (!item || !next) return false;
  const overlap = item.endTime - next.startTime;
  return overlap >= durationSeconds - 0.05;
}

/**
 * Applies `preset` (any id from the transitions catalog, lib/transitions.ts
 * — Fade, Slide Left, Dip to Black, Spin, whatever the user picked at a
 * clip boundary) as a real, overlap-based transition between `itemId` and
 * its adjacent next item on the same track: shifts the next item earlier
 * so it overlaps `itemId`'s tail by `durationSeconds` (falling back to the
 * preset's own catalog default), then sets `itemId`'s own exit animation
 * AND the next item's entrance animation to that SAME preset. Because
 * `drawFrame` already composites every active item every frame regardless
 * of overlap (see compositor.ts — there is no "only one clip active at a
 * time" assumption anywhere in the render path), a matching exit/entrance
 * pair during a real time overlap reads as one transition between the two
 * clips — e.g. "Slide Left" makes A visibly slide out to the left while B
 * simultaneously slides in from the right — rather than two coincidentally
 * overlapping single-clip animations. No-op if there's no adjacent next
 * item or either item lacks an `animation` field (e.g. captions/audio).
 */
export function applyTransition(project: Project, itemId: string, preset: AnimationPreset, durationSeconds?: number): Project {
  const item = project.items.find((i) => i.id === itemId);
  if (!item) return project;
  const next = findAdjacentNextItem(project, itemId);
  if (!next || !hasAnimationField(item) || !hasAnimationField(next)) return project;

  const catalogDuration = findTransitionPreset(preset)?.defaultDurationSeconds ?? 0.6;
  const dur = Math.max(0.1, Math.min(durationSeconds ?? catalogDuration, getItemDuration(item), getItemDuration(next)));
  // Same rationale as applyCrossDissolve above: this overlap is
  // intentional, so preventOverlap is explicitly off.
  let next_ = moveItem(project, next.id, item.endTime - dur, { preventOverlap: false });
  const itemAnimation = (item as { animation?: AnimationSettings }).animation;
  const nextAnimation = (next as { animation?: AnimationSettings }).animation;
  next_ = updateItem(next_, item.id, { animation: { ...itemAnimation, exit: preset } });
  next_ = updateItem(next_, next.id, { animation: { ...nextAnimation, entrance: preset } });
  return next_;
}

/**
 * The boundary transition currently applied between `itemId` and its
 * adjacent next item, if any — the read-side companion to `applyTransition`
 * (which is what the Transitions panel uses to highlight the active preset
 * card). A boundary transition counts as applied only when ALL THREE hold:
 * `itemId`'s exit preset and the next item's entrance preset are the same
 * non-'none' preset (the pair `applyTransition` writes), AND the two items
 * actually overlap in time (the shift `applyTransition` performs). A lone
 * entrance/exit set by hand in the inspector — with no matching partner or
 * no overlap — is a single-clip animation, not a boundary transition, and
 * returns undefined here.
 *
 * Note there is deliberately no `removeTransition` counterpart:
 * `applyTransition` shifts the next item earlier by the transition
 * duration, and the item's pre-transition position/gap is not recorded
 * anywhere, so the shift cannot be reversed safely after the fact (the
 * original gap is unknowable — `findAdjacentNextItem` tolerates up to 2s).
 * Undo is the supported way back.
 */
export function getBoundaryTransition(
  project: Project,
  itemId: string,
): { preset: AnimationPreset; durationSeconds: number } | undefined {
  const item = project.items.find((i) => i.id === itemId);
  const next = findAdjacentNextItem(project, itemId);
  if (!item || !next || !hasAnimationField(item) || !hasAnimationField(next)) return undefined;
  const exit = item.animation?.exit;
  const entrance = next.animation?.entrance;
  if (!exit || exit === 'none' || exit !== entrance) return undefined;
  const overlap = item.endTime - next.startTime;
  if (overlap <= 0.05) return undefined;
  return { preset: exit, durationSeconds: overlap };
}

/**
 * Patches a video/image item's `motion` settings (the continuous Motion/
 * Zoom Effects — see lib/motionEffects.ts), merging `fields` over the
 * item's current settings exactly the way ItemInspector's motion controls
 * always have (`{ type: 'none', ...current, ...fields }`, so a partial
 * patch like `{ intensity }` never wipes the chosen effect). Extracted
 * here so the first-class Effects panel and the inspector write the one
 * same `motion` field through the one same merge — no parallel
 * representation. No-op for items without a motion concept (text/caption/
 * audio) or a missing item id.
 */
export function updateItemMotion(project: Project, itemId: string, fields: Partial<MotionSettings>): Project {
  const item = project.items.find((i) => i.id === itemId);
  if (!item || (item.type !== 'video' && item.type !== 'image')) return project;
  const motion = (item as { motion?: MotionSettings }).motion;
  return updateItem(project, itemId, { motion: { type: 'none', ...motion, ...fields } });
}

// ---------------------------------------------------------------------------
// Playback speed (Phase 2.3) — `VideoTimelineItem.speed` has been in the
// data model since the Bolt port and every trim/split helper already
// converts timeline deltas to source seconds through it (`delta * speed`),
// which fixes the invariant this setter must preserve:
//
//     timeline duration = (trimEnd - trimStart) / speed
//
// Until now nothing could CHANGE speed, so the invariant only ever held
// trivially at speed 1. `setItemSpeed` is the one write path: it anchors
// `startTime`, leaves the trim window untouched, and re-derives `endTime`
// from the new rate. The per-item duration cap (`MAX_MEDIA_SECONDS`, the
// same one `trimItemEnd` enforces) still applies, so slowing a long clip
// far down clamps its timeline duration at the cap rather than breaking
// the product limit (the clip then ends at the cap, before its trim
// window finishes playing — the same trade-off the cap already imposes
// on over-length items everywhere else).
// ---------------------------------------------------------------------------

/** Slowest/fastest rates the speed UI offers; `setItemSpeed` clamps to this range. */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 2;

/** Sets a video item's playback speed, re-deriving its timeline `endTime` from its (unchanged) trim window. No-op for non-video items or a missing id. */
export function setItemSpeed(project: Project, itemId: string, newSpeed: number): Project {
  const item = project.items.find((i) => i.id === itemId);
  if (!item || item.type !== 'video') return project;
  const speed = Math.max(SPEED_MIN, Math.min(SPEED_MAX, Number.isFinite(newSpeed) && newSpeed > 0 ? newSpeed : 1));
  const sourceSpan = Math.max(0.1, item.trimEnd - item.trimStart);
  const duration = Math.max(0.1, Math.min(MAX_MEDIA_SECONDS, sourceSpan / speed));
  return updateItem(project, itemId, { speed, endTime: item.startTime + duration });
}

// ---------------------------------------------------------------------------
// Audio fit — "Trim to project end" / "Loop to fill project" (tweaks
// round, MusicPanel's Fit section). Both target the end of the REST of
// the project (every item except the audio item itself): fitting never
// grows the project, it aligns the audio item's end edge with the
// content it accompanies. Both also default a short fade-out at the
// fitted end when the item has none — an abrupt cut exactly at the
// project's last frame sounds like a bug, not an ending — while
// respecting a fade-out the user already set.
// ---------------------------------------------------------------------------

/** Fade-out (seconds) the fit helpers default at the fitted end when the item has none. */
export const FIT_FADE_OUT_SECONDS = 0.5;

/** Latest endTime among all items except `excludeItemId` — "the end of the project this item accompanies". 0 when the item is alone on the timeline. Deliberately MAX-END semantics (not `getProjectDuration`'s R26 main-track semantics): this backs the explicit Fit-to-project tools, whose job is to align audio with everything else on the timeline, whatever track it's on. */
export function getContentEndTime(project: Project, excludeItemId?: string): number {
  return project.items.reduce((max, i) => (i.id === excludeItemId ? max : Math.max(max, i.endTime)), 0);
}

function fittedFadeOut(item: { endTime: number; startTime: number; fade: FadeSettings }, newDuration: number): number {
  if (item.fade.fadeOutDuration > 0) return Math.min(item.fade.fadeOutDuration, MAX_FADE_SECONDS, newDuration);
  return Math.min(FIT_FADE_OUT_SECONDS, MAX_FADE_SECONDS, newDuration);
}

/**
 * "Trim to project end": aligns an audio item's end with the end of the
 * rest of the project, WITHOUT looping — the trim window moves 1:1 with
 * the end edge (audio has no speed), so trimming down drops source from
 * the tail and extending consumes source the asset actually has (never
 * past the asset's real duration, when known, and never past the
 * per-item cap). Clears `loop` — the two fit modes are alternatives.
 * No-op for non-audio items, a missing id, or when there is no other
 * content ending meaningfully after the item starts.
 */
export function trimAudioToProjectEnd(project: Project, itemId: string): Project {
  const item = project.items.find((i) => i.id === itemId);
  if (!item || item.type !== 'audio') return project;
  const targetEnd = getContentEndTime(project, itemId);
  if (targetEnd <= item.startTime + 0.1) return project;
  const asset = project.mediaAssets[item.mediaAssetId];
  const sourceAvailable =
    asset && typeof asset.durationSeconds === 'number' && Number.isFinite(asset.durationSeconds) && asset.durationSeconds > item.trimStart
      ? asset.durationSeconds - item.trimStart
      : Number.POSITIVE_INFINITY;
  const newEnd = Math.min(targetEnd, item.startTime + sourceAvailable, item.startTime + MAX_MEDIA_SECONDS);
  if (newEnd <= item.startTime + 0.1) return project;
  const newDuration = newEnd - item.startTime;
  return updateItem(project, itemId, {
    endTime: newEnd,
    trimEnd: item.trimEnd + (newEnd - item.endTime),
    loop: false,
    fade: { fadeInDuration: item.fade.fadeInDuration, fadeOutDuration: fittedFadeOut(item, newDuration) },
  });
}

/**
 * "Loop to fill project": stretches an audio item's timeline span to the
 * end of the rest of the project and sets `loop` — the render paths wrap
 * playback inside the item's (unchanged) trim window
 * (`computeLoopedSourceTime`), so a short music bed covers the whole
 * video. The end is capped at the per-item duration cap. No-op for
 * non-audio items, a missing id, or when there is no other content
 * ending meaningfully after the item starts.
 */
export function loopAudioToProjectEnd(project: Project, itemId: string): Project {
  const item = project.items.find((i) => i.id === itemId);
  if (!item || item.type !== 'audio') return project;
  const targetEnd = getContentEndTime(project, itemId);
  if (targetEnd <= item.startTime + 0.1) return project;
  const newEnd = Math.min(targetEnd, item.startTime + MAX_MEDIA_SECONDS);
  const newDuration = newEnd - item.startTime;
  return updateItem(project, itemId, {
    endTime: newEnd,
    loop: true,
    fade: { fadeInDuration: item.fade.fadeInDuration, fadeOutDuration: fittedFadeOut(item, newDuration) },
  });
}

// ---------------------------------------------------------------------------
// Layer order — z-index reordering for overlay composition
//
// `zIndex` has always existed on every item (see `types/timeline.ts`'s
// `TimelineItemBase`) and the compositor has always drawn back-to-front by
// it (`getItemsAtTime`'s doc comment) — but until this pass there was no UI
// path to actually change it, which is exactly the "implemented only in
// code but not exposed to users" gap the full-app audit asked to close.
// These four helpers are simple swap/extremize operations on that existing
// field, not a new stacking model.
// ---------------------------------------------------------------------------

const VISUAL_ITEM_TYPES = new Set<TimelineItem['type']>(['video', 'image', 'text', 'caption']);

/** True for the item types that actually draw something (and so have a meaningful stacking order) — audio has no visual layer. */
export function isVisualItem(item: Pick<TimelineItem, 'type'>): boolean {
  return VISUAL_ITEM_TYPES.has(item.type);
}

/** Swaps `itemId`'s zIndex with the next-higher visual item's zIndex, moving it one step toward the front. No-op if it's already frontmost or not a visual item. */
export function bringForward(project: Project, itemId: string): Project {
  const item = project.items.find((i) => i.id === itemId);
  if (!item || !isVisualItem(item)) return project;
  const above = project.items
    .filter((i) => i.id !== itemId && isVisualItem(i) && i.zIndex > item.zIndex)
    .sort((a, b) => a.zIndex - b.zIndex)[0];
  if (!above) return project;
  let next = updateItem(project, item.id, { zIndex: above.zIndex });
  next = updateItem(next, above.id, { zIndex: item.zIndex });
  return next;
}

/** Swaps `itemId`'s zIndex with the next-lower visual item's zIndex, moving it one step toward the back. No-op if it's already backmost or not a visual item. */
export function sendBackward(project: Project, itemId: string): Project {
  const item = project.items.find((i) => i.id === itemId);
  if (!item || !isVisualItem(item)) return project;
  const below = project.items
    .filter((i) => i.id !== itemId && isVisualItem(i) && i.zIndex < item.zIndex)
    .sort((a, b) => b.zIndex - a.zIndex)[0];
  if (!below) return project;
  let next = updateItem(project, item.id, { zIndex: below.zIndex });
  next = updateItem(next, below.id, { zIndex: item.zIndex });
  return next;
}

/** Sets `itemId`'s zIndex above every other visual item's. No-op if not a visual item. */
export function bringToFront(project: Project, itemId: string): Project {
  const item = project.items.find((i) => i.id === itemId);
  if (!item || !isVisualItem(item)) return project;
  const maxZ = project.items.filter(isVisualItem).reduce((max, i) => Math.max(max, i.zIndex), item.zIndex);
  if (maxZ === item.zIndex) return project;
  return updateItem(project, itemId, { zIndex: maxZ + 1 });
}

/** Sets `itemId`'s zIndex below every other visual item's. No-op if not a visual item. */
export function sendToBack(project: Project, itemId: string): Project {
  const item = project.items.find((i) => i.id === itemId);
  if (!item || !isVisualItem(item)) return project;
  const minZ = project.items.filter(isVisualItem).reduce((min, i) => Math.min(min, i.zIndex), item.zIndex);
  if (minZ === item.zIndex) return project;
  return updateItem(project, itemId, { zIndex: minZ - 1 });
}

// ---------------------------------------------------------------------------
// Caption word editing — "Add word"
// ---------------------------------------------------------------------------

/**
 * Appends a new word to a caption item, placed chronologically after the
 * last existing word (or at t=0 for an empty caption) with sane default
 * timing that is never negative or reversed — the two invalid states the
 * caption editor's Add Word control must never produce. Returns `project`
 * unchanged if `itemId` doesn't reference an existing caption item.
 */
export function addCaptionWord(project: Project, itemId: string, text = 'word'): Project {
  const item = project.items.find((i) => i.id === itemId);
  if (!item || item.type !== 'caption') return project;
  const GAP_SECONDS = 0.1;
  const DEFAULT_WORD_DURATION_SECONDS = 0.4;
  const last = item.words[item.words.length - 1];
  const start = Math.max(0, last ? last.end + GAP_SECONDS : 0);
  const end = start + DEFAULT_WORD_DURATION_SECONDS;
  const words = [...item.words, { text, start, end }];
  return updateItem(project, itemId, { words });
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
