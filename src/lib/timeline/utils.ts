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
  Project,
  Track,
  TrackType,
  TimelineItem,
  MediaAsset,
} from '../../types/timeline';
import { ITEM_TYPE_TO_TRACK_TYPE, TIMELINE_SCHEMA_VERSION } from '../../types/timeline';
import { findTransitionPreset } from '../transitions';
import { DURATION_LIMIT_EPSILON_SECONDS, MAX_MEDIA_SECONDS } from '../media/constants';

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

/** Total timeline duration: the latest endTime across every item, or 0 for an empty project. */
export function getProjectDuration(project: Project): number {
  if (project.items.length === 0) return 0;
  return Math.max(...project.items.map((item) => item.endTime));
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
 * of only at export time.
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
