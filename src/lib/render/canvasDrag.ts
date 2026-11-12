import type { Project, TimelineItem } from '../../types/timeline';
import { updateItem } from '../timeline/utils';

/**
 * R44 Phase C (SF-3) — on-canvas drag geometry + preview application.
 *
 * The canvas drag used to call the project store's `mutate()` on EVERY
 * pointer move (a new project object + a shell re-render per move — the
 * jerkiest gesture in the app, per AUDIT-R43 §2.2). The timeline got
 * the R26 treatment long ago: pure math + a local preview during the
 * gesture, ONE commit on release. This module is that same pattern for
 * the canvas, structured so parity is provable by construction:
 *
 * - `moveDragPosition` / `resizeDragScale` are the ONLY implementations
 *   of the drag math (extracted verbatim from the old per-move mutate
 *   handlers — same clamps, same formula).
 * - During a gesture, PreviewPane stores the resulting
 *   `CanvasDragPreview` locally and its tick draws
 *   `applyCanvasDragPreview(project, preview)` through the shared
 *   `drawFrame` — the user sees the real compositor's output at the
 *   preview geometry, not a DOM approximation.
 * - On release, PreviewPane commits with the SAME
 *   `applyCanvasDragPreview` over the SAME final preview value, so the
 *   committed item geometry is exactly the geometry the last preview
 *   frame showed. `canvasDrag.test.ts` pins this end to end.
 */
export interface CanvasDragPreview {
  itemId: string;
  position?: { x: number; y: number };
  scale?: number;
}

/** Move-drag position (percent), clamped to the canvas — verbatim math. */
export function moveDragPosition(
  originalX: number,
  originalY: number,
  dxPercent: number,
  dyPercent: number,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(100, originalX + dxPercent)),
    y: Math.max(0, Math.min(100, originalY + dyPercent)),
  };
}

/** Resize-drag scale from the pointer's distance to the item centre — verbatim math. */
export function resizeDragScale(
  originalScale: number,
  centerXPercent: number,
  originalWidthPercent: number,
  pointerXPercent: number,
): number {
  const newWidthPercent = Math.abs(pointerXPercent - centerXPercent) * 2;
  return Math.max(0.05, Math.min(5, originalScale * (newWidthPercent / Math.max(0.5, originalWidthPercent))));
}

/** The item as the drag preview shows it (used for the selection box). */
export function itemWithDragPreview<T extends TimelineItem>(item: T, preview: CanvasDragPreview | null): T {
  if (!preview || preview.itemId !== item.id) return item;
  const next = { ...item } as T & { position?: { x: number; y: number }; scale?: number };
  if (preview.position && 'position' in item) next.position = { ...preview.position };
  if (preview.scale !== undefined) next.scale = preview.scale;
  return next;
}

/**
 * The project as the drag preview shows it — used BOTH by the preview
 * tick (to draw the gesture) and by the release commit (to write it),
 * which is what makes the committed geometry identical to the shown
 * geometry by construction.
 */
export function applyCanvasDragPreview(project: Project, preview: CanvasDragPreview): Project {
  const patch: Record<string, unknown> = {};
  if (preview.position) patch.position = { ...preview.position };
  if (preview.scale !== undefined) patch.scale = preview.scale;
  if (Object.keys(patch).length === 0) return project;
  return updateItem(project, preview.itemId, patch);
}
