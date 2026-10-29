/**
 * Pair-safe motion cap for camera pairs (R32 Phase 3).
 *
 * A camera pair — the main clip plus the front-camera PiP placed
 * with it by `appendDualCaptureToTimeline` (dual and two-step flows
 * alike) — is recorded faces talking to camera. Aggressive template
 * motion on those items (punch-zoom slams, shakes, flashes, spins,
 * end-transform glides that balloon the PiP) looks wrong on faces
 * and fights the footage's own movement, so when a TEMPLATE applies
 * motion, pair items get a gentle treatment instead:
 *
 * - `item.motion` becomes product-focus at intensity 0.5 — by the
 *   compositor's own maths (`computeMotionAdjustment`: scale =
 *   1 + progress × 0.08 × intensity) that is a scale change of at
 *   most 4% across the whole clip, with no rotation, no offsets
 *   and only a whisper of vignette. That is the gentlest moving
 *   treatment the catalog can express: the intensity floor in the
 *   compositor is 0.5, and every other zoom effect starts at
 *   +8% scale or more even at that floor.
 * - Entrance/exit transitions are kept only when they are fades or
 *   dips (no displacement, no scale, no rotation); anything else
 *   (whip-pan, snap-zoom, spin, glitch, slide, pop…) becomes a
 *   plain 'fade'.
 * - A hook's PiP end-transform glide is SKIPPED for a pair PiP —
 *   the glide's job is to move/resize the overlay across the hook,
 *   which is exactly the aggressive move the cap exists to stop.
 *
 * IDENTIFYING A PAIR. The PiP half is explicit: `addPipOverlay`'s
 * camera path persists `pip.fromCamera: true` (R32 Phase 3), and
 * PiPs placed before that carry the legacy camera signal
 * `pip.fit: 'source'` (only camera placements ever set it — an
 * uploaded overlay never does). The main half is the non-PiP video
 * the PiP actually sits on, by the same greatest-overlap rule the
 * PiP swap uses (`findMainVideoForPip` in `lib/pip`): in the pair
 * placement that is the clip sharing the PiP's start time.
 *
 * SCOPE. This cap lives at the template application points in
 * `lib/templates/apply.ts` — the one place recipes/templates write
 * motion onto EXISTING timeline items. Promo recipe builders
 * (`lib/promo/recipes.ts`) never touch existing items at all (they
 * compose brand-new image items from artwork assets in a fresh
 * project), so there is no recipe-side path to cap. A user's own
 * manual motion pick in the item inspector is their choice and is
 * NOT capped — this only governs what a template does unasked.
 *
 * Pure functions, unit-tested; $0 rule: no dependencies.
 */

import type {
  AnimationPreset,
  MotionSettings,
  Project,
  TimelineItem,
  VideoTimelineItem,
} from '../../types/timeline';
import { findMainVideoForPip, isPipItem } from '../pip';

/** The gentle motion every capped pair item receives (see header for the ≤5% scale maths). */
export const PAIR_SAFE_MOTION: MotionSettings = { type: 'product-focus', intensity: 0.5 };

/**
 * True when a video item is a CAMERA PiP: placed from a camera
 * recording — the explicit persisted flag, or the legacy
 * source-fit signal older camera placements carry.
 */
export function isCameraPipItem(item: TimelineItem): item is VideoTimelineItem {
  return (
    item.type === 'video' &&
    isPipItem(item) &&
    (item.pip?.fromCamera === true || item.pip?.fit === 'source')
  );
}

/**
 * The main video a camera PiP belongs to: the pair placement starts
 * the PiP exactly ON its main clip's start, so an exact start-time
 * match (with real overlap) wins first; only when no item shares
 * the PiP's start (the user nudged/re-timed things afterwards)
 * does the greatest-overlap rule (`findMainVideoForPip`, the same
 * rule the PiP swap uses) decide.
 */
export function findPairMainVideo(project: Project, pipItem: VideoTimelineItem): VideoTimelineItem | null {
  const candidates = project.items.filter(
    (i): i is VideoTimelineItem => i.type === 'video' && !isPipItem(i),
  );
  const exactStart = candidates
    .filter((i) => Math.abs(i.startTime - pipItem.startTime) < 0.001 && i.endTime > pipItem.startTime)
    .sort((a, b) => a.zIndex - b.zIndex || a.startTime - b.startTime)[0];
  return exactStart ?? findMainVideoForPip(project, pipItem);
}

/**
 * The ids of every camera-pair member in the project: each camera
 * PiP plus the main video it sits on. A camera PiP with no main
 * video under it still caps itself (it is a recorded face either
 * way); a project with no camera PiP has no pair members at all.
 * Callers that transform the project (template applies re-pack
 * timing!) should compute this on the INCOMING project, before any
 * retiming can blur which clip the PiP belongs to.
 */
export function cameraPairItemIds(project: Project): Set<string> {
  const ids = new Set<string>();
  for (const item of project.items) {
    if (!isCameraPipItem(item)) continue;
    ids.add(item.id);
    const main = findPairMainVideo(project, item);
    if (main) ids.add(main.id);
  }
  return ids;
}

/** True when `item` belongs to a camera pair in `project`. */
export function isCameraPairItem(project: Project, item: TimelineItem): boolean {
  return cameraPairItemIds(project).has(item.id);
}

/**
 * The pair-safe version of a template's requested motion: 'none'
 * (or no request) stays none; anything else becomes the gentle
 * PAIR_SAFE_MOTION — never the requested slam/whip/shake/zoom.
 * The requested direction/tour stops are dropped with the type.
 */
export function pairSafeMotion(requested: MotionSettings | undefined): MotionSettings {
  if (!requested || requested.type === 'none') return { type: 'none' };
  return { ...PAIR_SAFE_MOTION };
}

/** String-typed variant for the template apply loop's slot/template motion ids. */
export function pairSafeMotionForType(motionType: string | undefined): MotionSettings {
  if (!motionType || motionType === 'none') return { type: 'none' };
  return { ...PAIR_SAFE_MOTION };
}

/**
 * Transitions a pair item may keep: fades and dips only — pure
 * opacity/colour moves with no displacement, scale or rotation in
 * the compositor's entrance/exit maths.
 */
export const PAIR_SAFE_TRANSITIONS: readonly string[] = [
  'none',
  'fade',
  'film-dissolve',
  'luma-fade',
  'dip-to-black',
  'dip-to-white',
  'dip-to-gold',
];

/**
 * The pair-safe entrance/exit for a template transition: a gentle
 * transition survives as-is; anything with displacement, scale,
 * rotation or strobe becomes a plain fade.
 */
export function pairSafeTransition(transition: string): AnimationPreset {
  return (PAIR_SAFE_TRANSITIONS.includes(transition) ? transition : 'fade') as AnimationPreset;
}
