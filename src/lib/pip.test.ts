import { describe, it, expect } from 'vitest';
import { addPipOverlay, getPipLayout, PIP_LAYOUTS } from '../lib/pip';
import { createDefaultProject } from '../lib/projects/persistence';
import type { MediaAsset } from '../types/timeline';

function makeAsset(): MediaAsset {
  return { id: 'asset-1', kind: 'video', fileName: 'talking-head.mp4', mimeType: 'video/mp4', storageUrl: 'https://example.com/v.mp4', sizeBytes: 12345, durationSeconds: 10, createdAt: Date.now() };
}

describe('PiP layouts', () => {
  it('has the 5 v1 layouts', () => {
    expect(PIP_LAYOUTS.map((l) => l.id)).toEqual(['bottom-right', 'bottom-left', 'top-right', 'top-left', 'side-by-side']);
  });
  it('bottom-right is a circle, side-by-side is larger', () => {
    expect(getPipLayout('bottom-right').shape).toBe('circle');
    expect(getPipLayout('side-by-side').scale).toBeGreaterThan(getPipLayout('bottom-right').scale);
  });
  it('unknown layout falls back to bottom-right', () => {
    expect(getPipLayout('nope' as never).id).toBe('bottom-right');
  });
});

describe('addPipOverlay', () => {
  it('adds a muted, top-zIndex PiP video item', () => {
    const project = createDefaultProject('uid-1');
    const next = addPipOverlay(project, makeAsset(), { layoutId: 'bottom-right' });
    const pip = next.items.find((i) => i.type === 'video' && (i as { pip?: { isPip?: boolean } }).pip?.isPip);
    expect(pip).toBeDefined();
    if (pip && pip.type === 'video') {
      expect(pip.pip?.shape).toBe('circle');
      expect(pip.pip?.borderWidth).toBe(4);
      expect(pip.muted).toBe(true);
      expect(pip.position).toEqual({ x: 82, y: 78 });
      expect(pip.scale).toBeCloseTo(0.32);
    }
    // PiP sits above the main video (highest zIndex).
    const maxZ = Math.max(...next.items.map((i) => i.zIndex));
    expect(pip?.zIndex).toBe(maxZ);
  });
  it('respects shape override', () => {
    const project = createDefaultProject('uid-1');
    const next = addPipOverlay(project, makeAsset(), { layoutId: 'bottom-right', shape: 'square' });
    const pip = next.items.find((i) => i.type === 'video' && (i as { pip?: { isPip?: boolean } }).pip?.isPip);
    expect((pip as { pip?: { shape?: string } } | undefined)?.pip?.shape).toBe('square');
  });
});

describe('addPipOverlay with a trim window (Add Overlay upload flow)', () => {
  it('plays the supplied source window instead of the asset’s head', () => {
    const project = createDefaultProject('uid-1');
    const next = addPipOverlay(project, makeAsset(), { trimStart: 3, trimEnd: 7 });
    const pip = next.items.find((i) => i.type === 'video' && (i as { pip?: { isPip?: boolean } }).pip?.isPip);
    if (!pip || pip.type !== 'video') throw new Error('expected a PiP video item');
    expect(pip.trimStart).toBe(3);
    expect(pip.trimEnd).toBe(7);
    expect(pip.endTime - pip.startTime).toBeCloseTo(4, 5);
  });

  it('without a window, behavior is unchanged (whole asset from 0)', () => {
    const project = createDefaultProject('uid-1');
    const next = addPipOverlay(project, makeAsset(), {});
    const pip = next.items.find((i) => i.type === 'video' && (i as { pip?: { isPip?: boolean } }).pip?.isPip);
    if (!pip || pip.type !== 'video') throw new Error('expected a PiP video item');
    expect(pip.trimStart).toBe(0);
    expect(pip.trimEnd).toBe(10);
  });
});
