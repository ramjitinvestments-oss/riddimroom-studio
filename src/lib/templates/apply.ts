/**
 * Apply templates to a project (v2).
 *
 * FULL edits (`applyTemplateToProject`) restyle the open project against
 * the template's slot plan: captions take the template's caption style;
 * video/image clips, in timeline order, take the slots' motion effects in
 * order (the last slot's motion repeats if the project has more clips
 * than slots); every video/image/text item gets the template transition
 * as its entrance/exit; headline / sub / CTA / outro placeholder texts
 * are added only for roles the project doesn't already carry. Media,
 * timing, and ownership are never changed.
 *
 * HOOKS (`applyHookToProject`) insert the hook's text elements into the
 * open project at a caller-supplied time (the editor passes the
 * playhead): each element becomes a real text timeline item with its
 * kinetic-reveal / transition animation, the hook's caption style is
 * applied to existing captions, its motion effect is applied to media
 * playing under the hook window, and — when the hook declares one and a
 * PiP item is on screen — the PiP item gets the hook's end-transform
 * glide. Returns a new Project; the input is never mutated.
 */
import type { Project } from '../../types/timeline';
import { updateItem, getProjectDuration } from '../timeline/utils';
import { addTextItem } from '../timeline/insert';
import { isPipItem } from '../pip';
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

export function applyTemplateToProject(project: Project, template: StudioTemplate): Project {
  if (template.kind === 'hook') {
    // Hooks are insertion templates; applying one through the generic
    // path anchors it at the start of the project.
    return applyHookToProject(project, template, 0);
  }

  let next = applyCaptionStyle(project, template.captionStyleId);

  // Media clips in timeline order map onto the slot plan in order.
  const slots = template.slots ?? [];
  const mediaItems = next.items
    .filter((i) => i.type === 'video' || i.type === 'image')
    .slice()
    .sort((a, b) => a.startTime - b.startTime);
  const mediaMotionById = new Map<string, string>();
  mediaItems.forEach((item, index) => {
    const slotMotion = slots.length > 0 ? slots[Math.min(index, slots.length - 1)].motion : template.motion;
    mediaMotionById.set(item.id, slotMotion);
  });

  // Transitions on every visual/text item; motion per slot for media.
  for (const item of next.items) {
    if (item.type === 'video' || item.type === 'image' || item.type === 'text') {
      const patch: Record<string, unknown> = {
        animation: { entrance: template.transition as never, exit: template.transition as never, intensity: 1 },
      };
      if (item.type === 'video' || item.type === 'image') {
        const motion = mediaMotionById.get(item.id) ?? template.motion;
        patch.motion = motion === 'none' ? { type: 'none' } : { type: motion as never, intensity: 1 };
      }
      next = updateItem(next, item.id, patch);
    }
  }

  const duration = getProjectDuration(next);

  // Headline (only if the project has no title yet — the v1 rule).
  if (template.headlineText && !hasTextWithRole(next, 'title')) {
    next = addTextItem(next, {
      text: template.headlineText,
      atTime: Math.min(0.2, Math.max(0, duration * 0.05)),
      durationSeconds: slots[0]?.durationSeconds ?? 3,
      role: 'title',
      fontSize: 64,
      color: template.accentColor,
      position: { x: 50, y: 12 },
    });
  }
  // Sub line (only if the project has no subtitle yet).
  if (template.subText && !hasTextWithRole(next, 'subtitle')) {
    next = addTextItem(next, {
      text: template.subText,
      atTime: Math.min(0.4, Math.max(0, duration * 0.05)),
      durationSeconds: 3.5,
      role: 'subtitle',
      fontSize: 34,
      color: '#FFFFFF',
      position: { x: 50, y: 22 },
    });
  }
  // CTA near the end (skipped if identical text already exists).
  if (template.ctaText && !hasTextWithContent(next, template.ctaText)) {
    const ctaDuration = 3;
    next = addTextItem(next, {
      text: template.ctaText,
      atTime: Math.max(0, duration - ctaDuration),
      durationSeconds: ctaDuration,
      role: 'overlay',
      fontSize: 44,
      color: template.accentColor,
      position: { x: 50, y: 82 },
    });
  }
  // Outro / end card (skipped if identical text already exists).
  if (template.outroText && !hasTextWithContent(next, template.outroText)) {
    const outroDuration = 2.5;
    next = addTextItem(next, {
      text: template.outroText,
      atTime: Math.max(0, duration - outroDuration),
      durationSeconds: outroDuration,
      role: 'overlay',
      fontSize: 52,
      color: template.accentColor,
      position: { x: 50, y: 50 },
    });
  }
  return next;
}

export function applyHookToProject(project: Project, template: StudioTemplate, atTime: number): Project {
  if (template.kind !== 'hook' || !template.elements) return project;

  let next = applyCaptionStyle(project, template.captionStyleId);
  const start = Math.max(0, atTime);
  const hookEnd = start + template.durationSeconds;

  // Motion effect on media playing underneath the hook window.
  if (template.motion && template.motion !== 'none') {
    for (const item of next.items) {
      if ((item.type === 'video' || item.type === 'image') && item.startTime < hookEnd && item.endTime > start) {
        next = updateItem(next, item.id, { motion: { type: template.motion as never, intensity: 1 } });
      }
    }
  }

  // PiP glide: the first PiP item on screen during the hook gets the
  // hook's end transform (it animates there across its own span).
  if (template.pipEndTransform) {
    const pip = next.items.find((i) => isPipItem(i) && i.startTime < hookEnd && i.endTime > start);
    if (pip) {
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
