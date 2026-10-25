import { removeItem, updateItem } from '../timeline/utils';
import type { CaptionTimelineItem, Project } from '../../types/timeline';

/**
 * Caption timing discipline (R20) — captions must NEVER overlay each
 * other. Three layers enforce it:
 *
 *  1. `serializeCaptionWindows` at BUILD time (promo converter):
 *     overlapping staged windows become a clean sequence — order
 *     preserved, a broadcast-style gap between cues, every cue keeps
 *     at least a minimum readable duration, stealing time forward
 *     (then backward) before anything is starved.
 *  2. `resolveProjectCaptionOverlaps` on every EDITOR entry path
 *     (transcription, SRT import, manual adds): ends are clamped to
 *     the next cue's start minus the gap; micro-cues that can't
 *     survive clamping are dropped, never stacked.
 *  3. The compositor draws at most one caption per anchor zone at
 *     any instant, whatever a hand-edited project contains.
 */

export const CAPTION_GAP_SECONDS = 0.08;
export const CAPTION_MIN_SECONDS = 0.6;
/** Below this a clamped cue is unreadable — it is dropped, not shown. */
export const CAPTION_FLOOR_SECONDS = 0.25;

export interface CaptionWindow {
  startTime: number;
  endTime: number;
}

const round3 = (n: number) => +n.toFixed(3);

/**
 * Serialize overlapping windows into a non-overlapping sequence.
 * Windows keep their order and (as far as the timeline allows) their
 * staged positions: ends clamp to the next start minus the gap, and
 * a cue that would fall below `minDuration` steals the deficit from
 * its successor (shifting it later); the final cue clamps to
 * `totalDuration` and, if starved, pulls its start earlier and
 * shrinks its predecessor toward its own minimum.
 */
export function serializeCaptionWindows(
  windows: CaptionWindow[],
  opts: { totalDuration: number; gap?: number; minDuration?: number },
): CaptionWindow[] {
  const gap = opts.gap ?? CAPTION_GAP_SECONDS;
  const minDur = opts.minDuration ?? CAPTION_MIN_SECONDS;
  const total = Math.max(0, opts.totalDuration);
  if (windows.length === 0) return [];
  const order = windows
    .map((w, index) => ({ index, start: w.startTime, end: Math.max(w.startTime + 0.1, w.endTime) }))
    .sort((a, b) => a.start - b.start || a.index - b.index);
  const starts = order.map((w) => w.start);
  const ends = order.map((w) => w.end);
  const n = order.length;

  for (let i = 0; i < n - 1; i++) {
    const limit = starts[i + 1] - gap;
    if (ends[i] > limit) {
      ends[i] = limit;
      if (ends[i] - starts[i] < minDur) {
        const need = minDur - (ends[i] - starts[i]);
        starts[i + 1] += need;
        ends[i + 1] += need;
        ends[i] = starts[i + 1] - gap;
      }
    }
  }
  // Final cue: clamp to the timeline end; if starved, pull its start
  // earlier, shrinking the predecessor toward its own minimum.
  ends[n - 1] = Math.min(ends[n - 1], total);
  if (ends[n - 1] - starts[n - 1] < minDur && n > 1) {
    const want = ends[n - 1] - minDur;
    const floorStart = starts[n - 2] + minDur + gap;
    starts[n - 1] = Math.max(want, floorStart, 0);
    if (ends[n - 2] > starts[n - 1] - gap) ends[n - 2] = starts[n - 1] - gap;
  }
  if (n === 1) {
    ends[0] = Math.min(Math.max(ends[0], starts[0] + minDur), Math.max(total, starts[0] + 0.1));
  }

  const out: CaptionWindow[] = new Array(windows.length);
  order.forEach((w, i) => {
    out[w.index] = { startTime: round3(Math.max(0, starts[i])), endTime: round3(Math.max(starts[i] + 0.1, ends[i])) };
  });
  return out;
}

/** True when any two caption windows overlap or sit closer than the gap. */
export function captionWindowsOverlap(a: CaptionWindow, b: CaptionWindow, gap = CAPTION_GAP_SECONDS): boolean {
  const [first, second] = a.startTime <= b.startTime ? [a, b] : [b, a];
  return second.startTime < first.endTime + gap - 1e-6 && second.endTime > first.startTime;
}

/** Count overlapping adjacent pairs among a project's caption items. */
export function countCaptionOverlaps(project: Project): number {
  const caps = project.items
    .filter((i): i is CaptionTimelineItem => i.type === 'caption')
    .sort((a, b) => a.startTime - b.startTime);
  let count = 0;
  for (let i = 0; i < caps.length - 1; i++) {
    if (captionWindowsOverlap(caps[i], caps[i + 1])) count++;
  }
  return count;
}

/**
 * Editor-path resolver (clamp variant): sort cues by start, clamp
 * each end to the next start minus the gap, and drop cues left under
 * the floor. Starts are never moved — the user's placement stands;
 * only the stacking is removed. Word timings are relative to their
 * cue, so clamping an end never desyncs its words.
 */
export function resolveProjectCaptionOverlaps(
  project: Project,
  gap = CAPTION_GAP_SECONDS,
): { project: Project; removedIds: string[]; clampedIds: string[] } {
  const caps = project.items
    .filter((i): i is CaptionTimelineItem => i.type === 'caption')
    .sort((a, b) => a.startTime - b.startTime || a.zIndex - b.zIndex);
  if (caps.length < 2) return { project, removedIds: [], clampedIds: [] };
  const removedIds: string[] = [];
  const clampedIds: string[] = [];
  let next: Project = project;
  for (let i = 0; i < caps.length; i++) {
    const cue = caps[i];
    const following = caps[i + 1];
    if (!following) break;
    const maxEnd = following.startTime - gap;
    if (cue.endTime > maxEnd) {
      if (maxEnd - cue.startTime < CAPTION_FLOOR_SECONDS) {
        removedIds.push(cue.id);
      } else {
        clampedIds.push(cue.id);
        const newEnd = round3(maxEnd);
        next = updateItem(next, cue.id, { endTime: newEnd });
        caps[i] = { ...cue, endTime: newEnd };
      }
    }
  }
  for (const id of removedIds) next = removeItem(next, id);
  return { project: next, removedIds, clampedIds };
}
