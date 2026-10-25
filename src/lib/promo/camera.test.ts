import { describe, it, expect } from 'vitest';
import { applyCameraTour, applyStageBackdrop, chooseTourStops } from './camera';
import { computeMotionAdjustment } from '../render/compositor';
import type { ImageTimelineItem, Project } from '../../types/timeline';
import type { OcrLine, ReadoutResult } from './readout';

function line(text: string, cx: number, cy: number, w = 0.5, h = 0.07, confidence = 92): OcrLine {
  return { text, confidence, y: cy - h / 2, box: { x: cx - w / 2, y: cy - h / 2, w, h } };
}

const READOUT: ReadoutResult = {
  fields: { hook1: 'ELECTRICAL' },
  genre: 'trades',
  headline: 'ELECTRICAL',
  lines: [],
  headlineLine: line('ELECTRICAL', 0.5, 0.3, 0.62, 0.08),
  ctaLine: line('CALL US', 0.5, 0.8, 0.3, 0.05),
  phoneLine: line('407-616-2569', 0.5, 0.87, 0.34, 0.05),
  phone: '407-616-2569',
};
READOUT.lines = [READOUT.headlineLine!, line('FLOORING', 0.5, 0.48, 0.55, 0.07, 88), line('PLUMBING', 0.5, 0.62, 0.55, 0.07, 85), READOUT.ctaLine!, READOUT.phoneLine!];

function heroItem(partial: Partial<ImageTimelineItem> = {}): ImageTimelineItem {
  return {
    id: 'hero1', type: 'image', trackId: 'img1', visible: true, mediaAssetId: 'asset1',
    role: 'graphic', position: { x: 50, y: 50 }, scale: 4, rotation: 0, opacity: 1,
    startTime: 0, endTime: 6, zIndex: 10, ...partial,
  } as ImageTimelineItem;
}

function projectWith(items: ImageTimelineItem[]): Project {
  return {
    id: 'p1', ownerUid: 'u1', name: 't', schemaVersion: 1,
    tracks: [{ id: 'img1', type: 'image', name: 'Main', order: 0 } as Project['tracks'][number]],
    items,
    mediaAssets: { asset1: { id: 'asset1', width: 1000, height: 1000 } as Project['mediaAssets'][string] },
    canvasWidth: 1080, canvasHeight: 1920, frameRate: 30, createdAt: 0, updatedAt: 0,
  } as Project;
}

describe('word-box camera', () => {
  it('chooses headline, biggest supports, phone finale — in that order', () => {
    const stops = chooseTourStops(READOUT);
    expect(stops.map((s) => s.line.text)).toEqual(['ELECTRICAL', 'FLOORING', 'PLUMBING', '407-616-2569']);
    expect(stops[0].zoom).toBeGreaterThan(stops[3].zoom);
  });

  it('bakes a tour onto the dominant hero with sane geometry', () => {
    const next = applyCameraTour(projectWith([heroItem()]), READOUT);
    const hero = next.items[0] as ImageTimelineItem;
    expect(hero.motion?.type).toBe('word-tour');
    const stops = hero.motion?.tourStops || [];
    expect(stops[0]).toMatchObject({ t: 0, x: 0, y: 0, scale: 1 });
    const headStop = stops.find((s) => Math.abs(s.scale - 1.55) < 0.001);
    expect(headStop).toBeTruthy();
    // Headline sits ABOVE center (cy 0.3): the camera must move the
    // art DOWN (+y offset) to center it.
    expect(headStop!.y).toBeGreaterThan(0.1);
  });

  it('a short hero (slice recipe shape) is left alone', () => {
    const items = [heroItem({ endTime: 2 }), heroItem({ id: 'h2', startTime: 2, endTime: 6 })];
    const next = applyCameraTour(projectWith(items), READOUT);
    expect((next.items[0] as ImageTimelineItem).motion).toBeUndefined();
  });

  it('the compositor interpolates the tour smoothly', () => {
    const motion = { type: 'word-tour' as const, tourStops: [
      { t: 0, x: 0, y: 0, scale: 1 },
      { t: 0.5, x: 0.1, y: 0, scale: 2 },
      { t: 1, x: 0.1, y: 0, scale: 2 },
    ] };
    const mid = computeMotionAdjustment(motion, 1.5, 6, 1080, 1920);
    expect(mid.scaleMul).toBeCloseTo(1.5, 5);
    expect(mid.offsetXPx).toBeCloseTo(54, 5);
    const start = computeMotionAdjustment(motion, 0, 6, 1080, 1920);
    expect(start.scaleMul).toBeCloseTo(1, 5);
  });
});

describe('stage backdrop', () => {
  it('adds a dimmed enlarged copy when the hero floats in a void', () => {
    const next = applyStageBackdrop(projectWith([heroItem()]));
    expect(next.items).toHaveLength(2);
    const bd = next.items.find((i) => i.id !== 'hero1') as ImageTimelineItem;
    expect(bd.opacity).toBeCloseTo(0.32, 5);
    expect(bd.scale).toBeCloseTo(4 * 1.35, 5);
    expect(bd.zIndex).toBe(9);
  });

  it('does nothing when a backdrop already exists or the hero fills the frame', () => {
    const withBd = projectWith([heroItem(), heroItem({ id: 'bd', opacity: 0.35 })]);
    expect(applyStageBackdrop(withBd).items).toHaveLength(2);
    const tall = projectWith([heroItem({ scale: 7.7 })]); // 1925x1925 drawn — fills
    expect(applyStageBackdrop(tall).items).toHaveLength(1);
  });
});
