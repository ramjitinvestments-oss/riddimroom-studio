import { describe, it, expect } from 'vitest';
import { campaignFileName, parseEventDate, planCampaign } from './campaign';

const FLYER_TEXTS = {
  hook1: 'ONE NIGHT.',
  hook2: 'TWO SOUNDS.',
  sub: 'SAT - DEC 20 - THE GRAND HALL',
  cta: 'TICKETS OUT NOW',
};

describe('planCampaign — event flyer', () => {
  const plan = planCampaign({
    texts: FLYER_TEXTS,
    masterRecipe: 'kinetic-build',
    masterFormatId: '9:16',
    kind: 'flyer',
    altHookPairs: [['LIVE', 'ON STAGE']],
    font: 'Anton',
  });

  it('builds the full 8-piece set with a countdown series', () => {
    expect(plan.seriesKind).toBe('countdown');
    expect(plan.pieces).toHaveLength(8);
    expect(plan.pieces.map((p) => p.id)).toEqual([
      'master', 'alt-1', 'series-7d', 'series-48h', 'series-day', 'alt-2', 'format-1', 'format-2',
    ]);
  });

  it('the master keeps the user recipe, format and words, font included', () => {
    const master = plan.pieces[0];
    expect(master.recipe).toBe('kinetic-build');
    expect(master.formatId).toBe('9:16');
    expect(master.texts.hook1).toBe('ONE NIGHT.');
    expect(master.texts.font).toBe('Anton');
    expect(plan.pieces.every((p) => p.texts.font === 'Anton')).toBe(true);
  });

  it('alt hook 1 uses the real alternate pair on a rotated recipe', () => {
    const alt = plan.pieces[1];
    expect(alt.label).toBe('Alt hook 1');
    expect(alt.hookChanged).toBe(true);
    expect(alt.texts.hook1).toBe('LIVE');
    expect(alt.texts.hook2).toBe('ON STAGE');
    expect(alt.recipe).not.toBe('kinetic-build');
    expect(alt.scheduleLabel).toBe('Post 5 days before');
  });

  it('countdown rungs carry distinct supporting lines: date first, headline next', () => {
    const [d7, h48, day] = plan.pieces.slice(2, 5);
    expect(d7.texts.hook1).toBe('7 DAYS');
    expect(d7.texts.hook2).toBe('TO GO');
    expect(d7.texts.sub).toBe('SAT - DEC 20 - THE GRAND HALL');
    expect(d7.texts.cta).toBe('TICKETS OUT NOW');
    expect(h48.texts.sub).toBe('ONE NIGHT. TWO SOUNDS.');
    expect(d7.recipe).toBe('countdown');
    expect(h48.texts.hook1).toBe('48 HOURS');
    expect(day.texts.hook1).toBe('TODAY');
    expect(day.scheduleLabel).toBe('Post on the day — morning');
  });

  it('format cuts re-stage the master square and wide', () => {
    const formats = plan.pieces.slice(6);
    expect(formats.map((p) => p.formatId)).toEqual(['1:1', '16:9']);
    expect(formats[0].texts.hook1).toBe('ONE NIGHT.');
    // kinetic-build needs slices; format cuts fall back to a fast recipe
    expect(formats[0].recipe).toBe('slam');
  });

  it('file names are slugged per piece', () => {
    expect(campaignFileName('Summer Jam Flyer', plan.pieces[0])).toBe('summer-jam-flyer-campaign-master.mp4');
    expect(campaignFileName('Summer Jam Flyer', plan.pieces[2])).toBe('summer-jam-flyer-campaign-countdown-7-days.mp4');
  });
});

describe('planCampaign — business logo (no event)', () => {
  const plan = planCampaign({
    texts: { hook1: 'ELECTRICAL', hook2: '', sub: 'CONCRETE • FLOORING • REMODELING', cta: 'CALL US TODAY' },
    masterRecipe: 'logo-build',
    masterFormatId: '9:16',
    kind: 'logo',
  });

  it('runs a spotlight series, never a countdown', () => {
    expect(plan.seriesKind).toBe('spotlight');
    expect(plan.pieces.some((p) => p.recipe === 'countdown')).toBe(false);
    expect(plan.pieces.map((p) => p.id)).toContain('series-offer');
  });

  it('R24: series cuts keep every field in its own field — no line is promoted', () => {
    // Before R24 the story cut split the SUB into its hook and the
    // offer cut ran the CTA as hook AND CTA (defect B6). Series
    // hooks now come only from the alternates pool; with no pool,
    // the variants keep the master's hook and the sub/CTA stay put.
    const story = plan.pieces.find((p) => p.id === 'series-story')!;
    expect(story.texts.hook1).toBe('ELECTRICAL');
    expect(story.texts.sub).toBe('CONCRETE • FLOORING • REMODELING');
    expect(story.texts.cta).toBe('CALL US TODAY');
    const offer = plan.pieces.find((p) => p.id === 'series-offer')!;
    expect(offer.texts.hook1).toBe('ELECTRICAL');
    expect(offer.texts.cta).toBe('CALL US TODAY');
    expect(offer.scheduleLabel).toBe('Day 7 — push the call to action');
  });

  it('without alternate pairs the alt pieces are rotation cuts, honestly labeled', () => {
    const alt = plan.pieces.find((p) => p.id === 'alt-1')!;
    expect(alt.label).toBe('Alt cut 1');
    expect(alt.hookChanged).toBe(false);
    expect(alt.texts.hook1).toBe('ELECTRICAL');
  });
});

describe('planCampaign — guards', () => {
  it('an alternate pair equal to the master pair is not an alternate', () => {
    const plan = planCampaign({
      texts: FLYER_TEXTS,
      masterRecipe: 'slam',
      masterFormatId: '9:16',
      kind: 'flyer',
      altHookPairs: [['one night.', 'two sounds.']],
    });
    const alt = plan.pieces.find((p) => p.id === 'alt-1')!;
    expect(alt.hookChanged).toBe(false);
    expect(alt.label).toBe('Alt cut 1');
  });

  it('a landscape master gets square + vertical format cuts instead', () => {
    const plan = planCampaign({
      texts: FLYER_TEXTS,
      masterRecipe: 'slam',
      masterFormatId: '16:9',
      kind: 'flyer',
    });
    const formats = plan.pieces.filter((p) => p.role === 'format');
    expect(formats.map((p) => p.formatId)).toEqual(['1:1', '9:16']);
    // a single-art master recipe keeps its identity in format cuts
    expect(formats[0].recipe).toBe('slam');
  });

  it('a date in the sub makes even a portrait event-dated', () => {
    const plan = planCampaign({
      texts: { hook1: 'BIG DAY', hook2: '', sub: 'DEC 20 - CITY HALL', cta: 'RSVP' },
      masterRecipe: 'slam',
      masterFormatId: '9:16',
      kind: 'portrait',
    });
    expect(plan.seriesKind).toBe('countdown');
  });

  it('R15: with rotation pools, no two non-format pieces share the same four words', () => {
    const keyOf = (t: typeof FLYER_TEXTS) =>
      [t.hook1, t.hook2, t.sub, t.cta].map((v) => (v ?? '').toUpperCase()).join('|');
    for (const plan of [
      planCampaign({
        texts: FLYER_TEXTS, masterRecipe: 'slam', masterFormatId: '9:16', kind: 'flyer',
        altHookPairs: [['LIVE', 'ON STAGE'], ['THE BIGGEST', 'NIGHT OF THE YEAR']],
        altSubs: ['THE GRAND HALL - DOWNTOWN', 'DOORS 9PM'],
        altCtas: ['GET YOUR TICKETS', 'LINK IN BIO'],
      }),
      planCampaign({
        texts: { hook1: 'ELECTRICAL', hook2: '', sub: 'CONCRETE • FLOORING • REMODELING', cta: 'CALL US TODAY' },
        masterRecipe: 'slam', masterFormatId: '9:16', kind: 'logo',
        altSubs: ['LICENSED & INSURED', 'FREE ESTIMATES'],
        altCtas: ['CALL FOR A QUOTE', 'BOOK YOUR JOB'],
      }),
      // genre-bank pools alone (no caller pools) must also separate the set
      planCampaign({
        texts: FLYER_TEXTS, masterRecipe: 'slam', masterFormatId: '9:16', kind: 'flyer', genre: 'soca',
      }),
    ]) {
      const seen = new Set<string>();
      for (const piece of plan.pieces) {
        if (piece.role === 'format') continue;
        const key = keyOf(piece.texts as typeof FLYER_TEXTS);
        expect(seen.has(key), `${piece.id} duplicates another piece's words`).toBe(false);
        seen.add(key);
      }
      // format cuts are the master's re-stage: identical words, on purpose
      const master = plan.pieces[0];
      const format = plan.pieces.find((p) => p.role === 'format')!;
      expect(keyOf(format.texts as typeof FLYER_TEXTS)).toBe(keyOf(master.texts as typeof FLYER_TEXTS));
    }
  });

  it('R15: alt pieces rotate sub and CTA, not just the hook', () => {
    const plan = planCampaign({
      texts: FLYER_TEXTS, masterRecipe: 'slam', masterFormatId: '9:16', kind: 'flyer',
      altHookPairs: [['LIVE', 'ON STAGE']],
      altSubs: ['THE GRAND HALL - DOWNTOWN'],
      altCtas: ['GET YOUR TICKETS', 'LINK IN BIO - GO NOW'],
    });
    const alt = plan.pieces.find((p) => p.id === 'alt-1')!;
    expect(alt.texts.sub).toBe('THE GRAND HALL - DOWNTOWN');
    expect(alt.texts.cta).toBe('GET YOUR TICKETS');
    const day = plan.pieces.find((p) => p.id === 'series-day')!;
    expect(day.texts.cta).not.toBe(FLYER_TEXTS.cta);
  });

  it('every piece has a schedule label and a unique slug', () => {
    const plan = planCampaign({
      texts: FLYER_TEXTS,
      masterRecipe: 'slam',
      masterFormatId: '9:16',
      kind: 'flyer',
    });
    expect(plan.pieces.every((p) => p.scheduleLabel.length > 3)).toBe(true);
    expect(new Set(plan.pieces.map((p) => p.slug)).size).toBe(plan.pieces.length);
  });
});

describe('parseEventDate + dated schedule labels (R16)', () => {
  const now = new Date(2026, 9, 25, 12); // Oct 25 2026
  it('parses the poster date line and rolls yearless dates to the next occurrence', () => {
    const d = parseEventDate({ sub: 'SAT - DEC 20 - THE GRAND HALL' }, now);
    expect(d?.getFullYear()).toBe(2026);
    expect(d?.getMonth()).toBe(11);
    expect(d?.getDate()).toBe(20);
    expect(parseEventDate({ sub: 'JAN 5' }, now)?.getFullYear()).toBe(2027);
    expect(parseEventDate({ sub: '12/20/2027' }, now)?.getFullYear()).toBe(2027);
    expect(parseEventDate({ sub: 'THE GRAND HALL' }, now)).toBeNull();
    expect(parseEventDate({ sub: 'FEB 30' }, now)).toBeNull();
  });

  it('the campaign schedule names real post dates', () => {
    const plan = planCampaign({
      texts: { hook1: 'ONE NIGHT.', hook2: 'TWO SOUNDS.', sub: 'SAT - DEC 20 - THE GRAND HALL', cta: 'TICKETS OUT NOW' },
      masterRecipe: 'slam',
      masterFormatId: '9:16',
      kind: 'flyer',
      eventDate: parseEventDate({ sub: 'SAT - DEC 20 - THE GRAND HALL' }, now),
    });
    const byId = Object.fromEntries(plan.pieces.map((p) => [p.id, p.scheduleLabel]));
    expect(byId['master']).toBe('Post Sun Dec 20 — the main push');
    expect(byId['series-7d']).toBe('Post Sun Dec 13');
    expect(byId['series-48h']).toBe('Post Fri Dec 18');
    expect(byId['series-day']).toBe('Post Sun Dec 20 — morning');
    expect(byId['alt-1']).toBe('Post Tue Dec 15');
    expect(byId['alt-2']).toBe('Post Sat Dec 19');
  });
});
