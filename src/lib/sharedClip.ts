/**
 * R40 P-11 (DOCUMENT verdict — see the spike verdict file in
 * flyer-logo-anim-research) — shared-clip detection for the honest
 * disclosure line.
 *
 * Preview and export keep ONE media element per asset, so copies of
 * the same clip share one playback position. Until a per-item pool is
 * proven safe on real phones, the app says so where it matters: this
 * helper decides, for one selected item, whether the disclosure is
 * actually true — the same asset is used by 2+ items AND at least one
 * other use differs in trim, speed or position. Identical copies
 * stacked exactly alike share a position too, but nothing about them
 * misleads (every copy wants the same frame), so they stay quiet.
 */

import type { Project, TimelineItem } from '../types/timeline';

type MediaItem = Extract<TimelineItem, { mediaAssetId: string }>;

function isMediaItem(item: TimelineItem): item is MediaItem {
  return 'mediaAssetId' in item && typeof (item as MediaItem).mediaAssetId === 'string';
}

function trimOf(item: TimelineItem): { start: number; end: number } | null {
  const it = item as { trimStart?: unknown; trimEnd?: unknown };
  return typeof it.trimStart === 'number' && typeof it.trimEnd === 'number'
    ? { start: it.trimStart, end: it.trimEnd }
    : null;
}

function speedOf(item: TimelineItem): number {
  const s = (item as { speed?: unknown }).speed;
  return typeof s === 'number' ? s : 1;
}

function positionOf(item: TimelineItem): { x: number; y: number } | null {
  const p = (item as { position?: unknown }).position as { x?: unknown; y?: unknown } | undefined;
  return p && typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : null;
}

function differsFrom(a: TimelineItem, b: TimelineItem): boolean {
  const ta = trimOf(a);
  const tb = trimOf(b);
  if (ta && tb && (ta.start !== tb.start || ta.end !== tb.end)) return true;
  if (speedOf(a) !== speedOf(b)) return true;
  const pa = positionOf(a);
  const pb = positionOf(b);
  if (pa && pb && (pa.x !== pb.x || pa.y !== pb.y)) return true;
  return false;
}

/** All items in the project that use the same asset as `item` (including itself). */
export function itemsSharingAsset(project: Project, item: TimelineItem): TimelineItem[] {
  if (!isMediaItem(item)) return [item];
  return project.items.filter((other) => isMediaItem(other) && other.mediaAssetId === item.mediaAssetId);
}

/**
 * True when the P-11 disclosure applies to `item`: its asset is used
 * in 2+ places and at least one other place differs in trim, speed
 * or position.
 */
export function hasDifferingSharedUse(project: Project, item: TimelineItem): boolean {
  const sharing = itemsSharingAsset(project, item);
  if (sharing.length < 2) return false;
  return sharing.some((other) => other.id !== item.id && differsFrom(item, other));
}

/** The disclosure line, in the app's plain words. */
export const SHARED_CLIP_NOTE =
  'This clip is also used somewhere else in this project. Copies of the same clip share one playback position, so trims and speeds affect every copy.';
