import { describe, it, expect } from 'vitest';
import { addPipOverlay, getPipLayout, isPipItem, pipScaleForWidthPercent, pipWidthPercentForScale, PIP_LAYOUTS, swapMainAndPip } from '../lib/pip';
import { validateProject } from '../lib/timeline/validation';
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

describe('addPipOverlay audio defaults (overlay volume parity)', () => {
  const findPip = (items: ReturnType<typeof createDefaultProject>['items']) =>
    items.find((i) => i.type === 'video' && (i as { pip?: { isPip?: boolean } }).pip?.isPip);

  it('uploaded-file overlays start muted at full volume (default, option omitted)', () => {
    const project = createDefaultProject('uid-1');
    const next = addPipOverlay(project, makeAsset(), { layoutId: 'bottom-right' });
    const pip = findPip(next.items);
    if (!pip || pip.type !== 'video') throw new Error('expected a PiP video item');
    expect(pip.muted).toBe(true);
    expect(pip.volume).toBe(1);
  });

  it('camera overlays (muted: false) start UNMUTED at full volume — the talking-head case', () => {
    const project = createDefaultProject('uid-1');
    const next = addPipOverlay(project, makeAsset(), { layoutId: 'bottom-right', muted: false });
    const pip = findPip(next.items);
    if (!pip || pip.type !== 'video') throw new Error('expected a PiP video item');
    expect(pip.muted).toBe(false);
    expect(pip.volume).toBe(1);
  });

  it('explicit muted: true keeps the overlay muted', () => {
    const project = createDefaultProject('uid-1');
    const next = addPipOverlay(project, makeAsset(), { muted: true });
    const pip = findPip(next.items);
    if (!pip || pip.type !== 'video') throw new Error('expected a PiP video item');
    expect(pip.muted).toBe(true);
    expect(pip.volume).toBe(1);
  });

  it('the mute option composes with a trim window (camera flow with defensive clamp)', () => {
    const project = createDefaultProject('uid-1');
    const next = addPipOverlay(project, makeAsset(), { muted: false, trimStart: 1, trimEnd: 6 });
    const pip = findPip(next.items);
    if (!pip || pip.type !== 'video') throw new Error('expected a PiP video item');
    expect(pip.muted).toBe(false);
    expect(pip.trimStart).toBe(1);
    expect(pip.trimEnd).toBe(6);
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

describe('swapMainAndPip + size mapping', () => {
  it('maps width percent to scale and back', () => {
    expect(pipScaleForWidthPercent(32)).toBeCloseTo(0.32);
    expect(pipWidthPercentForScale(0.5)).toBe(50);
    expect(pipScaleForWidthPercent(200)).toBeLessThanOrEqual(0.9);
  });

  it('swaps roles: overlay becomes main, main becomes the circle', async () => {
    const { appendMediaToTimeline } = await import('../lib/timeline/insert');
    let project = createDefaultProject('uid-1');
    project = appendMediaToTimeline(project, makeAsset());
    const mainBefore = project.items.find((i) => i.type === 'video')!;
    project = addPipOverlay(project, { ...makeAsset(), id: 'asset-2', fileName: 'head.mp4' }, { layoutId: 'bottom-right' });
    const pipBefore = project.items.find((i) => i.type === 'video' && isPipItem(i))!;
    const next = swapMainAndPip(project, pipBefore.id);
    const newMain = next.items.find((i) => i.id === pipBefore.id)!;
    const newPip = next.items.find((i) => i.id === mainBefore.id)!;
    expect(isPipItem(newMain)).toBe(false);
    expect(newMain.type === 'video' && newMain.scale).toBe(1);
    expect(isPipItem(newPip)).toBe(true);
    expect(newPip.type === 'video' && newPip.pip?.shape).toBe('circle');
    // timing stays with each clip
    expect(newMain.startTime).toBe(pipBefore.startTime);
    expect(newPip.startTime).toBe(mainBefore.startTime);
    expect(validateProject(next).valid).toBe(true);
  });

  it('is a no-op without a main video', () => {
    const project = addPipOverlay(createDefaultProject('uid-1'), makeAsset(), {});
    const pip = project.items.find((i) => isPipItem(i))!;
    expect(swapMainAndPip(project, pip.id)).toBe(project);
  });
});

describe('addPipOverlay camera framing (R24 WS-P3)', () => {
  const findPip = (items: ReturnType<typeof createDefaultProject>['items']) =>
    items.find((i) => i.type === 'video' && (i as { pip?: { isPip?: boolean } }).pip?.isPip);

  it('fromCamera: rounded rectangle + source-aspect fit + sound on — even with the circular bottom-right layout', () => {
    const project = createDefaultProject('uid-1');
    const next = addPipOverlay(project, makeAsset(), { layoutId: 'bottom-right', fromCamera: true });
    const pip = findPip(next.items);
    if (!pip || pip.type !== 'video') throw new Error('expected a PiP video item');
    expect(pip.pip?.shape).toBe('rounded');
    expect(pip.pip?.fit).toBe('source');
    expect(pip.muted).toBe(false);
    expect(validateProject(next).valid).toBe(true);
  });

  it('the existing camera signal (muted: false, as the capture/import path passes) gets the same framing', () => {
    const project = createDefaultProject('uid-1');
    const next = addPipOverlay(project, makeAsset(), { layoutId: 'bottom-right', muted: false });
    const pip = findPip(next.items);
    if (!pip || pip.type !== 'video') throw new Error('expected a PiP video item');
    expect(pip.pip?.shape).toBe('rounded');
    expect(pip.pip?.fit).toBe('source');
  });

  it('an explicit shape still wins for a camera recording (the circle stays one tap away)', () => {
    const project = createDefaultProject('uid-1');
    const next = addPipOverlay(project, makeAsset(), { fromCamera: true, shape: 'circle' });
    const pip = findPip(next.items);
    if (!pip || pip.type !== 'video') throw new Error('expected a PiP video item');
    expect(pip.pip?.shape).toBe('circle');
    expect(pip.pip?.fit).toBe('source');
  });

  it('explicit fromCamera: false keeps the legacy framing even when the overlay starts unmuted', () => {
    const project = createDefaultProject('uid-1');
    const next = addPipOverlay(project, makeAsset(), { layoutId: 'bottom-right', fromCamera: false, muted: false });
    const pip = findPip(next.items);
    if (!pip || pip.type !== 'video') throw new Error('expected a PiP video item');
    expect(pip.pip?.shape).toBe('circle');
    expect(pip.pip?.fit).toBeUndefined();
    expect(pip.muted).toBe(false);
  });

  it('non-camera defaults are unchanged: circle layout, no fit field, muted', () => {
    const project = createDefaultProject('uid-1');
    const next = addPipOverlay(project, makeAsset(), { layoutId: 'bottom-right' });
    const pip = findPip(next.items);
    if (!pip || pip.type !== 'video') throw new Error('expected a PiP video item');
    expect(pip.pip?.shape).toBe('circle');
    expect(pip.pip?.fit).toBeUndefined();
    expect(pip.muted).toBe(true);
  });
});
