/**
 * R44 Phase C — SF-3 canvas drag parity (source-level guards).
 *
 * The functional parity proof lives in src/lib/render/canvasDrag.test.ts
 * (one apply function feeds both the shown frame and the release
 * commit). These guards pin the WIRING that proof depends on:
 *  1. Neither drag handler's move path touches the project store — the
 *     gesture writes only the local drag preview.
 *  2. Each handler commits exactly once, on release, through
 *     applyCanvasDragPreview over the final preview value.
 *  3. The tick draws the drag-preview project through drawFrame while a
 *     gesture is in flight, and the selection box follows the same
 *     preview geometry.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const pane = readFileSync(join(HERE, 'PreviewPane.tsx'), 'utf8');

function section(fromMarker: string, toMarker: string): string {
  const from = pane.indexOf(fromMarker);
  expect(from, `marker not found: ${fromMarker}`).toBeGreaterThan(-1);
  const to = pane.indexOf(toMarker, from + fromMarker.length);
  expect(to, `end marker not found: ${toMarker}`).toBeGreaterThan(from);
  return pane.slice(from, to);
}

describe('R44 SF-3 — no code path mutates the project mid-gesture', () => {
  it('both move handlers write only the local drag preview', () => {
    const moveDrag = section('const beginMoveDrag', 'const beginResizeDrag');
    const resizeDrag = section('const beginResizeDrag', 'const hitTestCanvas');
    for (const handler of [moveDrag, resizeDrag]) {
      const moveAt = handler.indexOf('const handleMove');
      const upAt = handler.indexOf('const handleUp');
      expect(moveAt).toBeGreaterThan(-1);
      expect(upAt).toBeGreaterThan(moveAt);
      const moveBody = handler.slice(moveAt, upAt);
      expect(moveBody).toContain('setDragPreview(');
      expect(moveBody).not.toContain('mutate(');
    }
    // The old per-move store writes are gone from the whole pane.
    expect(pane).not.toContain('mutate((p) => updateItem(');
  });

  it('the drag math comes from the shared canvasDrag module', () => {
    expect(pane).toContain('moveDragPosition(s.originalX, s.originalY, dxPercent, dyPercent)');
    expect(pane).toContain('resizeDragScale(s.originalScale, s.centerXPercent, originalWidthPercent, mouseXPercent)');
  });
});

describe('R44 SF-3 — exactly one commit per gesture, on release, of the shown geometry', () => {
  it('each release handler commits once through applyCanvasDragPreview over the final preview', () => {
    const commits = pane.match(/mutate\(\(p\) => applyCanvasDragPreview\(p, preview\)\)/g) ?? [];
    expect(commits.length).toBe(2); // move + resize, one each
    const moveDrag = section('const beginMoveDrag', 'const beginResizeDrag');
    const resizeDrag = section('const beginResizeDrag', 'const hitTestCanvas');
    for (const handler of [moveDrag, resizeDrag]) {
      const upBody = handler.slice(handler.indexOf('const handleUp'));
      expect(upBody).toContain('const preview = dragPreviewRef.current;');
      expect(upBody).toContain('mutate((p) => applyCanvasDragPreview(p, preview))');
      expect(upBody).toContain('setDragPreview(null);');
    }
  });
});

describe('R44 SF-3 — the shown frame is the real compositor at the preview geometry', () => {
  it('the tick derives drawProj from the drag preview and draws it through drawFrame', () => {
    expect(pane).toContain('const drawProj = dragPreviewRef.current ? applyCanvasDragPreview(proj, dragPreviewRef.current) : proj;');
    expect(pane).toContain('drawFrame(ctx, drawProj, t, frameAssets);');
    expect(pane).toContain('projectChanged: !lastDrawn || lastDrawn.project !== drawProj,');
  });

  it('the selection box follows the same preview geometry', () => {
    expect(pane).toContain('getBoundsForItem(itemWithDragPreview(item, dragPreview))');
  });
});
