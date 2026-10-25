import { describe, expect, it } from 'vitest';
import { FONT_OPTIONS, captionStyleFamily, fontsUsedInProject } from './fonts';

describe('R19 font library', () => {
  it('carries twelve premium faces including the two additions', () => {
    expect(FONT_OPTIONS).toHaveLength(12);
    expect(FONT_OPTIONS.map((f) => f.family)).toContain('Titan One');
    expect(FONT_OPTIONS.map((f) => f.family)).toContain('Alfa Slab One');
  });

  it('caption styles resolve to their loadable families', () => {
    expect(captionStyleFamily('viral-gold-pop')).toBe('Anton');
    expect(captionStyleFamily('karaoke-gold')).toBe('Montserrat');
    expect(captionStyleFamily('bungee-bashment')).toBe('Bungee');
    expect(captionStyleFamily('classic')).toBeNull(); // Arial — nothing to load
    expect(captionStyleFamily('nope')).toBeNull();
  });

  it('fontsUsedInProject collects caption faces alongside text faces', () => {
    const project = {
      items: [
        { type: 'text', font: 'Bebas Neue' },
        { type: 'caption', captionStyleId: 'viral-gold-pop' },
        { type: 'caption', captionStyleId: 'classic' },
        { type: 'video' },
      ],
    } as never;
    expect(fontsUsedInProject(project).sort()).toEqual(['Anton', 'Bebas Neue']);
  });
});
