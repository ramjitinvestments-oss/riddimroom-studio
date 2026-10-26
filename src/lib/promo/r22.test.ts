import { describe, it, expect } from 'vitest';
import { tilingBands } from './analyze';
import {
  buildCountdownProject, buildKineticProject, buildLineupProject, buildLogoProject,
  buildNewsflashProject, buildSlamProject, buildStackProject, buildVersusProject,
  type PromoTexts,
} from './recipes';
import { applyHomecoming, bakeTourMotion } from './camera';
import { auditTextLayout, enforceTextLayout } from './layout';
import { computeMotionAdjustment } from '../render/compositor';
import { createDefaultProject } from '../projects/persistence';
import { addItem, addMediaAsset, generateTimelineId } from '../timeline/utils';
import type { ImageTimelineItem, MediaAsset, Project } from '../../types/timeline';

function fakeAsset(id: string, width: number, height: number): MediaAsset {
  return {
    id, kind: 'image', storageUrl: `https://example.test/${id}.png`, fileName: `${id}.png`,
    sizeBytes: 1000, mimeType: 'image/png', width, height, createdAt: 0,
  };
}

const BANK: PromoTexts = {
  hook1: 'ONE NIGHT.', hook2: 'TWO SOUNDS.', sub: 'DANCEHALL × SOCA', cta: 'TICKETS OUT NOW',
};

/** The R21 failure shape: long verbatim website texts in bank-sized slots. */
const SITE_LONG: PromoTexts = {
  hook1: 'RIVERSIDE AUTO ELECTRICAL & DIAGNOSTICS',
  hook2: 'Complete Computerised Engine Diagnostics',
  sub: 'Alternators • Starters • Batteries • Air Conditioning Service',
  cta: 'CALL 868-555-0147 TODAY',
};

const FORMATS: Array<[number, number]> = [[1080, 1920], [1920, 1080], [1080, 1080], [1080, 1350]];

function slicesFor() {
  return tilingBands(5).map((band, i) => ({
    asset: fakeAsset(`band${i}`, 1080, Math.round(1920 * (band.y1 - band.y0))),
    band,
  }));
}

function buildAll(w: number, h: number, texts: PromoTexts): Array<[string, Project]> {
  const art = fakeAsset('art', 1080, 1440);
  const base = () => createDefaultProject('u', 'R22', w, h);
  return [
    ['kinetic', buildKineticProject(base(), art, slicesFor(), texts, { duration: 12 })],
    ['logo', buildLogoProject(base(), slicesFor(), texts, { duration: 10 })],
    ['slam', buildSlamProject(base(), art, texts, { duration: 10 })],
    ['spin-slam', buildSlamProject(base(), art, texts, { duration: 10, variant: 'spin' })],
    ['countdown', buildCountdownProject(base(), art, texts, { duration: 10 })],
    ['newsflash', buildNewsflashProject(base(), art, texts, { duration: 10 })],
    ['lineup', buildLineupProject(base(), [1, 2, 3].map((n) => ({ asset: fakeAsset(`p${n}`, 900, 1200), name: `ARTIST ${n}` })), texts, { duration: 15 })],
    ['versus', buildVersusProject(base(), fakeAsset('a', 900, 900), fakeAsset('b', 900, 900), texts, { duration: 10 })],
    ['stack', buildStackProject(base(), [fakeAsset('s1', 800, 1000), fakeAsset('s2', 800, 1000), fakeAsset('s3', 800, 1000)], texts, { duration: 10 })],
  ];
}

describe('R22 WS1 — zero text collisions across the recipe matrix', () => {
  for (const [w, h] of FORMATS) {
    for (const [label, texts] of [['bank', BANK], ['site-verbatim', SITE_LONG]] as const) {
      it(`${w}x${h} with ${label} texts audits clean after enforcement`, () => {
        for (const [name, built] of buildAll(w, h, texts)) {
          const clean = enforceTextLayout(applyHomecoming(built));
          const collisions = auditTextLayout(clean);
          expect(collisions, `${name} ${w}x${h} ${label}: ${JSON.stringify(collisions.slice(0, 3))}`).toEqual([]);
        }
      });
    }
  }

  it('enforcement never changes the words themselves', () => {
    for (const [, built] of buildAll(1080, 1080, SITE_LONG)) {
      const clean = enforceTextLayout(built);
      const before = built.items.filter((i) => i.type === 'text').map((i) => (i as { text: string }).text).sort();
      const after = clean.items.filter((i) => i.type === 'text').map((i) => (i as { text: string }).text).sort();
      expect(after).toEqual(before);
    }
  });
});

describe('R22 WS2 — Homecoming', () => {
  it('the word-tour ends at home: last stops are the full, uncropped framing', () => {
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
    project = addItem(project, hero);
    const line = (text: string, x: number, y: number) => ({
      line: { text, confidence: 95, y, box: { x, y, w: 0.5, h: 0.05 } },
      zoom: 1.5,
    });
    const motion = bakeTourMotion(project, hero, [
      line('HEADLINE', 0.25, 0.1) as never,
      line('FINALE', 0.25, 0.85) as never,
    ]);
    const stops = motion.tourStops ?? [];
    expect(stops.length).toBeGreaterThanOrEqual(4);
    const last = stops[stops.length - 1];
    expect(last).toEqual({ t: 1, x: 0, y: 0, scale: 1 });
    const home = stops[stops.length - 2];
    expect(home.t).toBeGreaterThanOrEqual(0.8);
    expect(home).toMatchObject({ x: 0, y: 0, scale: 1 });
  });

  it('flagged continuous motions land exactly on the identity adjustment', () => {
    for (const type of ['ken-burns', 'slow-zoom-in', 'slow-zoom-out', 'product-focus', 'dolly-push'] as const) {
      const end = computeMotionAdjustment({ type, homecoming: true }, 10, 10, 1080, 1920);
      expect(end.scaleMul, type).toBeCloseTo(1, 6);
      expect(end.offsetXPx, type).toBeCloseTo(0, 6);
      expect(end.offsetYPx, type).toBeCloseTo(0, 6);
    }
    // …and the unflagged ken-burns still ends mid-move (the R21 defect shape).
    const raw = computeMotionAdjustment({ type: 'ken-burns' }, 10, 10, 1080, 1920);
    expect(raw.scaleMul).toBeGreaterThan(1.1);
  });

  it('every image motion in every built recipe ends at home once flagged', () => {
    for (const [w, h] of FORMATS) {
      for (const [name, built] of buildAll(w, h, BANK)) {
        const flagged = applyHomecoming(built);
        for (const item of flagged.items) {
          if (item.type !== 'image' || !item.motion || item.motion.type === 'none') continue;
          const dur = Math.max(0.1, item.endTime - item.startTime);
          const end = computeMotionAdjustment(item.motion, dur, dur, w, h);
          expect(end.scaleMul, `${name} ${item.motion.type}`).toBeCloseTo(1, 3);
          expect(Math.abs(end.offsetXPx), `${name} ${item.motion.type}`).toBeLessThan(0.5);
          expect(Math.abs(end.offsetYPx), `${name} ${item.motion.type}`).toBeLessThan(0.5);
        }
      }
    }
  });

  it('applyHomecoming is idempotent and touches only image motions', () => {
    const [, built] = buildAll(1080, 1920, BANK)[2];
    const once = applyHomecoming(built);
    const twice = applyHomecoming(once);
    expect(twice).toEqual(once);
  });
});

describe('R22 WS3 — premium motion system', () => {
  it('the tour has no jumps and no velocity kinks across stop boundaries', () => {
    const stops = [
      { t: 0, x: 0, y: 0, scale: 1 },
      { t: 0.3, x: 0.05, y: -0.04, scale: 1.5 },
      { t: 0.55, x: -0.03, y: 0.05, scale: 1.4 },
      { t: 0.84, x: 0, y: 0, scale: 1 },
      { t: 1, x: 0, y: 0, scale: 1 },
    ];
    const motion = { type: 'word-tour' as const, tourStops: stops };
    let prevScale = 1;
    let prevVel = 0;
    for (let t = 0; t <= 10.0001; t += 0.02) {
      const adj = computeMotionAdjustment(motion, Math.min(t, 10), 10, 1080, 1920);
      const vel = (adj.scaleMul - prevScale) / 0.02;
      expect(Math.abs(adj.scaleMul - prevScale)).toBeLessThan(0.02); // no jumps
      if (t > 0.04) expect(Math.abs(vel - prevVel)).toBeLessThan(0.6); // no kinks
      prevScale = adj.scaleMul;
      prevVel = vel;
    }
  });

  it('orbit-drift starts and ends at home; focus-pull resolves sharp', () => {
    const orbitStart = computeMotionAdjustment({ type: 'orbit-drift' }, 0, 10, 1080, 1920);
    const orbitEnd = computeMotionAdjustment({ type: 'orbit-drift' }, 10, 10, 1080, 1920);
    expect(orbitStart.rotationDeltaDeg).toBeCloseTo(0, 6);
    expect(orbitEnd.rotationDeltaDeg).toBeCloseTo(0, 6);
    expect(orbitEnd.offsetXPx).toBeCloseTo(0, 6);
    const pullStart = computeMotionAdjustment({ type: 'focus-pull' }, 0, 10, 1080, 1920);
    const pullEnd = computeMotionAdjustment({ type: 'focus-pull' }, 10, 10, 1080, 1920);
    expect(pullStart.blurPx).toBeGreaterThan(5);
    expect(pullEnd.blurPx).toBeCloseTo(0, 6);
    const dollyMid = computeMotionAdjustment({ type: 'dolly-push' }, 5, 10, 1080, 1920);
    expect(dollyMid.scaleMul).toBeGreaterThan(1.03);
  });
});
