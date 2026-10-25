import { describe, it, expect } from 'vitest';
import { summarizePalette } from './analyze';
import { bankSuggestion, suggestedSkinFor } from './suggest';

function solidBuffer(r: number, g: number, b: number, w = 40, h = 40): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return data;
}

describe('summarizePalette (R20)', () => {
  it('a golden image reads warm with itself as the dominant colour', () => {
    const p = summarizePalette(solidBuffer(230, 170, 30), 40, 40);
    expect(p.warmth).toBeGreaterThan(0.5);
    expect(p.colors[0].share).toBeGreaterThan(0.9);
    expect(p.colors[0].hex).toMatch(/^#e/);
  });

  it('a grey image reads zero saturation and neutral warmth', () => {
    const p = summarizePalette(solidBuffer(120, 120, 120), 40, 40);
    expect(p.saturation).toBe(0);
    expect(Math.abs(p.warmth)).toBeLessThan(0.01);
  });

  it('transparent pixels are ignored', () => {
    const data = solidBuffer(255, 0, 0);
    for (let i = 3; i < data.length; i += 8) data[i] = 0; // every other pixel transparent
    const p = summarizePalette(data, 40, 40);
    expect(p.colors[0].share).toBeGreaterThan(0.9);
  });
});

describe('bankSuggestion no-text purposes (R20)', () => {
  it('product gets the business bank + the product sub, never party copy', () => {
    const s = bankSuggestion({ kind: 'portrait', fileName: 'IMG_2041.png', purpose: 'product' });
    expect(s.sub).toBe('QUALITY YOU CAN FEEL');
    expect(s.cta).toBe('DM TO BOOK');
    expect(s.hook1).not.toMatch(/PARTY|SOCA/i);
  });

  it('business purpose dresses a flyer-named file in business copy', () => {
    const s = bankSuggestion({ kind: 'flyer', fileName: 'soca-night-flyer.png', purpose: 'business' });
    expect(['DM TO BOOK', 'BOOK YOUR SPOT', 'CALL TODAY']).toContain(s.cta);
  });

  it("'just the look' is headline-only, from the brand name when saved", () => {
    const s = bankSuggestion({ kind: 'logo', fileName: 'x.png', purpose: 'look', brandName: 'Powerline Sounds' });
    expect(s.hook1).toBe('POWERLINE');
    expect(s.hook2).toBe('SOUNDS');
    expect(s.sub).toBe('');
    expect(s.cta).toBe('');
  });

  it("a no-text logo's headline is its brand name", () => {
    const s = bankSuggestion({ kind: 'logo', fileName: 'whatever.png', purpose: 'business', brandName: 'G.S.Y.M' });
    expect(s.hook1).toBe('G.S.Y.M');
    expect(s.cta).toBeTruthy();
  });

  it('without a purpose the never-empty contract stands', () => {
    const s = bankSuggestion({ kind: 'portrait', fileName: 'photo.png' });
    expect(s.hook1).toBeTruthy();
    expect(s.cta).toBeTruthy();
  });
});

describe('suggestedSkinFor palette fallback (R20)', () => {
  it('vivid + warm with no genre read suggests soca-shine', () => {
    expect(suggestedSkinFor('generic', 'flyer', { warmth: 0.2, saturation: 0.6, meanLuminance: 120 })).toBe('soca-shine');
  });
  it('dark with no genre read suggests dancehall-raw', () => {
    expect(suggestedSkinFor('generic', 'flyer', { warmth: 0, saturation: 0.3, meanLuminance: 40 })).toBe('dancehall-raw');
  });
  it('washed-out with no genre read suggests corporate-clean', () => {
    expect(suggestedSkinFor('generic', 'flyer', { warmth: 0, saturation: 0.1, meanLuminance: 120 })).toBe('corporate-clean');
  });
  it('a real genre still wins over the palette', () => {
    expect(suggestedSkinFor('gospel', 'flyer', { warmth: 0.2, saturation: 0.6, meanLuminance: 120 })).toBe('gospel-light');
  });
});
