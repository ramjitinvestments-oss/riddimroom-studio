/**
 * R37 Phase 1 — reelMeta: the reel-strip view-model over all 20 real
 * templates (card models, Stage-A posters, chip filtering, height
 * budget). Pure functions over the real catalog — no fixtures.
 */
import { describe, it, expect } from 'vitest';
import {
  STUDIO_TEMPLATES,
  TEMPLATE_CATEGORIES,
  getTemplate,
  templatesByCategory,
  type StudioTemplate,
} from '../templates';
import { colorGradeToFilter, getGradePreset } from '../grades';
import { getCaptionStyle } from '../captions/styles';
import {
  REEL_CHIPS,
  REEL_LAYOUT,
  REEL_STRIP_HEIGHT,
  reelCardModel,
  reelChooserHeight,
  reelFilter,
} from './reelMeta';

function byId(id: string): StudioTemplate {
  const t = getTemplate(id);
  if (!t) throw new Error(`missing template ${id}`);
  return t;
}

describe('R37 reelMeta — layout budget', () => {
  it('exposes the plan geometry and computes the 268px chooser height', () => {
    // R40 re-derived: chips are 44px targets (the 44px accessibility
    // standard, P-34) and the two-tap hint line sits inside the
    // chooser budget (P-40): 20 + 8 + 44 + 8 + 164 + 8 + 16 = 268.
    expect(REEL_LAYOUT).toMatchObject({
      cardWidth: 88,
      cardHeight: 156,
      chipsHeight: 44,
      headerHeight: 20,
      hintHeight: 16,
      gap: 8,
      stripPaddingY: 4,
    });
    expect(REEL_STRIP_HEIGHT).toBe(164);
    expect(reelChooserHeight()).toBe(268);
    expect(reelChooserHeight()).toBeLessThanOrEqual(268);
  });
});

describe('R37 reelMeta — card models for all 20', () => {
  it('every template maps to a valid card model', () => {
    expect(STUDIO_TEMPLATES).toHaveLength(20);
    for (const t of STUDIO_TEMPLATES) {
      const m = reelCardModel(t);
      expect(m.id).toBe(t.id);
      expect(m.name).toBe(t.name);
      expect(m.kind).toBe(t.kind);
      expect(m.kindLabel).toBe(t.kind === 'hook' ? 'Hook' : 'Full edit');
      expect(m.durationLabel).toMatch(/^\d+(\.\d+)?s$/);
      expect(m.accentColor).toBe(t.accentColor);
      if (t.kind === 'full') {
        expect(m.slotCount).toBe(t.slots?.length);
        expect(m.poster.slotSegments).toHaveLength(t.slots?.length ?? 0);
        expect(m.poster.hookText).toBeNull();
      } else {
        expect(m.slotCount).toBeNull();
        expect(m.poster.slotSegments).toEqual([]);
        expect(m.poster.hookText).not.toBeNull();
        expect(m.frameAspect).toBeNull();
      }
    }
  });

  it('duration labels trim the trailing .0', () => {
    expect(reelCardModel(byId('gold-smash-intro')).durationLabel).toBe('2.5s');
    expect(reelCardModel(byId('fete-countdown')).durationLabel).toBe('3.5s');
    expect(reelCardModel(byId('glitch-hook')).durationLabel).toBe('2s');
    expect(reelCardModel(byId('viral-hook-story')).durationLabel).toBe('30s');
    expect(reelCardModel(byId('music-video')).durationLabel).toBe('45s');
  });

  it('frame chip appears only for non-9:16 frames', () => {
    expect(reelCardModel(byId('music-video')).frameAspect).toBe('16:9');
    expect(reelCardModel(byId('commercial-30')).frameAspect).toBe('16:9');
    expect(reelCardModel(byId('product-ad-15')).frameAspect).toBe('1:1');
    expect(reelCardModel(byId('testimonial')).frameAspect).toBe('4:5');
    // Designed for 9:16 — the default — so no chip.
    expect(reelCardModel(byId('viral-hook-story')).frameAspect).toBeNull();
    expect(reelCardModel(byId('event-promo')).frameAspect).toBeNull();
    expect(reelCardModel(byId('podcast-clip')).frameAspect).toBeNull();
  });

  it('slot counts come from the real slot plans', () => {
    expect(reelCardModel(byId('product-ad-15')).slotCount).toBe(4);
    expect(reelCardModel(byId('viral-hook-story')).slotCount).toBe(5);
    expect(reelCardModel(byId('music-video')).slotCount).toBe(5);
  });
});

describe('R37 reelMeta — Stage-A posters', () => {
  it('grade filter is the compositor filter of the template grade preset', () => {
    const poster = reelCardModel(byId('viral-hook-story')).poster;
    expect(poster.gradeFilter).toBe(colorGradeToFilter(getGradePreset('vivid-party')?.grade));
    expect(poster.gradeFilter).not.toBe('');
    // Hooks carry no grade — unfiltered poster.
    expect(reelCardModel(byId('gold-smash-intro')).poster.gradeFilter).toBe('');
    expect(reelCardModel(byId('podcast-clip')).poster.gradeFilter).toBe(
      colorGradeToFilter(getGradePreset('soft-podcast')?.grade),
    );
  });

  it('gradient is the accent over the old monogram dark base', () => {
    const { gradientCss } = reelCardModel(byId('gold-smash-intro')).poster;
    expect(gradientCss).toContain('rgba(255, 209, 0, 0.16)');
    expect(gradientCss).toContain('linear-gradient(135deg, #161616 0%, #0a0a0a 100%)');
    // A white-accent template glows white, not gold — derived, not fixed.
    expect(reelCardModel(byId('split-reveal')).poster.gradientCss).toContain('rgba(255, 255, 255, 0.16)');
  });

  it('hook headline + hookText come from the first element, type from the caption style', () => {
    const model = reelCardModel(byId('gold-smash-intro'));
    expect(model.poster.hookText).toEqual({ text: 'YOUR TITLE', color: '#FFD100' });
    const style = getCaptionStyle('gold-premium');
    expect(model.poster.headline).toEqual({
      text: 'YOUR TITLE',
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight ?? 700,
      color: '#FFD100',
      uppercase: !!style.uppercase,
    });
  });

  it('full-edit headline is the template headlineText in its caption style', () => {
    const model = reelCardModel(byId('viral-hook-story'));
    const style = getCaptionStyle('viral');
    expect(model.poster.headline).toEqual({
      text: 'WATCH THIS',
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight ?? 700,
      color: style.color,
      uppercase: !!style.uppercase,
    });
    expect(model.poster.headline?.uppercase).toBe(true);
  });

  it('a full edit with no headlineText gets a null headline (podcast-clip)', () => {
    const model = reelCardModel(byId('podcast-clip'));
    expect(model.poster.headline).toBeNull();
    // …but its slot bars still carry the card.
    expect(model.poster.slotSegments.map((s) => s.name)).toEqual(['Cold Open', 'Conversation', 'Insight', 'Outro']);
  });

  it('slot segment fractions are proportional and sum to 1', () => {
    for (const t of STUDIO_TEMPLATES.filter((x) => x.kind === 'full')) {
      const segs = reelCardModel(t).poster.slotSegments;
      const sum = segs.reduce((a, s) => a + s.fraction, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
      segs.forEach((seg, i) => {
        expect(seg.name).toBe(t.slots?.[i].name);
        expect(seg.fraction).toBeCloseTo((t.slots?.[i].durationSeconds ?? 0) / t.durationSeconds, 9);
      });
    }
  });
});

describe('R37 reelMeta — chips + filtering', () => {
  it('chips are All · Hooks · Full edits · the 8 categories, in order', () => {
    expect(REEL_CHIPS).toHaveLength(11);
    expect(REEL_CHIPS.slice(0, 3)).toEqual([
      { id: 'all', label: 'All' },
      { id: 'hooks', label: 'Hooks' },
      { id: 'full', label: 'Full edits' },
    ]);
    expect(REEL_CHIPS.slice(3).map((c) => c.id)).toEqual([...TEMPLATE_CATEGORIES]);
    expect(REEL_CHIPS.slice(3).map((c) => c.label)).toEqual([...TEMPLATE_CATEGORIES]);
  });

  it('reelFilter counts: all 20, hooks 10, full 10, categories match the catalog', () => {
    expect(reelFilter(STUDIO_TEMPLATES, 'all')).toHaveLength(20);
    expect(reelFilter(STUDIO_TEMPLATES, 'hooks')).toHaveLength(10);
    expect(reelFilter(STUDIO_TEMPLATES, 'full')).toHaveLength(10);
    expect(reelFilter(STUDIO_TEMPLATES, 'hooks').every((t) => t.kind === 'hook')).toBe(true);
    expect(reelFilter(STUDIO_TEMPLATES, 'full').every((t) => t.kind === 'full')).toBe(true);
    for (const c of TEMPLATE_CATEGORIES) {
      const filtered = reelFilter(STUDIO_TEMPLATES, c);
      expect(filtered).toHaveLength(templatesByCategory(c).length);
      expect(filtered.length).toBeGreaterThan(0);
      expect(filtered.every((t) => t.category === c)).toBe(true);
    }
  });

  it("'all' keeps catalog order (hooks first, as the sections presented them)", () => {
    const ids = reelFilter(STUDIO_TEMPLATES, 'all').map((t) => t.id);
    expect(ids).toEqual(STUDIO_TEMPLATES.map((t) => t.id));
    expect(ids[0]).toBe('gold-smash-intro');
    expect(ids.indexOf('viral-hook-story')).toBe(10);
  });
});
