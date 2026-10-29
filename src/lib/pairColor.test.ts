import { describe, it, expect } from 'vitest';
import { createDefaultProject } from './projects/persistence';
import { placeImportPair } from './timeline/insert';
import { getPairContext } from './pairLayout';
import {
  applyPairMatch,
  averageFramePixels,
  lumaOf,
  matchGradeDeltas,
  matchedGradeFor,
  removePairMatch,
  type FrameSample,
} from './pairColor';
import type { MediaAsset, Project, VideoTimelineItem } from '../types/timeline';

function videoAsset(id: string): MediaAsset {
  return {
    id, kind: 'video', storageUrl: `https://x.test/${id}.mp4`, fileName: `${id}.mp4`,
    sizeBytes: 1, mimeType: 'video/mp4', durationSeconds: 10, width: 1920, height: 1080, createdAt: 0,
  };
}
function project(): Project {
  return createDefaultProject('u1', 'test', 1080, 1920);
}
function videoItem(p: Project, assetId: string): VideoTimelineItem {
  const item = p.items.find((i) => i.type === 'video' && i.mediaAssetId === assetId);
  if (!item || item.type !== 'video') throw new Error(`no video item for ${assetId}`);
  return item;
}
const sample = (r: number, g: number, b: number): FrameSample => ({
  meanR: r, meanG: g, meanB: b, meanLuma: lumaOf(r, g, b),
});

describe('averageFramePixels', () => {
  it('averages RGB and computes luma; a solid frame returns its own colour', () => {
    const data = new Uint8ClampedArray([200, 100, 50, 255, 200, 100, 50, 255]);
    const s = averageFramePixels(data);
    expect(s.meanR).toBe(200);
    expect(s.meanG).toBe(100);
    expect(s.meanB).toBe(50);
    expect(s.meanLuma).toBeCloseTo(lumaOf(200, 100, 50), 5);
  });
  it('an empty buffer is a safe zero sample', () => {
    expect(averageFramePixels([])).toEqual({ meanLuma: 0, meanR: 0, meanG: 0, meanB: 0 });
  });
});

describe('matchGradeDeltas / matchedGradeFor — mapping + clamps', () => {
  it('luma offset maps to brightness, capped at ±12', () => {
    // 100-point luma gap would be +24 uncapped → clamps to +12.
    expect(matchGradeDeltas(sample(200, 200, 200), sample(100, 100, 100)).brightness).toBe(12);
    expect(matchGradeDeltas(sample(100, 100, 100), sample(200, 200, 200)).brightness).toBe(-12);
    // A 25-point gap lands mid-range: 25 * 0.24 = 6.
    expect(matchGradeDeltas(sample(125, 125, 125), sample(100, 100, 100)).brightness).toBeCloseTo(6, 5);
  });
  it('warmth offset (R-B difference) maps to saturation, capped at ±10 (no temperature field exists)', () => {
    // Main much warmer: (180-60) - (100-100) = 120 → 120 * 0.2 = 24 → cap 10.
    expect(matchGradeDeltas(sample(180, 100, 60), sample(100, 100, 100)).saturation).toBe(10);
    expect(matchGradeDeltas(sample(60, 100, 180), sample(100, 100, 100)).saturation).toBe(-10);
  });
  it('identical samples produce zero deltas', () => {
    expect(matchGradeDeltas(sample(120, 90, 60), sample(120, 90, 60))).toEqual({ brightness: 0, saturation: 0 });
  });
  it('the matched grade adds deltas onto the prior grade, keeps contrast, clamps fields to ±100', () => {
    const prior = { brightness: 95, contrast: 33, saturation: -95 };
    const grade = matchedGradeFor(prior, sample(200, 200, 200), sample(100, 100, 100));
    expect(grade.brightness).toBe(100); // 95 + 12 clamped
    expect(grade.contrast).toBe(33); // untouched by design
    expect(grade.saturation).toBe(-95); // neutral warmth → no change
    const fromScratch = matchedGradeFor(undefined, sample(125, 125, 125), sample(100, 100, 100));
    expect(fromScratch).toEqual({ brightness: 6, contrast: 0, saturation: 0 });
  });
});

describe('applyPairMatch / removePairMatch — toggle restores exactly', () => {
  it('stores the prior grade on apply and restores it on toggle off', () => {
    let p = placeImportPair(project(), videoAsset('a'), videoAsset('b'), { layout: 'split' });
    const prior = { brightness: 5, contrast: 10, saturation: -5 };
    const second0 = videoItem(p, 'b');
    p = { ...p, items: p.items.map((i) => (i.id === second0.id ? { ...i, colorGrade: prior } : i)) };
    const ctx = getPairContext(p, videoItem(p, 'a'))!;
    p = applyPairMatch(p, ctx, sample(150, 140, 130), sample(100, 100, 100));
    const matched = videoItem(p, 'b');
    expect(matched.colorGrade).not.toEqual(prior);
    expect(matched.colorGrade?.contrast).toBe(10);
    expect(matched.pair?.preMatchGrade).toEqual(prior);
    expect(matched.pair?.matchOn).toBe(true);
    expect(videoItem(p, 'a').pair?.matchOn).toBe(true);
    p = removePairMatch(p, getPairContext(p, videoItem(p, 'a'))!);
    const restored = videoItem(p, 'b');
    expect(restored.colorGrade).toEqual(prior);
    expect(restored.pair?.preMatchGrade).toBeUndefined();
    expect(restored.pair?.matchOn).toBe(false);
  });
  it('a second item with NO prior grade restores to no grade (undefined), not zeros', () => {
    let p = placeImportPair(project(), videoAsset('a'), videoAsset('b'), { layout: 'split' });
    expect(videoItem(p, 'b').colorGrade).toBeUndefined();
    const ctx = getPairContext(p, videoItem(p, 'a'))!;
    p = applyPairMatch(p, ctx, sample(180, 180, 180), sample(90, 90, 90));
    expect(videoItem(p, 'b').colorGrade).toBeDefined();
    expect(videoItem(p, 'b').pair?.preMatchGrade).toBeNull();
    p = removePairMatch(p, getPairContext(p, videoItem(p, 'a'))!);
    expect(videoItem(p, 'b').colorGrade).toBeUndefined();
  });
});
