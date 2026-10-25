import { describe, it, expect } from 'vitest';
import { analyzePixels, detectBands, recipeBands, tilingBands } from './analyze';
import {
  buildCountdownProject, buildKineticProject, buildLineupProject, buildLogoProject,
  buildNewsflashProject, buildSlamProject, buildStackProject, buildVersusProject,
} from './recipes';
import { createDefaultProject } from '../projects/persistence';
import { validateProject } from '../timeline/validation';
import type { MediaAsset } from '../../types/timeline';

function fakeAsset(id: string, width: number, height: number): MediaAsset {
  return {
    id,
    kind: 'image',
    storageUrl: `https://example.test/${id}.png`,
    fileName: `${id}.png`,
    sizeBytes: 1000,
    mimeType: 'image/png',
    width,
    height,
    createdAt: 0,
  };
}

describe('promo analysis', () => {
  it('detects stacked content bands on a dark ground', () => {
    const width = 100;
    const height = 1000;
    const scores = new Array<number>(height).fill(0);
    // three content blocks: 50-150, 300-420, 700-760
    for (const [a, b] of [[50, 150], [300, 420], [700, 760]] as const) {
      for (let y = a; y <= b; y++) scores[y] = 200 * width;
    }
    const bands = detectBands(scores, width);
    expect(bands.length).toBe(3);
    expect(bands[0].y0).toBeCloseTo(0.05, 2);
    expect(bands[2].y1).toBeCloseTo(0.761, 2);
  });

  it('classifies a mostly-black landscape image as a logo and finds its strips', () => {
    const width = 60;
    const height = 40;
    const data = new Uint8ClampedArray(width * height * 4);
    // white strip rows 5-10 and 25-31 on black
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const on = (y >= 5 && y <= 10) || (y >= 25 && y <= 31);
        data[i] = data[i + 1] = data[i + 2] = on ? 255 : 0;
        data[i + 3] = 255;
      }
    }
    const a = analyzePixels(data, width, height);
    expect(a.darkFraction).toBeGreaterThan(0.5);
    expect(a.suggestedKind).toBe('logo');
    expect(a.bands.length).toBe(2);
  });

  it('falls back to tiles when content bands are unusable', () => {
    const bands = recipeBands({ width: 10, height: 10, darkFraction: 0, meanLuminance: 0, bands: [], suggestedKind: 'flyer' });
    expect(bands.length).toBe(7);
    expect(tilingBands(4)[3].y1).toBe(1);
  });
});

describe('promo recipe builders', () => {
  it('kinetic build produces a valid project with ordered segments', () => {
    const art = fakeAsset('art', 1080, 1920);
    const slices = tilingBands(5).map((band, i) => ({ asset: fakeAsset(`band${i}`, 1080, Math.round(1920 * (band.y1 - band.y0))), band }));
    const project = buildKineticProject(createDefaultProject('user1', 'Promo'), art, slices, {
      hook1: 'ONE NIGHT.',
      cta: 'TICKETS — LINK IN BIO',
    }, { duration: 12 });
    expect(validateProject(project).valid).toBe(true);
    const images = project.items.filter((i) => i.type === 'image');
    // ambient + 5 bands + shine + CTA card
    expect(images.length).toBe(8);
    const texts = project.items.filter((i) => i.type === 'text');
    expect(texts.length).toBe(2);
    // bands land in order
    const bandItems = images.filter((i) => i.zIndex >= 10 && i.zIndex < 40).sort((a, b) => a.startTime - b.startTime);
    expect(bandItems.length).toBe(5);
    expect(bandItems[0].startTime).toBeLessThan(bandItems[4].startTime);
  });

  it('logo build re-stages strips into a valid project', () => {
    const strips = [
      { asset: fakeAsset('emblem', 800, 500), band: { y0: 0, y1: 0.3 } },
      { asset: fakeAsset('word', 1400, 200), band: { y0: 0.35, y1: 0.5 } },
      { asset: fakeAsset('tag', 1000, 120), band: { y0: 0.55, y1: 0.65 } },
    ];
    const project = buildLogoProject(createDefaultProject('user1', 'Logo'), strips, { cta: 'BOOK NOW' }, { duration: 10 });
    expect(validateProject(project).valid).toBe(true);
    const images = project.items.filter((i) => i.type === 'image');
    expect(images.length).toBe(4); // 3 strips + sheen pass
    const starts = images.map((i) => i.startTime).sort((a, b) => a - b);
    expect(starts[0]).toBe(0.5);
  });

  it('slam build produces a valid two-phase project', () => {
    const art = fakeAsset('lion', 1024, 1536);
    const project = buildSlamProject(createDefaultProject('user1', 'Slam'), art, {
      hook1: 'EVEN KINGS',
      hook2: 'GET TIRED.',
      cta: "BUT KINGS DON'T QUIT.",
    }, { duration: 10 });
    expect(validateProject(project).valid).toBe(true);
    expect(project.items.filter((i) => i.type === 'image').length).toBe(2);
    expect(project.items.filter((i) => i.type === 'text').length).toBe(3);
  });

  it('builders stay valid at 16:9 and 1:1, and skins grade the art', () => {
    const art = fakeAsset('art169', 1200, 800);
    const slices = tilingBands(4).map((band, i) => ({ asset: fakeAsset(`b${i}`, 1200, 200), band }));
    for (const [w, h] of [[1920, 1080], [1080, 1080]] as const) {
      const p = buildKineticProject(createDefaultProject('u', 'F', w, h), art, slices, {}, { duration: 10, skin: 'soca-shine' });
      expect(validateProject(p).valid).toBe(true);
      const graded = p.items.filter((i) => i.type === 'image' && i.colorGrade);
      expect(graded.length).toBeGreaterThan(0);
    }
    const logo = buildLogoProject(createDefaultProject('u', 'L', 1920, 1080), slices.slice(0, 3), {}, { duration: 10 });
    expect(validateProject(logo).valid).toBe(true);
  });
});

describe('promo recipe round 2', () => {
  const art = fakeAsset('main', 1080, 1350);
  const texts = { hook1: 'BIG NEWS', hook2: 'TONIGHT', cta: 'LINK IN BIO', sub: 'SAT • DEC 20' };

  it('countdown builds numbers then lands the CTA', () => {
    const p = buildCountdownProject(createDefaultProject('u', 'CD'), art, texts, { duration: 10 });
    expect(validateProject(p).valid).toBe(true);
    const nums = p.items.filter((i) => i.type === 'text' && ['3', '2', '1'].includes(i.text));
    expect(nums.length).toBe(3);
  });

  it('newsflash stacks headline and lower third', () => {
    const p = buildNewsflashProject(createDefaultProject('u', 'NF'), art, texts, { duration: 10 });
    expect(validateProject(p).valid).toBe(true);
    expect(p.items.filter((i) => i.type === 'text').length).toBe(4);
  });

  it('lineup gives every solo a named segment and a poster finale', () => {
    const entries = [
      { asset: fakeAsset('poster', 1536, 1024), name: 'Cast Poster' },
      { asset: fakeAsset('c1', 800, 1000), name: 'Banna' },
      { asset: fakeAsset('c2', 800, 1000), name: 'Trini' },
    ];
    const p = buildLineupProject(createDefaultProject('u', 'LU'), entries, texts, { duration: 15 });
    expect(validateProject(p).valid).toBe(true);
    const names = p.items.filter((i) => i.type === 'text' && (i.text === 'BANNA' || i.text === 'TRINI'));
    expect(names.length).toBe(2);
  });

  it('versus places two arts and a VS mark', () => {
    const p = buildVersusProject(createDefaultProject('u', 'VS'), fakeAsset('a', 900, 900), fakeAsset('b', 900, 900), texts, { duration: 10 });
    expect(validateProject(p).valid).toBe(true);
    expect(p.items.some((i) => i.type === 'text' && i.text === 'VS')).toBe(true);
  });

  it('flyer stack fans the arts with rotation', () => {
    const p = buildStackProject(createDefaultProject('u', 'ST'), [fakeAsset('s1', 800, 1000), fakeAsset('s2', 800, 1000), fakeAsset('s3', 800, 1000)], texts, { duration: 10 });
    expect(validateProject(p).valid).toBe(true);
    const rotated = p.items.filter((i) => i.type === 'image' && i.rotation !== 0);
    expect(rotated.length).toBeGreaterThanOrEqual(2);
  });

  it('spin slam enters with a spin animation', () => {
    const p = buildSlamProject(createDefaultProject('u', 'SP'), art, texts, { duration: 10, variant: 'spin' });
    expect(validateProject(p).valid).toBe(true);
    const first = p.items.find((i) => i.type === 'image');
    expect(first && first.type === 'image' && first.animation?.entrance).toBe('spin');
  });
});
