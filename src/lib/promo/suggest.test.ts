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

describe('real music pack integrity', () => {
  it('every skin maps to a verified, credited, fetchable track', async () => {
    const { ALL_PACK_TRACKS, PROMO_PACK_SHELVES, creditForFileName, packTrackForSkin } = await import('../media/tracks');
    expect(ALL_PACK_TRACKS).toHaveLength(12);
    for (const shelf of Object.values(PROMO_PACK_SHELVES)) expect(shelf).toHaveLength(3);
    for (const track of ALL_PACK_TRACKS) {
      expect(track.url).toMatch(/^https:\/\/upload\.wikimedia\.org\//);
      expect(track.license).toContain('CC BY');
      expect(track.credit).toContain(track.artist);
      expect(creditForFileName(track.fileName)).toBe(track.credit);
    }
    expect(packTrackForSkin('dancehall-raw').title).toBe('Tea Roots');
    expect(packTrackForSkin('soca-shine').title).toBe('Beach Party');
    expect(packTrackForSkin('dancehall-raw', 'dub-feral').title).toBe('Dub Feral');
    expect(packTrackForSkin('dancehall-raw', 'bogus-id').title).toBe('Tea Roots');
    expect(creditForFileName('some-user-upload.mp3')).toBeNull();
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
