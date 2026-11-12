/**
 * R44 Phase C (SF-3) — canvas drag parity gate.
 *
 * The claim being pinned: the geometry the user SEES during an on-canvas
 * drag (the preview tick draws `applyCanvasDragPreview(project, preview)`
 * through drawFrame, and the selection box is computed from
 * `itemWithDragPreview`) is EXACTLY the geometry the single release
 * commit writes (`mutate(p => applyCanvasDragPreview(p, preview))` over
 * the same final preview value). One function, one input, two consumers
 * — parity by construction, verified here end to end over scripted
 * gesture streams, plus the verbatim drag math (clamps/formula) that was
 * extracted from the old per-move mutate handlers.
 */
import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../projects/persistence';
import { addItem, generateTimelineId } from '../timeline/utils';
import {
  applyCanvasDragPreview,
  itemWithDragPreview,
  moveDragPosition,
  resizeDragScale,
  type CanvasDragPreview,
} from './canvasDrag';
import type { Project, VideoTimelineItem } from '../../types/timeline';

function projectWithItem(): { project: Project; item: VideoTimelineItem } {
  let project = createDefaultProject('owner-1');
  const track = project.tracks.find((t) => t.type === 'video')!;
  const item = {
    id: generateTimelineId('item'),
    type: 'video',
    trackId: track.id,
    assetId: 'asset-1',
    name: 'clip',
    startTime: 0,
    endTime: 4,
    trimStart: 0,
    trimEnd: 4,
    position: { x: 50, y: 50 },
    scale: 1,
  } as unknown as VideoTimelineItem;
  project = addItem(project, item);
  return { project, item };
}

describe('SF-3 drag math — verbatim from the old mutate-per-move handlers', () => {
  it('move: percent deltas added to the original position, clamped 0..100', () => {
    expect(moveDragPosition(50, 50, 10, -20)).toEqual({ x: 60, y: 30 });
    expect(moveDragPosition(95, 5, 40, -40)).toEqual({ x: 100, y: 0 });
    expect(moveDragPosition(5, 95, -40, 40)).toEqual({ x: 0, y: 100 });
    expect(moveDragPosition(50, 50, 0, 0)).toEqual({ x: 50, y: 50 });
  });

  it('resize: width from pointer distance to centre, scale clamped 0.05..5', () => {
    // Pointer at centre + half the original width → same scale.
    expect(resizeDragScale(1, 50, 40, 70)).toBeCloseTo(1, 10);
    // Pointer twice as far → double width → double scale.
    expect(resizeDragScale(1, 50, 40, 90)).toBeCloseTo(2, 10);
    // Pointer on the centre → width 0 → floor clamp.
    expect(resizeDragScale(1, 50, 40, 50)).toBe(0.05);
    // Huge drag → ceiling clamp.
    expect(resizeDragScale(2, 50, 10, 100)).toBe(5);
    // Degenerate original width is floored at 0.5 like the old code
    // (width 20 / 0.5 = 40x → ceiling clamp).
    expect(resizeDragScale(1, 50, 0, 60)).toBe(5);
  });
});

describe('SF-3 parity — shown geometry === committed geometry', () => {
  it('a scripted move gesture: every intermediate preview, applied, equals the shown item; the release commit equals the final preview', () => {
    const { project, item } = projectWithItem();
    // Pointer stream in container-percent deltas from the grab point.
    const stream: Array<[number, number]> = [[2, 1], [9, -4], [23, 12], [61, 30], [-80, -90], [15, 15]];
    let finalPreview: CanvasDragPreview | null = null;
    for (const [dx, dy] of stream) {
      const preview: CanvasDragPreview = { itemId: item.id, position: moveDragPosition(50, 50, dx, dy) };
      finalPreview = preview;
      // What the tick draws / the box shows at this step:
      const shown = itemWithDragPreview(item, preview);
      // What a commit of this step would write:
      const committed = applyCanvasDragPreview(project, preview).items.find((i) => i.id === item.id) as VideoTimelineItem;
      expect(committed.position).toEqual(shown.position);
      expect(committed.position).toEqual(preview.position);
    }
    // Release: one commit over the final preview — the stored item is the shown item.
    const released = applyCanvasDragPreview(project, finalPreview!);
    const stored = released.items.find((i) => i.id === item.id) as VideoTimelineItem;
    expect(stored.position).toEqual({ x: 65, y: 65 });
    // Untouched items and fields are identical objects/values.
    expect(released.items.filter((i) => i.id !== item.id)).toEqual(project.items.filter((i) => i.id !== item.id));
    expect(stored.scale).toBe(1);
    expect(stored.startTime).toBe(0);
  });

  it('a scripted resize gesture: the release commit scale equals the final shown scale', () => {
    const { project, item } = projectWithItem();
    const centerX = 50;
    const originalWidth = 40;
    const pointerStream = [55, 62, 71, 90, 130, 44];
    let finalPreview: CanvasDragPreview | null = null;
    for (const px of pointerStream) {
      const preview: CanvasDragPreview = { itemId: item.id, scale: resizeDragScale(1, centerX, originalWidth, px) };
      finalPreview = preview;
      const shown = itemWithDragPreview(item, preview);
      const committed = applyCanvasDragPreview(project, preview).items.find((i) => i.id === item.id) as VideoTimelineItem;
      expect(committed.scale).toBe(shown.scale);
      expect(committed.scale).toBe(preview.scale);
    }
    const stored = applyCanvasDragPreview(project, finalPreview!).items.find((i) => i.id === item.id) as VideoTimelineItem;
    expect(stored.scale).toBe(resizeDragScale(1, centerX, originalWidth, 44));
    expect(stored.position).toEqual({ x: 50, y: 50 });
  });

  it('a preview for a different item changes nothing; an empty preview returns the project untouched', () => {
    const { project, item } = projectWithItem();
    const other = itemWithDragPreview(item, { itemId: 'not-this-item', position: { x: 1, y: 1 } });
    expect(other).toBe(item);
    expect(applyCanvasDragPreview(project, { itemId: item.id })).toBe(project);
  });

  it('applyCanvasDragPreview does not mutate the input project', () => {
    const { project, item } = projectWithItem();
    const before = (project.items.find((i) => i.id === item.id) as VideoTimelineItem).position;
    applyCanvasDragPreview(project, { itemId: item.id, position: { x: 3, y: 4 } });
    expect((project.items.find((i) => i.id === item.id) as VideoTimelineItem).position).toBe(before);
    expect(before).toEqual({ x: 50, y: 50 });
  });
});
