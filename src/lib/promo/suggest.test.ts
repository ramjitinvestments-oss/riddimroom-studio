import { describe, it, expect } from 'vitest';
import {
  bankSuggestion,
  cycleAlternate,
  fieldAlternates,
  genreForContext,
  mergeIntoUntouched,
  posterAlternates,
  posterSuggestion,
  splitHeadline,
  type NoTextPurpose,
  type SuggestionContext,
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

describe('R23 WS3 — headline poster bank', () => {
  const contexts: Array<[NoTextPurpose, SuggestionContext]> = [
    ['event', { kind: 'flyer', fileName: 'launch-night.png', purpose: 'event' }],
    ['product', { kind: 'portrait', fileName: 'candle.png', purpose: 'product' }],
    ['business', { kind: 'logo', fileName: 'plumbing-co.png', purpose: 'business' }],
    ['look', { kind: 'portrait', fileName: 'portrait.png', purpose: 'look' }],
  ];

  it('returns a non-empty headline and sub for every context, in bank convention', () => {
    for (const [label, ctx] of contexts) {
      const s = posterSuggestion(ctx);
      expect(s.headline.trim().length, label).toBeGreaterThan(0);
      expect(s.sub.trim().length, label).toBeGreaterThan(0);
      // Convention: headlines are stamped phrases ending in a period,
      // subs are sentence case.
      expect(s.headline.endsWith('.'), label).toBe(true);
      expect(s.sub[0], label).toBe(s.sub[0].toUpperCase());
      expect(s.sub.slice(1), label).not.toMatch(/[A-Z]{2,}/);
    }
  });

  it('is generic copy — no brand name and no fete wording in any bank', () => {
    for (const [, ctx] of contexts) {
      const all = [
        posterSuggestion(ctx).headline,
        posterSuggestion(ctx).sub,
        ...posterAlternates('headline', ctx),
        ...posterAlternates('sub', ctx),
      ].join(' ');
      expect(all).not.toContain('RiddimRoom');
      expect(all.toLowerCase()).not.toContain('fete');
    }
  });

  it('offers at least 3 alternates per field per context, and they cycle', () => {
    for (const [label, ctx] of contexts) {
      for (const field of ['headline', 'sub'] as const) {
        const alts = posterAlternates(field, ctx);
        expect(alts.length, `${label} ${field}`).toBeGreaterThanOrEqual(3);
        expect(new Set(alts).size, `${label} ${field} unique`).toBe(alts.length);
        expect(cycleAlternate(alts, alts[0]), `${label} ${field} cycle`).toBe(alts[1]);
        expect(cycleAlternate(alts, alts[alts.length - 1]), `${label} ${field} wrap`).toBe(alts[0]);
      }
      // The suggestion itself is the bank's lead pair, so it is in the cycle.
      expect(posterAlternates('headline', ctx)).toContain(posterSuggestion(ctx).headline);
      expect(posterAlternates('sub', ctx)).toContain(posterSuggestion(ctx).sub);
    }
  });

  it('maps purpose-less contexts onto the banks (business genre, portrait look, flyer event)', () => {
    const business = posterSuggestion({ kind: 'logo', fileName: 'salon-booking.png' });
    expect(posterAlternates('headline', { kind: 'logo', fileName: 'salon-booking.png' })).toContain(business.headline);
    const look = posterSuggestion({ kind: 'portrait', fileName: 'img-2041.png' });
    expect(look.headline).toBe(posterSuggestion({ kind: 'portrait', fileName: 'x.png', purpose: 'look' }).headline);
    const event = posterSuggestion({ kind: 'flyer', fileName: 'summer-show.png' });
    expect(event.headline).toBe(posterSuggestion({ kind: 'flyer', fileName: 'x.png', purpose: 'event' }).headline);
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

describe('vision read outcome mapping', () => {
  it('maps endpoint codes to UI outcomes and retries nothing blindly', async () => {
    const { requestVisionRead } = await import('./suggest');
    const fake = (status: number, body: unknown, json = true) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': json ? 'application/json' : 'text/html' },
      });
    const fetcher =
      (res: Response) =>
      async () =>
        res;
    expect((await requestVisionRead('AA', 'tok', fetcher(fake(503, { success: false, code: 'not_configured' })))).outcome).toBe('not-configured');
    expect((await requestVisionRead('AA', 'tok', fetcher(fake(503, { success: false, code: 'busy' })))).outcome).toBe('busy');
    expect((await requestVisionRead('AA', 'tok', fetcher(fake(502, { success: false, code: 'failed' })))).outcome).toBe('failed');
    expect((await requestVisionRead('AA', 'tok', fetcher(fake(200, null, false)))).outcome).toBe('failed');
    const ok = await requestVisionRead(
      'AA',
      'tok',
      fetcher(fake(200, { success: true, suggestion: { hook1: 'BIG', hook2: '', sub: '', cta: 'GO', genre: 'soca' } })),
    );
    expect(ok.outcome).toBe('ok');
    expect(ok.suggestion?.hook1).toBe('BIG');
  });
});

describe('vision read deadline', () => {
  it('an aborted (hung) request resolves as a timeout verdict, never hangs', async () => {
    const { requestVisionRead } = await import('./suggest');
    const hangingFetcher = (_input: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    const started = Date.now();
    const result = await requestVisionRead('AA', 'tok', hangingFetcher as never, 40);
    expect(result.outcome).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
