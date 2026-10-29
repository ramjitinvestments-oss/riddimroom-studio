/**
 * Apply templates to a project (v3).
 *
 * FULL edits (`applyTemplateToProject` / `applyFullTemplate`) — v3 makes
 * the slot plan REAL. On top of everything v2 did (caption restyle,
 * per-slot motion effects, the template transition on entrances/exits,
 * headline / sub / CTA / outro placeholder texts), applying a full
 * template now:
 *
 * - SLOT TRIMS: the project's main-track media (non-PiP videos, `photo`
 *   images — in timeline order) is mapped onto the slots; each item is
 *   REDUCED to its slot's size. A video's trim window becomes the slot
 *   length (× its speed, since timeline duration = window ÷ speed),
 *   anchored at its current `trimStart`, shifted back when that would
 *   overrun the source, or the full source when the source is shorter
 *   than the slot. An image's duration is set to the slot exactly.
 *   Items beyond the slot count take the LAST slot's size + treatment.
 *   The slotted items are then RE-PACKED contiguously from the first
 *   item's start — the reel is back-to-back, no gaps. Overlay/PiP,
 *   audio, caption, and pre-existing text items are never retimed.
 * - GRADES: the template's `grade` preset (lib/grades.ts) is written as
 *   `colorGrade` values onto the slotted items.
 * - MUSIC: when the template suggests a built-in loop, the project has
 *   no music item yet, and the caller supplies the rendered loop asset
 *   (`options.loopAsset` — the panel renders/uploads it through the
 *   MusicPanel path first, keeping this function pure), the loop is
 *   added at the reel start and fitted to the reel length with the same
 *   math as the Music panel's fit helpers: trimmed when the reel fits
 *   inside the loop, `loop: true` when it must repeat, with the standard
 *   0.5s fitted fade-out. Existing music is never touched.
 * - TEXT ANCHORS: the placeholder texts apply adds anchor to the NEW
 *   packed timing — headline/sub at the reel start, CTA/outro at the
 *   reel end.
 *
 * The whole apply is a single pure `(project) => project` transform, so
 * the panel's one `mutate` call keeps it exactly ONE undo step.
 *
 * HOOKS (`applyHookToProject`) are unchanged from v2: insertion of the
 * hook's text elements at a caller-supplied time, caption restyle,
 * motion on media underneath, and the optional PiP end-transform glide.
 * Returns a new Project; the input is never mutated.
 */
import type { AudioTimelineItem, CropSettings, MediaAsset, Project, TimelineItem } from '../../types/timeline';
import { ASPECT_RATIO_OPTIONS } from '../aspectRatios';

/** Canvas dims for a frame aspect id, from the app's canonical ratio table. */
function frameCanvasDims(aspect: string): { width: number; height: number } | null {
  const opt = ASPECT_RATIO_OPTIONS.find((o) => o.id === aspect);
  return opt ? { width: opt.canvasWidth, height: opt.canvasHeight } : null;
}
import {
  addItem,
  addMediaAsset,
  generateTimelineId,
  getProjectDuration,
  getTracksByType,
  updateItem,
  FIT_FADE_OUT_SECONDS,
} from '../timeline/utils';
import { addTextItem } from '../timeline/insert';
import { resolveSourceDuration } from '../timeline/trimWindow';
import { isPipItem } from '../pip';
import { cameraPairItemIds, pairSafeMotionForType, pairSafeTransition } from './pairMotion';
import { getGradePreset } from '../grades';
import { MAX_FADE_SECONDS } from '../media/constants';
import type { StudioTemplate } from '../templates';

function applyCaptionStyle(project: Project, captionStyleId: string): Project {
  if (!captionStyleId) return project;
  let next = project;
  for (const item of next.items) {
    if (item.type === 'caption' && item.captionStyleId !== captionStyleId) {
      next = updateItem(next, item.id, { captionStyleId });
    }
  }
  return next;
}

function hasTextWithRole(project: Project, role: string): boolean {
  return project.items.some((i) => i.type === 'text' && i.role === role);
}

function hasTextWithContent(project: Project, text: string): boolean {
  return project.items.some((i) => i.type === 'text' && i.text === text);
}

/** addTextItem doesn't return the new item's id — recover it by diffing item ids. */
function addTextItemWithAnimation(
  project: Project,
  options: Parameters<typeof addTextItem>[1],
  animation?: { entrance: string; exit?: string },
): Project {
  const beforeIds = new Set(project.items.map((i) => i.id));
  let next = addTextItem(project, options);
  if (animation) {
    const added = next.items.find((i) => !beforeIds.has(i.id));
    if (added) {
      next = updateItem(next, added.id, {
        animation: { entrance: animation.entrance as never, exit: (animation.exit ?? 'none') as never, intensity: 1 },
      });
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Full templates (v3)
// ---------------------------------------------------------------------------

export interface ApplyFullTemplateOptions {
  /**
   * The template's suggested built-in loop, already rendered + uploaded
   * by the caller into a real `MediaAsset` (the MusicPanel path). The
   * apply stays pure — it never renders or uploads — so without this
   * option (or when the project already has music) no audio is added.
   */
  loopAsset?: MediaAsset;
  /**
   * v9 — when the template has a FRAME whose aspect differs from the
   * project's canvas, switch the project's canvas to the frame's aspect
   * as part of the apply (positions are percentage-based, so items keep
   * their places; still one undo). The panel offers this explicitly
   * before applying; without it the frame crops still apply, computed
   * against the frame aspect inside the current canvas.
   */
  switchToFrame?: boolean;
}

/**
 * v9 — the source crop window that frames a (srcW × srcH) source at
 * `targetAspect` (width ÷ height): the largest window of that aspect
 * inside the source, centred horizontally; vertically, the window's
 * centre sits at `biasY` of the source height (0.5 = centred; videos
 * use 0.38 — faces live in the upper frame). Returns undefined when the
 * source already matches the target (nothing to crop). Percentages, 2dp.
 */
export function computeFrameCrop(
  srcW: number,
  srcH: number,
  targetAspect: number,
  biasY = 0.5,
): CropSettings | undefined {
  if (!(srcW > 0 && srcH > 0 && targetAspect > 0)) return undefined;
  const srcAspect = srcW / srcH;
  if (Math.abs(srcAspect - targetAspect) / targetAspect < 0.01) return undefined;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  if (srcAspect > targetAspect) {
    const width = (targetAspect / srcAspect) * 100;
    return { x: round2((100 - width) / 2), y: 0, width: round2(width), height: 100 };
  }
  const height = (srcAspect / targetAspect) * 100;
  const y = Math.min(100 - height, Math.max(0, biasY * 100 - height / 2));
  return { x: 0, y: round2(y), width: 100, height: round2(height) };
}

export interface ShortenedClipInfo {
  itemId: string;
  fileName: string;
}

export interface ApplyFullTemplateResult {
  project: Project;
  /** Video clips whose on-timeline duration shrank — the panel offers these in the post-apply "Adjust clips" crop step. */
  shortenedClips: ShortenedClipInfo[];
  /** Packed reel span of the slotted items (0/0 when the project had no slottable media). */
  reelStartSeconds: number;
  reelEndSeconds: number;
  /** True when the template's suggested loop was auto-added + fitted. */
  musicAdded: boolean;
  /** v9 — true when the project's canvas was switched to the template's frame aspect. */
  canvasSwitched: boolean;
  /** v9 — items that received a frame crop (the panel offers each a Reframe step). */
  framedItems: ShortenedClipInfo[];
}

/** Main-track media for slotting: full-frame videos (not PiP overlays) and `photo` images (not overlay/watermark/logo images). */
function isSlottableMedia(item: TimelineItem): boolean {
  if (item.type === 'video') return !isPipItem(item);
  if (item.type === 'image') return item.role === 'photo';
  return false;
}

interface SlotPlan {
  itemId: string;
  startTime: number;
  endTime: number;
  trimStart?: number;
  trimEnd?: number;
  motion: string;
  /** Raw transition preset id INTO this item (before pair-safe wrapping). */
  entranceTransition: string;
  /** Raw transition preset id OUT of this item (before pair-safe wrapping) — the next slot's entrance, or the template default for the last slotted item. */
  exitTransition: string;
  /** True when a video's duration shrank (crop-picker candidate). */
  shortened: boolean;
}

export function applyFullTemplate(
  project: Project,
  template: StudioTemplate,
  options: ApplyFullTemplateOptions = {},
): ApplyFullTemplateResult {
  const slots = template.slots ?? [];
  // R32 Phase 3 — camera-pair membership is read from the INCOMING
  // project, before the slot pass re-packs timing (after a re-pack,
  // overlap alone can point a PiP at the wrong "main" clip).
  const pairIds = cameraPairItemIds(project);
  let next = applyCaptionStyle(project, template.captionStyleId);

  // ── v9 FRAME: optionally switch the canvas to the template's frame
  // aspect first (positions/scales are percentage-based, so the project
  // survives the switch intact). ──
  let canvasSwitched = false;
  const frame = template.frame;
  if (frame && options.switchToFrame) {
    const target = frameCanvasDims(frame.aspect);
    if (target && (next.canvasWidth !== target.width || next.canvasHeight !== target.height)) {
      next = { ...next, canvasWidth: target.width, canvasHeight: target.height };
      canvasSwitched = true;
    }
  }

  // ── Slot mapping: durations first (they decide the packed timing). ──
  // Timeline order = startTime; ties (a clip and a photo both starting
  // at 0 on their parallel tracks) break by track order — the video
  // track stacks above the image track, so the clip reads first — then
  // zIndex, then id for full determinism.
  const trackOrder = new Map(next.tracks.map((t, i) => [t.id, i]));
  const slotted = next.items
    .filter(isSlottableMedia)
    .slice()
    .sort(
      (a, b) =>
        a.startTime - b.startTime ||
        (trackOrder.get(a.trackId) ?? 0) - (trackOrder.get(b.trackId) ?? 0) ||
        a.zIndex - b.zIndex ||
        (a.id < b.id ? -1 : 1),
    );

  const plans: SlotPlan[] = [];
  let reelStart = 0;
  let reelEnd = 0;
  if (slotted.length > 0 && slots.length > 0) {
    reelStart = slotted[0].startTime;
    let cursor = reelStart;
    slotted.forEach((item, index) => {
      const slot = slots[Math.min(index, slots.length - 1)];
      const oldDuration = item.endTime - item.startTime;
      let newDuration = slot.durationSeconds;
      let trimStart: number | undefined;
      let trimEnd: number | undefined;
      let shortened = false;
      if (item.type === 'video') {
        // Timeline duration = source window ÷ speed — the window must
        // span slot × speed source seconds to land on the slot length.
        const speed = item.speed > 0 ? item.speed : 1;
        const sourceDuration = resolveSourceDuration(item, next.mediaAssets[item.mediaAssetId]?.durationSeconds);
        const targetWindow = slot.durationSeconds * speed;
        let wStart = item.trimStart;
        let wEnd = wStart + targetWindow;
        if (wEnd > sourceDuration) {
          // Anchored window overruns the source: shift it back to end
          // at the source end (or span the whole source when the source
          // is shorter than the slot).
          wEnd = sourceDuration;
          wStart = Math.max(0, wEnd - targetWindow);
        }
        if (wEnd - wStart < 0.05) {
          // Degenerate window (corrupt trim data) — keep the item's
          // current window rather than collapsing it to nothing.
          wStart = item.trimStart;
          wEnd = item.trimEnd;
        }
        trimStart = wStart;
        trimEnd = wEnd;
        newDuration = (wEnd - wStart) / speed;
        shortened = newDuration < oldDuration - 0.01;
      }
      plans.push({
        itemId: item.id,
        startTime: cursor,
        endTime: cursor + newDuration,
        trimStart,
        trimEnd,
        motion: slot.motion,
        entranceTransition: slot.transition ?? template.transition,
        exitTransition:
          index + 1 < slotted.length
            ? (slots[Math.min(index + 1, slots.length - 1)].transition ?? template.transition)
            : template.transition,
        shortened,
      });
      cursor += newDuration;
    });
    reelEnd = cursor;

    // Commit the timing (trim windows + packed positions) in one pass.
    for (const plan of plans) {
      const patch: Record<string, unknown> = { startTime: plan.startTime, endTime: plan.endTime };
      if (plan.trimStart !== undefined) patch.trimStart = plan.trimStart;
      if (plan.trimEnd !== undefined) patch.trimEnd = plan.trimEnd;
      next = updateItem(next, plan.itemId, patch);
    }
  }
  const planById = new Map(plans.map((p) => [p.itemId, p]));
  const shortenedClips: ShortenedClipInfo[] = plans
    .filter((p) => p.shortened)
    .map((p) => {
      const item = next.items.find((i) => i.id === p.itemId);
      const asset = item && 'mediaAssetId' in item ? next.mediaAssets[item.mediaAssetId] : undefined;
      return { itemId: p.itemId, fileName: asset?.fileName ?? 'Clip' };
    });

  // ── Transitions on every visual/text item; motion per slot for the
  // slotted media (template default for other media). v9: the GRADE now
  // goes on EVERY video/photo (not just slotted items — the preset look
  // must be uniform across the whole video), every non-PiP video and
  // photo is CROPPED TO THE TEMPLATE'S FRAME, and 'card'-stage heroes
  // take their inset stage placement. ──
  const grade = getGradePreset(template.grade);
  const frameDims = frame ? frameCanvasDims(frame.aspect) : null;
  const frameAspectNumber = frameDims ? frameDims.width / frameDims.height : 0;
  const framedItems: ShortenedClipInfo[] = [];
  // R32 Phase 3 — camera-pair members (main clip + its camera PiP,
  // identified above from the incoming project) are motion-capped:
  // gentle motion only, fade-class transitions only (see
  // lib/templates/pairMotion for the rules + maths).
  for (const item of next.items) {
    if (item.type === 'video' || item.type === 'image' || item.type === 'text') {
      const isPairItem = pairIds.has(item.id);
      const planForAnimation = planById.get(item.id);
      const rawEntrance = planForAnimation ? planForAnimation.entranceTransition : template.transition;
      const rawExit = planForAnimation ? planForAnimation.exitTransition : template.transition;
      const entrance = isPairItem ? pairSafeTransition(rawEntrance) : rawEntrance;
      const exit = isPairItem ? pairSafeTransition(rawExit) : rawExit;
      const patch: Record<string, unknown> = {
        animation: { entrance: entrance as never, exit: exit as never, intensity: 1 },
      };
      if (item.type === 'video' || item.type === 'image') {
        const plan = planById.get(item.id);
        const motion = plan ? plan.motion : template.motion;
        patch.motion = isPairItem
          ? pairSafeMotionForType(motion)
          : motion === 'none'
            ? { type: 'none' }
            : { type: motion as never, intensity: 1 };
        if (grade) patch.colorGrade = { ...grade.grade };
        // Frame crop: main-stage media only — PiP overlays keep their
        // own framing by design. Needs the source's real dimensions;
        // without them the renderer's cover-fit still applies.
        const isMainStage = item.type === 'video' ? !isPipItem(item) : item.role === 'photo';
        if (frame && isMainStage) {
          const asset = next.mediaAssets[item.mediaAssetId];
          const crop = computeFrameCrop(
            asset?.width ?? 0,
            asset?.height ?? 0,
            frameAspectNumber,
            item.type === 'video' ? 0.38 : 0.5,
          );
          if (crop) {
            patch.crop = crop;
            framedItems.push({ itemId: item.id, fileName: asset?.fileName ?? 'Clip' });
          }
          // Card stage: slotted heroes sit as an inset card (84% wide,
          // centred slightly high). Videos scale against the canvas;
          // images scale against their 0.25-canvas base width.
          if (plan && frame.stage === 'card') {
            patch.position = { x: 50, y: 44 };
            patch.scale = item.type === 'video' ? 0.84 : 3.36;
          }
        }
      }
      next = updateItem(next, item.id, patch);
    }
  }

  // ── Music: auto-add the suggested loop, fitted to the reel — only
  // when the project has no music item yet and the caller supplied the
  // rendered asset. Mirrors the Music panel fit helpers' math (trim
  // when the reel fits in the loop, loop when it must repeat, standard
  // fitted fade-out), targeted at the reel rather than the whole
  // project so unretimed captions/text past the reel can't stretch it. ──
  let musicAdded = false;
  const hasReel = plans.length > 0 && reelEnd > reelStart;
  const hasMusic = next.items.some((i) => i.type === 'audio' && i.role === 'music');
  if (template.suggestedLoopId && options.loopAsset && options.loopAsset.kind === 'audio' && !hasMusic && hasReel) {
    const audioTrack = getTracksByType(next, 'audio')[0];
    if (audioTrack) {
      const asset = options.loopAsset;
      const sourceDuration =
        typeof asset.durationSeconds === 'number' && Number.isFinite(asset.durationSeconds) && asset.durationSeconds > 0
          ? asset.durationSeconds
          : reelEnd - reelStart;
      const reelDuration = reelEnd - reelStart;
      const loops = reelDuration > sourceDuration;
      const item: AudioTimelineItem = {
        id: generateTimelineId('item'),
        type: 'audio',
        trackId: audioTrack.id,
        startTime: reelStart,
        endTime: reelEnd,
        zIndex: next.items.reduce((m, i) => Math.max(m, i.zIndex), -1) + 1,
        visible: true,
        mediaAssetId: asset.id,
        role: 'music',
        volume: 1,
        muted: false,
        trimStart: 0,
        trimEnd: loops ? sourceDuration : reelDuration,
        fade: {
          fadeInDuration: 0,
          fadeOutDuration: Math.min(FIT_FADE_OUT_SECONDS, MAX_FADE_SECONDS, reelDuration),
        },
        ...(loops ? { loop: true } : {}),
      };
      next = addItem(addMediaAsset(next, asset), item);
      musicAdded = true;
    }
  }

  // ── Placeholder texts, anchored to the (possibly new) reel timing. ──
  // R36 consumer note: `getProjectDuration` follows the longest-video
  // law automatically, so when there is no reel the CTA/outro anchors
  // below land on the piece's real export end — including a tail a
  // pre-existing PiP/overlay video creates — matching the exporters.
  const duration = getProjectDuration(next);
  const anchorBase = hasReel ? reelStart : 0;
  const endAnchor = hasReel ? reelEnd : duration;

  if (template.headlineText && !hasTextWithRole(next, 'title')) {
    next = addTextItem(next, {
      text: template.headlineText,
      atTime: anchorBase + Math.min(0.2, Math.max(0, (endAnchor - anchorBase) * 0.05)),
      durationSeconds: plans[0] ? plans[0].endTime - plans[0].startTime : slots[0]?.durationSeconds ?? 3,
      role: 'title',
      fontSize: 64,
      color: template.accentColor,
      position: { x: 50, y: 12 },
    });
  }
  if (template.subText && !hasTextWithRole(next, 'subtitle')) {
    next = addTextItem(next, {
      text: template.subText,
      atTime: anchorBase + Math.min(0.4, Math.max(0, (endAnchor - anchorBase) * 0.05)),
      durationSeconds: 3.5,
      role: 'subtitle',
      fontSize: 34,
      color: '#FFFFFF',
      position: { x: 50, y: 22 },
    });
  }
  if (template.ctaText && !hasTextWithContent(next, template.ctaText)) {
    const ctaDuration = 3;
    next = addTextItem(next, {
      text: template.ctaText,
      atTime: Math.max(anchorBase, endAnchor - ctaDuration),
      durationSeconds: ctaDuration,
      role: 'overlay',
      fontSize: 44,
      color: template.accentColor,
      position: { x: 50, y: 82 },
    });
  }
  if (template.outroText && !hasTextWithContent(next, template.outroText)) {
    const outroDuration = 2.5;
    next = addTextItem(next, {
      text: template.outroText,
      atTime: Math.max(anchorBase, endAnchor - outroDuration),
      durationSeconds: outroDuration,
      role: 'overlay',
      fontSize: 52,
      color: template.accentColor,
      position: { x: 50, y: 50 },
    });
  }

  return { project: next, shortenedClips, reelStartSeconds: reelStart, reelEndSeconds: reelEnd, musicAdded, canvasSwitched, framedItems };
}

export function applyTemplateToProject(
  project: Project,
  template: StudioTemplate,
  options: ApplyFullTemplateOptions = {},
): Project {
  if (template.kind === 'hook') {
    // Hooks are insertion templates; applying one through the generic
    // path anchors it at the start of the project.
    return applyHookToProject(project, template, 0);
  }
  return applyFullTemplate(project, template, options).project;
}

export function applyHookToProject(project: Project, template: StudioTemplate, atTime: number): Project {
  if (template.kind !== 'hook' || !template.elements) return project;

  let next = applyCaptionStyle(project, template.captionStyleId);
  const start = Math.max(0, atTime);
  const hookEnd = start + template.durationSeconds;

  // R32 Phase 3 — camera-pair members under the hook are motion-
  // capped exactly as in a full-template apply (see pairMotion).
  const pairIds = cameraPairItemIds(next);

  // Motion effect on media playing underneath the hook window.
  if (template.motion && template.motion !== 'none') {
    for (const item of next.items) {
      if ((item.type === 'video' || item.type === 'image') && item.startTime < hookEnd && item.endTime > start) {
        next = updateItem(next, item.id, {
          motion: pairIds.has(item.id)
            ? pairSafeMotionForType(template.motion)
            : { type: template.motion as never, intensity: 1 },
        });
      }
    }
  }

  // PiP glide: the first PiP item on screen during the hook gets the
  // hook's end transform (it animates there across its own span).
  // A camera-pair PiP is skipped — the glide would move/resize a
  // recorded face, which is what the pair-safe cap exists to stop.
  if (template.pipEndTransform) {
    const pip = next.items.find((i) => isPipItem(i) && i.startTime < hookEnd && i.endTime > start);
    if (pip && !pairIds.has(pip.id)) {
      next = updateItem(next, pip.id, { endTransform: template.pipEndTransform });
    }
  }

  // The hook's text elements, offset from the insertion point.
  for (const el of template.elements) {
    next = addTextItemWithAnimation(
      next,
      {
        text: el.text,
        atTime: start + el.offsetSeconds,
        durationSeconds: el.durationSeconds,
        role: el.role,
        fontSize: el.fontSize,
        color: el.color,
        position: el.position,
      },
      { entrance: el.entrance, exit: el.exit },
    );
  }
  return next;
}
