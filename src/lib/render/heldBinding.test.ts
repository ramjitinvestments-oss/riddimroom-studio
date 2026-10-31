import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findHeldMainVisualItem, videoSourceTimeForItem } from './compositor';
import { getItemsAtTime, getProjectDuration } from '../timeline/utils';
import type { Project, VideoTimelineItem } from '../../types/timeline';

/**
 * R40 Phase 2 (P-09) — held-frame MEDIA BINDING trace.
 *
 * The compositor's hold semantics were already proven in
 * compositor.test.ts (drawFrame draws the held item at full strength).
 * What P-09 asked is the layer UNDER that: in a PiP-longest project,
 * do PreviewPane and both exporters actually put the held item's
 * <video> element into the frame's media map, seeked to its clamped
 * last frame — or could the element sit frozen at load / black while
 * the PiP plays over the tail?
 *
 * Trace result (negative — no fault found): all three bindings share
 * the same two-step pattern, verified in their sources below —
 *   1. the sync list is the active items PLUS
 *      `findHeldMainVisualItem(project, t)` when it is not already
 *      active (the held item is by construction NOT in
 *      `getItemsAtTime`, so without this join its element would never
 *      reach drawFrame and the tail would be black);
 *   2. the held element is seeked to `videoSourceTimeForItem(item, t)`
 *      — the shared clamp, which pins it to `trimEnd` (the real last
 *      frame) for the whole tail — paused, at gain/volume 0.
 * PreviewPane does it in its rAF sync block (runs while paused too),
 * canvas2dRenderer in its recorder tick, and mediabunnyExporter in
 * its per-frame draw (additionally awaiting the seek before drawing).
 *
 * These tests pin the contract those bindings rely on: the held item
 * is identifiable at every tail timestamp, it is absent from the
 * active set (so the explicit join is load-bearing), and the seek
 * target is exactly the last frame for the whole tail.
 */

function pipLongestProject(): Project {
  const main: VideoTimelineItem = {
    id: 'item-main', type: 'video', trackId: 'track-video',
    startTime: 0, endTime: 5, zIndex: 0, visible: true,
    mediaAssetId: 'main-vid',
    position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 1,
    trimStart: 2, trimEnd: 7, speed: 1, reverse: false, volume: 1, muted: false,
  };
  const pip: VideoTimelineItem = {
    id: 'item-pip', type: 'video', trackId: 'track-video',
    startTime: 0, endTime: 12, zIndex: 1, visible: true,
    mediaAssetId: 'pip-vid',
    position: { x: 80, y: 80 }, scale: 0.3, rotation: 0, opacity: 1,
    trimStart: 0, trimEnd: 12, speed: 1, reverse: false, volume: 1, muted: true,
    pip: { isPip: true, shape: 'rounded', borderWidth: 0, borderColor: '#000000', shadow: false },
  };
  return {
    id: 'project-pip-longest', ownerUid: 'uid-1', name: 'PiP longest', schemaVersion: 1,
    tracks: [
      { id: 'track-video', type: 'video', name: 'Main Video', order: 0, visible: true, locked: false },
    ],
    items: [main, pip],
    mediaAssets: {},
    canvasWidth: 1080, canvasHeight: 1920, frameRate: 30,
    createdAt: 0, updatedAt: 0,
  };
}

describe('R40 P-09 — held main item binding contract (PiP-longest project)', () => {
  it('the project really is PiP-longest: duration 12s, main ends at 5s', () => {
    const project = pipLongestProject();
    expect(getProjectDuration(project)).toBe(12);
  });

  it('at every tail timestamp the held item is the main item — and it is NOT active', () => {
    const project = pipLongestProject();
    for (const t of [5, 6.5, 8, 10, 11.99]) {
      expect(findHeldMainVisualItem(project, t)?.id).toBe('item-main');
      // Load-bearing: the active set at a tail time contains only the
      // PiP. A binding that synced only active items would have no
      // main element to draw — the tail would be black.
      const activeIds = getItemsAtTime(project, t).map((i) => i.id);
      expect(activeIds).toContain('item-pip');
      expect(activeIds).not.toContain('item-main');
    }
  });

  it('the seek target for the held element is its real last frame (trimEnd) for the WHOLE tail', () => {
    const project = pipLongestProject();
    const main = project.items.find((i) => i.id === 'item-main') as VideoTimelineItem;
    // A fake element run through the bindings' shared decision:
    // target = videoSourceTimeForItem(held, t); seek when it differs.
    const el = { currentTime: 0 };
    for (const t of [5, 6.5, 8, 10, 11.99]) {
      const held = findHeldMainVisualItem(project, t);
      expect(held?.id).toBe('item-main');
      const target = videoSourceTimeForItem(main, t);
      if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
      // Never frozen at load (0), never past the end: exactly the
      // clamped last frame, from the first tail instant to the last.
      expect(el.currentTime).toBe(7);
      expect(el.currentTime).toBe(main.trimEnd);
    }
  });

  it('before the tail there is no hold and the mapping is the normal in-span one', () => {
    const project = pipLongestProject();
    const main = project.items.find((i) => i.id === 'item-main') as VideoTimelineItem;
    expect(findHeldMainVisualItem(project, 3)).toBeNull();
    expect(videoSourceTimeForItem(main, 3)).toBe(5); // trimStart 2 + 3s elapsed
    expect(videoSourceTimeForItem(main, 0)).toBe(2);
  });

  it('a faster-than-real-time main still clamps to trimEnd, never past it', () => {
    const project = pipLongestProject();
    const fast: VideoTimelineItem = {
      ...(project.items[0] as VideoTimelineItem),
      trimStart: 2, trimEnd: 12, speed: 2, // 10 source-seconds over the 5s span
    };
    const sped = { ...project, items: [fast, project.items[1]] };
    expect(findHeldMainVisualItem(sped, 9)?.id).toBe('item-main');
    // Raw mapping at t=9 would be 2 + 9×2 = 20 — far past the source.
    expect(videoSourceTimeForItem(fast, 9)).toBe(12);
    expect(videoSourceTimeForItem(fast, 11.99)).toBe(12);
  });

  it('when the main item outlasts the PiP there is no hold at all (PiPs never hold)', () => {
    const project = pipLongestProject();
    const longMain = { ...(project.items[0] as VideoTimelineItem), endTime: 12, trimEnd: 14 };
    const shortPip = { ...(project.items[1] as VideoTimelineItem), endTime: 5, trimEnd: 5 };
    const flipped: Project = { ...project, items: [longMain, shortPip] };
    expect(getProjectDuration(flipped)).toBe(12);
    expect(findHeldMainVisualItem(flipped, 8)).toBeNull();
  });

  it('all three bindings (PreviewPane + both exporters) use the shared held join + clamped seek', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcRoot = join(here, '..', '..');
    const bindings: [string, string][] = [
      ['PreviewPane', join(srcRoot, 'components', 'Editor', 'PreviewPane.tsx')],
      ['canvas2dRenderer', join(srcRoot, 'lib', 'export', 'canvas2dRenderer.ts')],
      ['mediabunnyExporter', join(srcRoot, 'lib', 'export', 'mediabunnyExporter.ts')],
    ];
    for (const [name, path] of bindings) {
      const source = readFileSync(path, 'utf8');
      expect(source, `${name} must join the held item into its sync list`).toContain('findHeldMainVisualItem');
      expect(source, `${name} must seek with the shared clamped source time`).toContain('videoSourceTimeForItem');
    }
  });
});
