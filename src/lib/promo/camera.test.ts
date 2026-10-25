import { describe, it, expect } from 'vitest';
import { applyCameraTour } from './camera';
import type { ReadoutResult } from './readout';
import { createDefaultProject } from '../projects/persistence';
import { addItem, addMediaAsset, generateTimelineId } from '../timeline/utils';
import type { ImageTimelineItem, MediaAsset, Project } from '../../types/timeline';

function fakeAsset(id: string, width: number, height: number): MediaAsset {
  return {
    id, kind: 'image', storageUrl: `https://example.test/${id}.png`, fileName: `${id}.png`,
    sizeBytes: 1000, mimeType: 'image/png', width, height, createdAt: 0,
  };
}

function heroProject(): Project {
  const art = fakeAsset('art', 1080, 1920);
  let project = createDefaultProject('u', 'T', 1080, 1920);
  project = addMediaAsset(project, art);
  const track = project.tracks.find((t) => t.type === 'image')!;
  const hero: ImageTimelineItem = {
    id: generateTimelineId('item'), type: 'image', trackId: track.id, visible: true,
    mediaAssetId: 'art', role: 'graphic',
    position: { x: 50, y: 50 }, scale: 4, rotation: 0, opacity: 1,
    startTime: 0, endTime: 10, zIndex: 10,
  };
  return addItem(project, hero);
}

describe('word-tour framing cap (R15)', () => {
  it('an edge-hugging headline word cannot push the art off stage', () => {
    const readout = {
      genre: 'business',
      fields: {},
      lines: [],
      headline: 'EDGE',
      headlineLine: { text: 'EDGE', confidence: 90, y: 0.01, box: { x: 0.0, y: 0.0, w: 0.1, h: 0.02 } },
      ctaLine: { text: 'CALL', confidence: 90, y: 0.9, box: { x: 0.4, y: 0.9, w: 0.2, h: 0.03 } },
    } as unknown as ReadoutResult;
    const project = applyCameraTour(heroProject(), readout);
    const hero = project.items.find((i) => i.type === 'image') as ImageTimelineItem;
    const motion = hero.motion as { type: string; tourStops?: Array<{ x: number; y: number; scale: number }> };
    expect(motion.type).toBe('word-tour');
    // drawn hero = 1080x1920 at zoom 1.55: the cap on each axis is
    // (drawn*zoom/2 - canvas*0.25) / canvas
    const capX = (1080 * 1.55) / 2 / 1080 - 0.25;
    const capY = (1920 * 1.55) / 2 / 1920 - 0.25;
    for (const stop of motion.tourStops ?? []) {
      expect(Math.abs(stop.x)).toBeLessThanOrEqual(capX + 1e-6);
      expect(Math.abs(stop.y)).toBeLessThanOrEqual(capY + 1e-6);
    }
    // the uncapped offset for this corner word would exceed the cap
    const uncappedY = ((0.01 - 0.5) * 1920 * 1.55) / 1920;
    expect(Math.abs(uncappedY)).toBeGreaterThan(capY);
  });
});

describe('stage backdrop cover (R15)', () => {
  it('the backdrop reaches every edge of a tall stage for landscape art', async () => {
    const { applyStageBackdrop } = await import('./camera');
    const art = fakeAsset('wide', 1536, 1024);
    let project = createDefaultProject('u', 'B', 1080, 1920);
    project = addMediaAsset(project, art);
    const track = project.tracks.find((t) => t.type === 'image')!;
    const hero: ImageTimelineItem = {
      id: generateTimelineId('item'), type: 'image', trackId: track.id, visible: true,
      mediaAssetId: 'wide', role: 'graphic',
      position: { x: 50, y: 50 }, scale: 4, rotation: 0, opacity: 1,
      startTime: 0, endTime: 10, zIndex: 10,
    };
    project = addItem(project, hero);
    const staged = applyStageBackdrop(project);
    const backdrop = staged.items.find((i) => i.type === 'image' && (i as ImageTimelineItem).opacity < 0.9) as ImageTimelineItem;
    expect(backdrop).toBeTruthy();
    const w = backdrop.scale * 1080 * 0.25;
    const h = (w * 1024) / 1536;
    expect(w).toBeGreaterThanOrEqual(1080);
    expect(h).toBeGreaterThanOrEqual(1920);
  });
});
