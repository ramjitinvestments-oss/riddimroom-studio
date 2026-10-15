import { describe, it, expect } from 'vitest';
import { CAPTION_STYLES, getCaptionStyle } from './styles';

/**
 * Phase 2.3 — the style catalog is consumed by BOTH the shared compositor
 * (preview + export) and the inspector's preview chips, so its integrity is
 * worth pinning: unique ids, resolvable lookups, and a karaoke style that
 * actually carries the highlight the compositor reads.
 */
describe('caption style catalog', () => {
  it('has unique ids', () => {
    const ids = CAPTION_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('getCaptionStyle resolves known ids and falls back to the first style for unknown ones', () => {
    expect(getCaptionStyle('gold-premium').label).toBe('Gold Premium');
    expect(getCaptionStyle('no-such-style')).toBe(CAPTION_STYLES[0]);
  });

  it('the karaoke style carries a highlightColor distinct from its base color', () => {
    const karaoke = getCaptionStyle('karaoke-gold');
    expect(karaoke.highlightColor).toBeTruthy();
    expect(karaoke.highlightColor).not.toBe(karaoke.color);
  });

  it('every style has renderable params (positive size, non-empty family/color)', () => {
    for (const style of CAPTION_STYLES) {
      expect(style.fontSize).toBeGreaterThan(0);
      expect(style.fontFamily.length).toBeGreaterThan(0);
      expect(style.color.length).toBeGreaterThan(0);
    }
  });
});
