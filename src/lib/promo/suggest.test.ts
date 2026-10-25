import { describe, it, expect } from 'vitest';
import {
  bankSuggestion,
  cycleAlternate,
  fieldAlternates,
  genreForContext,
  mergeIntoUntouched,
  splitHeadline,
} from './suggest';
import { sanitizePromoSuggestion } from './vision';
import type { PromoTexts } from './recipes';

describe('auto-fit promo words — the bank', () => {
  it('never returns a blank hook or CTA for any kind', () => {
    for (const kind of ['logo', 'flyer', 'portrait'] as const) {
      const s = bankSuggestion({ kind, fileName: '1000096383.png' });
      expect(s.hook1.trim().length, kind).toBeGreaterThan(0);
      expect(s.cta.trim().length, kind).toBeGreaterThan(0);
    }
  });

  it('a logo is headlined by its own name; an event flyer by its words', () => {
    const logo = bankSuggestion({ kind: 'logo', fileName: 'powerline-realty-group.png' });
    expect(logo.hook1).toContain('POWERLINE');
    const flyer = bankSuggestion({ kind: 'flyer', fileName: 'soca-fete-friday-flyer.png' });
    expect(genreForContext({ kind: 'flyer', fileName: 'soca-fete-friday-flyer.png' })).toBe('soca');
    expect(flyer.cta).toContain('LINK IN BIO');
  });

  it('rendered-type banks never use the word "fete"', () => {
    for (const fileName of ['soca-fete.png', 'dancehall-night.png', 'gospel-concert.png', 'x.png']) {
      const s = bankSuggestion({ kind: 'flyer', fileName });
      expect(`${s.hook1} ${s.hook2} ${s.sub} ${s.cta}`.toLowerCase()).not.toContain('fete');
    }
  });

  it('alternates cycle and wrap; touched fields are never overwritten', () => {
    const ctx = { kind: 'flyer' as const, fileName: 'soca-night.png' };
    const ctas = fieldAlternates('cta', ctx);
    expect(ctas.length).toBeGreaterThan(1);
    expect(cycleAlternate(ctas, ctas[0])).toBe(ctas[1]);
    expect(cycleAlternate(ctas, ctas[ctas.length - 1])).toBe(ctas[0]);

    const texts: PromoTexts = { hook1: 'MY OWN HOOK', hook2: '', cta: '', sub: '' };
    const merged = mergeIntoUntouched(texts, new Set(['hook1']), {
      hook1: 'AUTO HOOK',
      hook2: 'AUTO TWO',
      cta: 'AUTO CTA',
      sub: '',
    });
    expect(merged.hook1).toBe('MY OWN HOOK');
    expect(merged.hook2).toBe('AUTO TWO');
    expect(merged.cta).toBe('AUTO CTA');
    expect(merged.sub).toBe('');
  });

  it('splitHeadline balances words and handles one-word names', () => {
    expect(splitHeadline('ONE NIGHT TWO SOUNDS')).toEqual(['ONE NIGHT', 'TWO SOUNDS']);
    expect(splitHeadline('POWERLINE')).toEqual(['POWERLINE', '']);
  });
});

describe('vision suggestion sanitizing', () => {
  it('coerces junk to safe fields and validates the genre', () => {
    const s = sanitizePromoSuggestion({ hook1: '  BIG   NIGHT ', hook2: 42, sub: null, cta: 'TICKETS', genre: 'SOCA' });
    expect(s.hook1).toBe('BIG NIGHT');
    expect(s.hook2).toBe('');
    expect(s.sub).toBe('');
    expect(s.genre).toBe('soca');
    expect(sanitizePromoSuggestion({ genre: 'jazz' }).genre).toBe('caribbean');
    expect(sanitizePromoSuggestion(null).hook1).toBe('');
  });
});
