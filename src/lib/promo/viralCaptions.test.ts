import { describe, it, expect } from 'vitest';
import { convertPromoTextToCaptions, wordTimingsForLine } from './viralCaptions';
import { buildSlamProject } from './recipes';
import { createDefaultProject } from '../projects/persistence';
import type { MediaAsset } from '../../types/timeline';

const asset: MediaAsset = {
  id: 'art1', type: 'image', fileName: 'poster.png', fileSize: 10, mimeType: 'image/png',
  storageUrl: 'https://example.com/poster.png', width: 1080, height: 1920,
} as unknown as MediaAsset;

describe('wordTimingsForLine', () => {
  it('words land on beats when the counts match', () => {
    const words = wordTimingsForLine('ONE NIGHT TWO SOUNDS', 2.4, [0, 0.6, 1.2, 1.8]);
    expect(words.map((w) => w.start)).toEqual([0, 0.6, 1.2, 1.8]);
    expect(words[3].end).toBe(2.4);
  });

  it('more beats than words: words fire on the first beats, the last one holds', () => {
    const words = wordTimingsForLine('TICKETS OUT NOW', 4.4, [0.36, 0.86, 1.36, 1.86, 2.36]);
    expect(words.map((w) => w.start)).toEqual([0.36, 0.86, 1.36]);
    expect(words[2].end).toBe(4.4);
  });

  it('a lone dash is not a word', () => {
    const words = wordTimingsForLine('SAT - DEC 20', 2, []);
    expect(words.map((w) => w.text)).toEqual(['SAT', 'DEC', '20']);
  });

  it('no beats: the window splits evenly', () => {
    const words = wordTimingsForLine('TICKETS OUT NOW', 1.5, []);
    expect(words.map((w) => w.start)).toEqual([0, 0.5, 1]);
    expect(words[2].end).toBe(1.5);
  });

  it('words never run backwards and always cover the window', () => {
    const words = wordTimingsForLine('A B C D E', 3, [0.2, 0.9]);
    for (let i = 1; i < words.length; i++) expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].start);
    expect(words[words.length - 1].end).toBe(3);
  });
});

describe('convertPromoTextToCaptions', () => {
  it('the slam hook becomes a beat-timed caption; design text stays', () => {
    const base = createDefaultProject('u1', 'Viral', 1080, 1920, { watermarkEnabled: false });
    const project = buildSlamProject(base, asset, {
      hook1: 'ONE NIGHT.', hook2: 'TWO SOUNDS.', sub: 'SAT - DEC 20', cta: 'TICKETS OUT NOW',
    }, { duration: 12 });
    const beats = Array.from({ length: 24 }, (_, i) => i * 0.5);
    const out = convertPromoTextToCaptions(project, ['ONE NIGHT.', 'TWO SOUNDS.', 'SAT - DEC 20', 'TICKETS OUT NOW'], beats);
    const captions = out.items.filter((i) => i.type === 'caption');
    expect(captions.length).toBeGreaterThanOrEqual(2);
    const hook = captions.find((c) => c.type === 'caption' && c.words.map((w) => w.text).join(' ').includes('NIGHT'));
    expect(hook).toBeTruthy();
    if (hook && hook.type === 'caption') {
      expect(hook.captionStyleId).toBe('viral-gold-pop');
      expect(hook.words.length).toBe(2);
      expect(hook.words[0].start).toBeGreaterThanOrEqual(0); // first beat inside the window, relative
      expect(hook.words[0].start).toBeLessThanOrEqual(0.5);
    }
    // The converted text items are gone (no double-render).
    const textsLeft = out.items.filter((i) => i.type === 'text');
    for (const t of textsLeft) {
      if (t.type === 'text') expect(['ONE NIGHT.', 'TWO SOUNDS.']).not.toContain(t.text);
    }
  });

  it('R19: the size tier lands on the converted captions', () => {
    const project = buildSlamProject(createDefaultProject('u1', 'T', 1080, 1920, { watermarkEnabled: false }), asset, { hook1: 'ONE NIGHT.' }, { duration: 12 });
    const out = convertPromoTextToCaptions(project, ['ONE NIGHT.'], [], 'viral-gold-pop', 1.25);
    const caps = out.items.filter((i) => i.type === 'caption');
    expect(caps.length).toBeGreaterThan(0);
    for (const c of caps) if (c.type === 'caption') expect(c.sizeScale).toBe(1.25);
  });

  it('no matching field text: the project passes through untouched', () => {
    const base = createDefaultProject('u1', 'Plain', 1080, 1920, { watermarkEnabled: false });
    const project = buildSlamProject(base, asset, { hook1: 'HELLO', hook2: '', sub: '', cta: '' }, { duration: 8 });
    expect(convertPromoTextToCaptions(project, ['SOMETHING ELSE'], [])).toBe(project);
  });
});
