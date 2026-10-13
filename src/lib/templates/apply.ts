/**
 * Apply a curated template to a project (v1).
 * Sets caption styles, entrance/exit transitions, motion, and adds a
 * title text item when the template has one. Never touches media,
 * timing, or ownership. Returns a new Project.
 */
import type { Project } from '../../types/timeline';
import { updateItem, getProjectDuration } from '../timeline/utils';
import { addTextItem } from '../timeline/insert';
import type { StudioTemplate } from '../templates';

export function applyTemplateToProject(project: Project, template: StudioTemplate): Project {
  let next = project;
  // Captions -> template style.
  for (const item of next.items) {
    if (item.type === 'caption' && item.captionStyleId !== template.captionStyleId) {
      next = updateItem(next, item.id, { captionStyleId: template.captionStyleId });
    }
  }
  // Video/image/text -> template transition + motion (motion only for video/image).
  for (const item of next.items) {
    if (item.type === 'video' || item.type === 'image' || item.type === 'text') {
      const patch: Record<string, unknown> = {
        animation: { entrance: template.transition as never, exit: template.transition as never, intensity: 1 },
      };
      if (item.type === 'video' || item.type === 'image') {
        patch.motion = template.motion === 'none' ? { type: 'none' } : { type: template.motion as never, intensity: 1 };
      }
      next = updateItem(next, item.id, patch);
    }
  }
  // Title text (only if template has one and project has no title yet).
  if (template.titleText) {
    const hasTitle = next.items.some((i) => i.type === 'text' && i.role === 'title');
    if (!hasTitle) {
      const atTime = Math.min(0.2, Math.max(0, getProjectDuration(next) * 0.05));
      next = addTextItem(next, {
        text: template.titleText,
        atTime,
        durationSeconds: 2.5,
        role: 'title',
        fontSize: 64,
        color: template.accentColor,
        position: { x: 50, y: 12 },
      });
    }
  }
  return next;
}
