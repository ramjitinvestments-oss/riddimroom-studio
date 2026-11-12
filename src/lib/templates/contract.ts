/**
 * R42 Phase D — the living template contract.
 *
 * A full-template apply records `appliedTemplate` on the project
 * (lib/templates/apply.ts). This module is everything that keeps the
 * contract TRUE afterwards:
 *
 * - `fitAddedItem` — media added to the main track while a contract
 *   is active takes the next slot's treatment (trim/duration, motion,
 *   grade, frame crop, transitions), mirroring the apply's own math.
 *   The shell calls it inside the SAME mutate as the add itself, so
 *   add + fit is exactly one undo step, and announces the fit through
 *   the undo toast. PiP/overlay items are exempt by design (they are
 *   never slottable) — the Step 2 badge says so in plain words.
 * - `templateDrift` — DERIVES whether the reel still matches the
 *   recorded slot map (a slotted clip deleted, an untreated clip
 *   present, a mapping a fresh apply wouldn't produce). Nothing is
 *   written at delete/edit sites; the badge reads this and offers
 *   Re-apply. There is deliberately NO silent auto re-pack (D2b).
 * - `activeCaptionStyleId` — the style new captions should take:
 *   the contract template's style while one is active, else the
 *   project's prevailing cue style, else 'classic'. (Transcription
 *   used to hardcode 'classic' and silently overrode the template.)
 * - `releaseTemplate` — the explicit end of a contract.
 *
 * Pure `(project) => project` transforms throughout, like apply.ts.
 */
import type { Project, TimelineItem } from '../../types/timeline';
import { ASPECT_RATIO_OPTIONS } from '../aspectRatios';
import { getGradePreset } from '../grades';
import { resolveSourceDuration } from '../timeline/trimWindow';
import { updateItem } from '../timeline/utils';
import { getTemplate, type StudioTemplate } from '../templates';
import { computeFrameCrop, isSlottableMedia, slottableMediaInOrder, effectiveSlotsForClips } from './apply';
import { cameraPairItemIds, pairSafeMotionForType, pairSafeTransition } from './pairMotion';

/** A fresh, empty contract for a template (Dashboard's Start-from-a-template door). */
export function newTemplateContract(templateId: string, nowMs: number): Project['appliedTemplate'] {
  return { templateId, slotByItemId: {}, appliedAt: nowMs };
}

/** The template the project's contract names, when it still resolves. */
export function contractTemplate(project: Project): StudioTemplate | null {
  const id = project.appliedTemplate?.templateId;
  if (!id) return null;
  const template = getTemplate(id);
  return template && template.kind === 'full' ? template : null;
}

export interface ContractFitResult {
  project: Project;
  /** The fitted item's id (null when not fitted). */
  itemId: string | null;
  /** True when the item was actually fitted to a slot. */
  fitted: boolean;
  /** The slot index the item was fitted to (null when not fitted). */
  slotIndex: number | null;
  /** The slot's length in seconds (null when not fitted). */
  slotSeconds: number | null;
  /** True when a video's on-timeline duration shrank (Adjust-clips candidate). */
  shortened: boolean;
  /** True when the clip's source is shorter than the slot (the reel runs short — stated, never filled). */
  shortSource: boolean;
  /** The undo-toast announcement, when fitted. */
  announcement: string | null;
}

const NO_FIT: Omit<ContractFitResult, 'project'> = {
  itemId: null,
  fitted: false,
  slotIndex: null,
  slotSeconds: null,
  shortened: false,
  shortSource: false,
  announcement: null,
};

function formatSlotSeconds(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

/**
 * Fit ONE newly added item to the active contract. The item is
 * identified by id in the post-add project; its slot is its RUN
 * under the apply's slot-merge mapping (see effectiveSlotsForClips),
 * exactly as an apply would treat it.
 */
export function fitAddedItem(project: Project, itemId: string): ContractFitResult {
  const contract = project.appliedTemplate;
  const template = contractTemplate(project);
  if (!contract || !template || !template.slots || template.slots.length === 0) {
    return { project, ...NO_FIT };
  }
  const item = project.items.find((i) => i.id === itemId);
  if (!item || !isSlottableMedia(item)) return { project, ...NO_FIT };

  const slots = template.slots;
  const ordered = slottableMediaInOrder(project);
  const position = ordered.findIndex((i) => i.id === itemId);
  if (position < 0) return { project, ...NO_FIT };
  // The SAME slot-merge mapping the apply uses (apply.ts
  // effectiveSlotsForClips): the item's effective slot is its RUN —
  // consecutive slots merged when clips < slots, the last slot
  // repeated for extras. Fit, apply and drift must agree exactly:
  // the slot map records the run's firstSlotIndex, and templateDrift
  // compares against this same mapping, so a per-position fit here
  // would read as instant "moved" drift and would cut a lone clip
  // to slot 0 where an apply gives it the whole template.
  const effective = effectiveSlotsForClips(slots, ordered.length);
  const slot = effective[position];
  const slotIndex = slot.firstSlotIndex;

  const pairIds = cameraPairItemIds(project);
  const isPairItem = pairIds.has(item.id);

  const oldDuration = item.endTime - item.startTime;
  let newDuration = slot.durationSeconds;
  let trimStart: number | undefined;
  let trimEnd: number | undefined;
  let shortened = false;
  let shortSource = false;
  if (item.type === 'video') {
    const speed = item.speed > 0 ? item.speed : 1;
    const sourceDuration = resolveSourceDuration(item, project.mediaAssets[item.mediaAssetId]?.durationSeconds);
    const targetWindow = slot.durationSeconds * speed;
    let wStart = item.trimStart;
    let wEnd = wStart + targetWindow;
    if (wEnd > sourceDuration) {
      wEnd = sourceDuration;
      wStart = Math.max(0, wEnd - targetWindow);
    }
    if (wEnd - wStart < 0.05) {
      wStart = item.trimStart;
      wEnd = item.trimEnd;
    }
    trimStart = wStart;
    trimEnd = wEnd;
    newDuration = (wEnd - wStart) / speed;
    shortened = newDuration < oldDuration - 0.01;
    shortSource = sourceDuration < targetWindow - 0.01;
  }

  // Keep the pack: if the previous slottable item ends after this
  // item starts (an at-playhead add into a packed reel), the fitted
  // item begins where the reel actually ends.
  let startTime = item.startTime;
  const previous = position > 0 ? ordered[position - 1] : undefined;
  if (previous && startTime < previous.endTime - 0.001) {
    startTime = previous.endTime;
  }

  const rawEntrance = slot.transition ?? template.transition;
  const entrance = isPairItem ? pairSafeTransition(rawEntrance) : rawEntrance;
  // Exit mirrors the apply: into the NEXT run's entrance, or the
  // template default for the last item.
  const nextSlot = effective[position + 1];
  const rawExit = nextSlot ? (nextSlot.transition ?? template.transition) : template.transition;
  const exit = isPairItem ? pairSafeTransition(rawExit) : rawExit;
  const patch: Record<string, unknown> = {
    startTime,
    endTime: startTime + newDuration,
    animation: { entrance: entrance as never, exit: exit as never, intensity: 1 },
    motion: isPairItem
      ? pairSafeMotionForType(slot.motion)
      : slot.motion === 'none'
        ? { type: 'none' }
        : { type: slot.motion as never, intensity: 1 },
  };
  if (trimStart !== undefined) patch.trimStart = trimStart;
  if (trimEnd !== undefined) patch.trimEnd = trimEnd;

  const grade = getGradePreset(template.grade);
  if (grade) patch.colorGrade = { ...grade.grade };

  let framed = false;
  const frame = template.frame;
  if (frame && (item.type === 'video' || item.type === 'image')) {
    const dims = ASPECT_RATIO_OPTIONS.find((o) => o.id === frame.aspect);
    const asset = project.mediaAssets[item.mediaAssetId];
    if (dims && asset) {
      const crop = computeFrameCrop(asset.width ?? 0, asset.height ?? 0, dims.canvasWidth / dims.canvasHeight, item.type === 'video' ? 0.38 : 0.5);
      if (crop) {
        patch.crop = crop;
        framed = true;
      }
    }
    if (frame.stage === 'card') {
      patch.position = { x: 50, y: 44 };
      patch.scale = item.type === 'video' ? 0.84 : 3.36;
    }
  }

  let next = updateItem(project, item.id, patch);
  next = {
    ...next,
    appliedTemplate: {
      ...contract,
      slotByItemId: { ...contract.slotByItemId, [item.id]: slotIndex },
    },
  };

  const slotLabel = `${formatSlotSeconds(slot.durationSeconds)}s`;
  const parts: string[] = [];
  if (item.type === 'image') parts.push(`set to the ${slotLabel} slot`);
  else if (shortSource) parts.push(`shorter than the ${slotLabel} slot, so it stays whole`);
  else if (shortened) parts.push(`trimmed to the ${slotLabel} slot`);
  else parts.push(`fitted to the ${slotLabel} slot`);
  if (grade) parts.push('graded');
  if (framed) parts.push('framed');

  return {
    project: next,
    itemId: item.id,
    fitted: true,
    slotIndex,
    slotSeconds: slot.durationSeconds,
    shortened,
    shortSource,
    announcement: `Added to your template — ${parts.join(', ')}`,
  };
}

export interface TemplateDrift {
  /** A contract is recorded on the project. */
  active: boolean;
  /** The reel no longer matches the recorded slot map. */
  drifted: boolean;
  /** Item ids in the slot map that are no longer slottable media (deleted or converted). */
  missingItemIds: string[];
  /** Slottable item ids with no slot-map entry (added outside the contract fit). */
  unmappedItemIds: string[];
  /** Slottable item ids whose recorded slot differs from what a fresh apply would assign now. */
  movedItemIds: string[];
}

/**
 * Derive the contract's health from the stored slot map — no state
 * is written at delete/edit sites. "What a fresh apply would assign"
 * is computed with the same slot-merge mapping the apply uses.
 */
export function templateDrift(project: Project): TemplateDrift {
  const contract = project.appliedTemplate;
  if (!contract) {
    return { active: false, drifted: false, missingItemIds: [], unmappedItemIds: [], movedItemIds: [] };
  }
  const ordered = slottableMediaInOrder(project);
  const orderedIds = new Set(ordered.map((i) => i.id));
  const map = contract.slotByItemId;
  const missingItemIds = Object.keys(map).filter((id) => !orderedIds.has(id));
  const unmappedItemIds = ordered.filter((i) => !(i.id in map)).map((i) => i.id);
  const movedItemIds: string[] = [];
  const template = contractTemplate(project);
  if (template?.slots && template.slots.length > 0) {
    const effective = effectiveSlotsForClips(template.slots, ordered.length);
    ordered.forEach((item, index) => {
      if (item.id in map && map[item.id] !== effective[index].firstSlotIndex) {
        movedItemIds.push(item.id);
      }
    });
  }
  return {
    active: true,
    drifted: missingItemIds.length > 0 || unmappedItemIds.length > 0 || movedItemIds.length > 0,
    missingItemIds,
    unmappedItemIds,
    movedItemIds,
  };
}

/**
 * The caption style new cues should take in this project: the
 * contract template's style while a contract is active, else the
 * most recent existing cue's style, else 'classic'.
 */
export function activeCaptionStyleId(project: Project): string {
  const template = contractTemplate(project);
  if (template && template.captionStyleId) return template.captionStyleId;
  const cues = project.items
    .filter((i): i is Extract<TimelineItem, { type: 'caption' }> => i.type === 'caption')
    .slice()
    .sort((a, b) => a.startTime - b.startTime);
  const last = cues[cues.length - 1];
  return last ? last.captionStyleId : 'classic';
}

/** Release the contract: the template stops governing new adds. One undo step at the call site, like every contract action. */
export function releaseTemplate(project: Project): Project {
  if (!project.appliedTemplate) return project;
  const next = { ...project };
  delete next.appliedTemplate;
  return next;
}
