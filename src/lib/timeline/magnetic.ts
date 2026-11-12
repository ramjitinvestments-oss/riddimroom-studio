/**
 * R44 SF-7 — Magnetic main track.
 *
 * On a plain project (no template contract), the main visual sequence on
 * each primary track (video/image) behaves like CapCut's main track:
 * dragging a clip past a neighbour REORDERS the sequence instead of
 * clamping against it, and the sequence is always packed — a drag or a
 * delete closes every gap. Durations never change; only start/end times
 * are rewritten, in one atomic project update (the R26 commit-on-release
 * discipline is untouched — the panel previews imperatively and calls
 * these functions exactly once, on release).
 *
 * THE CONTRACT COEXISTENCE RULE (R42, load-bearing): a project carrying
 * `appliedTemplate` keeps its slot map authoritative. Magnetism NEVER
 * re-packs a contracted reel — not on drag, not on delete. Every entry
 * point here falls back to the legacy clamped `moveItem` / plain
 * `removeItem` for contracted projects, and the drift + Re-apply flow
 * (lib/templates/contract.ts) remains the only path that re-cuts a
 * contracted reel. This is pinned by tests in magnetic.test.ts.
 *
 * TRANSITIONS BY CONSTRUCTION: an overlap between two main items is a
 * designed transition in this app (pair/crossfade material is placed as
 * deliberate overlaps). If a track's main sequence contains ANY overlap,
 * magnetism stands down for that track entirely (legacy clamp semantics)
 * rather than silently destroying the overlap. Per-item transition and
 * animation settings live ON the items, so a pack — which only rewrites
 * startTime/endTime — carries them along untouched.
 */
import type { Project, TimelineItem } from '../../types/timeline';
import { getItemDuration, isMainVisualItem, moveItem, removeItem } from './utils';

const EPS = 1e-6;

function isPrimaryTrack(project: Project, trackId: string): boolean {
  const track = project.tracks.find((t) => t.id === trackId);
  return track?.type === 'video' || track?.type === 'image';
}

/** The main visual items on one primary track, in timeline order. */
export function mainTrackSequence(project: Project, trackId: string): TimelineItem[] {
  if (!isPrimaryTrack(project, trackId)) return [];
  return project.items
    .filter((item) => item.trackId === trackId && isMainVisualItem(item))
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
}

function sequenceHasOverlap(sequence: TimelineItem[]): boolean {
  for (let i = 1; i < sequence.length; i += 1) {
    if (sequence[i].startTime < sequence[i - 1].endTime - EPS) return true;
  }
  return false;
}

/**
 * Whether magnetism may act on this track right now: the project is not
 * under a template contract, the track is primary, and its main sequence
 * carries no designed overlaps.
 */
export function magnetismApplies(project: Project, trackId: string): boolean {
  if (project.appliedTemplate) return false;
  const sequence = mainTrackSequence(project, trackId);
  if (sequence.length === 0) return false;
  return !sequenceHasOverlap(sequence);
}

/** Rewrite the given items' start/end in one atomic project update. */
function applyPack(project: Project, placements: Map<string, { startTime: number; endTime: number }>): Project {
  let changed = false;
  const items = project.items.map((item) => {
    const placement = placements.get(item.id);
    if (!placement) return item;
    if (Math.abs(item.startTime - placement.startTime) > EPS || Math.abs(item.endTime - placement.endTime) > EPS) {
      changed = true;
      return { ...item, startTime: placement.startTime, endTime: placement.endTime } as TimelineItem;
    }
    return item;
  });
  if (!changed) return project;
  return { ...project, items, updatedAt: Date.now() };
}

/** Pack a sequence contiguously from `origin`, preserving order + durations. */
function packPlacements(sequence: TimelineItem[], origin: number): Map<string, { startTime: number; endTime: number }> {
  const placements = new Map<string, { startTime: number; endTime: number }>();
  let cursor = origin;
  for (const item of sequence) {
    const duration = getItemDuration(item);
    placements.set(item.id, { startTime: cursor, endTime: cursor + duration });
    cursor += duration;
  }
  return placements;
}

/**
 * Magnetic move: reorder the dragged main item within its track's
 * sequence and pack. The insertion point compares the dragged clip's
 * proposed START against each neighbour's midpoint — the clip takes the
 * slot of the first neighbour whose midpoint passes its leading edge
 * (start-based, so a long clip can still be dragged to the front). Falls back to the legacy clamped
 * `moveItem` whenever magnetism must not act (contracted project,
 * non-main item, designed overlaps on the track).
 */
export function moveItemMagnetic(project: Project, itemId: string, targetStartTime: number): Project {
  const item = project.items.find((i) => i.id === itemId);
  if (!item) return project;
  if (!isMainVisualItem(item) || !magnetismApplies(project, item.trackId)) {
    return moveItem(project, itemId, targetStartTime);
  }
  const sequence = mainTrackSequence(project, item.trackId);
  const others = sequence.filter((s) => s.id !== itemId);
  const duration = getItemDuration(item);
  const proposedStart = Math.max(0, targetStartTime);
  let insertAt = others.length;
  for (let i = 0; i < others.length; i += 1) {
    const midpoint = others[i].startTime + getItemDuration(others[i]) / 2;
    if (proposedStart < midpoint) {
      insertAt = i;
      break;
    }
  }
  const reordered = [...others.slice(0, insertAt), item, ...others.slice(insertAt)];
  const origin = sequence[0].startTime;
  return applyPack(project, packPlacements(reordered, origin));
}

/** Close every gap in one primary track's main sequence. No-op when magnetism must not act. */
export function packMainTrack(project: Project, trackId: string): Project {
  if (!magnetismApplies(project, trackId)) return project;
  const sequence = mainTrackSequence(project, trackId);
  return applyPack(project, packPlacements(sequence, sequence[0].startTime));
}

/**
 * Delete with gap-close: remove the item, then pack its track's main
 * sequence (same stand-down rules — contracted projects keep the plain
 * removal and let drift/Re-apply govern; overlapped sequences are left
 * exactly as the deletion left them).
 */
export function removeItemClosingGap(project: Project, itemId: string): Project {
  const item = project.items.find((i) => i.id === itemId);
  const removed = removeItem(project, itemId);
  if (!item || !isMainVisualItem(item)) return removed;
  return packMainTrack(removed, item.trackId);
}
