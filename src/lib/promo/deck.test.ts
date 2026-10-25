import { describe, it, expect } from 'vitest';
import { dealEntrances, dealDrifts, dealTreatments } from './deck';
import { buildLineupProject, buildSlamProject, buildStackProject } from './recipes';
import { FONT_OPTIONS, canvasFontStack, fontsUsedInProject } from '../fonts';
import { createDefaultProject } from '../projects/persistence';
import type { MediaAsset } from '../../types/timeline';

const img = (id: string): MediaAsset => ({
  id, kind: 'image', storageUrl: `https://x.test/${id}.png`, fileName: `${id}.png`,
  sizeBytes: 1, mimeType: 'image/png', width: 1080, height: 1350, createdAt: 0,
});

describe('the animation deck — dealt, never stamped', () => {
  it('never repeats an entrance or a drift back-to-back, at any count', () => {
    for (const n of [2, 3, 5, 8, 10, 13]) {
      const entrances = dealEntrances(n);
      const drifts = dealDrifts(n);
      for (let i = 1; i < n; i++) {
        expect(entrances[i], `entrance ${i} of ${n}`).not.toBe(entrances[i - 1]);
        expect(drifts[i].type, `drift ${i} of ${n}`).not.toBe(drifts[i - 1].type);
      }
    }
  });

  it('uses real variety: 8 photos get at least 5 different entrances', () => {
    expect(new Set(dealEntrances(8)).size).toBeGreaterThanOrEqual(5);
    expect(dealTreatments(4)).toHaveLength(4);
  });

  it('lineup solos are each dealt their own entrance (no two-way alternation)', () => {
    let p = createDefaultProject('u1');
    const arts = ['poster', 'a', 'b', 'c', 'd'].map((id) => ({ asset: img(id), name: id }));
    p = buildLineupProject(p, arts, { hook1: 'H' }, { duration: 15 });
    const soloEntrances = p.items
      .filter((i) => i.type === 'image' && i.zIndex >= 20 && i.zIndex < 60)
      .map((i) => (i as { animation?: { entrance?: string } }).animation?.entrance);
    expect(soloEntrances.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < soloEntrances.length; i++) {
      expect(soloEntrances[i]).not.toBe(soloEntrances[i - 1]);
    }
  });

  it('slam photo cuts: extras play full segments between the hero phases, hero keeps the CTA phase', () => {
    let p = createDefaultProject('u1');
    p = buildSlamProject(p, img('hero'), { hook1: 'H', cta: 'GO' }, { duration: 12, extras: [img('x1'), img('x2')] });
    const images = p.items.filter((i) => i.type === 'image');
    const cut1 = images.find((i) => i.mediaAssetId === 'x1');
    const cut2 = images.find((i) => i.mediaAssetId === 'x2');
    expect(cut1).toBeTruthy();
    expect(cut2).toBeTruthy();
    // cuts live inside [0.34D, 0.62D] and do not overlap each other
    expect(cut1!.startTime).toBeCloseTo(12 * 0.34, 1);
    expect(cut1!.endTime).toBeCloseTo(cut2!.startTime, 1);
    expect(cut2!.endTime).toBeCloseTo(12 * 0.62, 1);
    expect(cut1!.animation?.entrance).not.toBe(cut2!.animation?.entrance);
  });

  it('stack cards no longer share one entrance', () => {
    let p = createDefaultProject('u1');
    p = buildStackProject(p, [img('a'), img('b'), img('c'), img('d')], {}, { duration: 12 });
    const entrances = p.items
      .filter((i) => i.type === 'image' && i.zIndex >= 10 && i.zIndex < 40)
      .map((i) => (i as { animation?: { entrance?: string } }).animation?.entrance);
    expect(new Set(entrances).size).toBeGreaterThanOrEqual(3);
  });
});

describe('premium fonts', () => {
  it('ships exactly 10 faces and builds canvas stacks safely', () => {
    expect(FONT_OPTIONS).toHaveLength(10);
    expect(new Set(FONT_OPTIONS.map((f) => f.family)).size).toBe(10);
    expect(canvasFontStack('Anton')).toContain('"Anton"');
    expect(canvasFontStack('Arial')).toBe('Arial, Helvetica, sans-serif');
    expect(canvasFontStack(undefined)).toBe('Arial, Helvetica, sans-serif');
  });

  it('collects the fonts a project uses', () => {
    const used = fontsUsedInProject({
      items: [
        { type: 'text', font: 'Bungee' },
        { type: 'text', font: 'Arial' },
        { type: 'text', font: 'Bungee' },
        { type: 'image' },
      ],
    });
    expect(used).toEqual(['Bungee']);
  });

  it('promo type lands on the built text items in the chosen font', () => {
    let p = createDefaultProject('u1');
    p = buildSlamProject(p, img('hero'), { hook1: 'BIG NIGHT', cta: 'GO NOW', font: 'Bungee' }, { duration: 10 });
    const texts = p.items.filter((i) => i.type === 'text') as Array<{ font: string }>;
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((t) => t.font === 'Bungee')).toBe(true);
  });
});
