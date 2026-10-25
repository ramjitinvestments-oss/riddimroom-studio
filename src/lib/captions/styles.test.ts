import { describe, expect, it } from 'vitest';
import { CAPTION_SIZE_TIERS, CAPTION_STYLES, getCaptionStyle, resolveCaptionFontPx } from './styles';

describe('R19 caption catalog — premium faces and the size system', () => {
  it('style ids are unique and every style resolves', () => {
    const ids = CAPTION_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(getCaptionStyle(id).id).toBe(id);
  });

  it('the flagship styles wear premium faces at true weights', () => {
    const viral = getCaptionStyle('viral-gold-pop');
    expect(viral.fontFamily).toContain('Anton');
    expect(viral.fontWeight).toBe(400); // Anton is single-weight — never faux-bold
    expect(viral.fontSize).toBe(88);
    const karaoke = getCaptionStyle('karaoke-gold');
    expect(karaoke.fontFamily).toContain('Montserrat');
    expect(karaoke.fontWeight).toBe(900);
    expect(getCaptionStyle('soca-pop').fontFamily).toContain('Bungee');
    expect(getCaptionStyle('anton-slam').fontSize).toBe(94);
    expect(getCaptionStyle('titan-chunk').fontFamily).toContain('Titan One');
    expect(getCaptionStyle('alfa-poster').fontFamily).toContain('Alfa Slab One');
  });

  it('sizes are authored at the 1080 reference and scale with the canvas', () => {
    const viral = getCaptionStyle('viral-gold-pop');
    expect(resolveCaptionFontPx(viral, 1080)).toBe(88);
    expect(resolveCaptionFontPx(viral, 540)).toBe(44);
    expect(resolveCaptionFontPx(viral, 2160)).toBe(176);
  });

  it('size tiers multiply the authored size', () => {
    const viral = getCaptionStyle('viral-gold-pop');
    expect(resolveCaptionFontPx(viral, 1080, CAPTION_SIZE_TIERS.S)).toBeCloseTo(70.4);
    expect(resolveCaptionFontPx(viral, 1080, CAPTION_SIZE_TIERS.L)).toBe(110);
    expect(resolveCaptionFontPx(viral, 1080, CAPTION_SIZE_TIERS.XL)).toBeCloseTo(136.4);
  });
});
