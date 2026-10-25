import { describe, it, expect } from 'vitest';
import { classifyReadout, mergeReadoutFields, type OcrLine } from './readout';

// Fixtures are the REAL lines the engine produced in the 2026-10-25
// proof run on the owner's own uploads — not invented samples.
const POSTER: OcrLine[] = [
  { text: 'ONE NIGHT. TWO SOUNDS.', confidence: 96, y: 0.08 },
  { text: 'DANCEHALL x SOCA', confidence: 94, y: 0.2 },
  { text: 'LIVE ON STAGE', confidence: 92, y: 0.74 },
  { text: 'SAT - DEC 20 - THE GRAND HALL', confidence: 92, y: 0.82 },
  { text: 'TICKETS OUT NOW', confidence: 96, y: 0.9 },
];

const BANNER: OcrLine[] = [
  { text: '"The Standard of Excellence"', confidence: 46, y: 0.1 },
  { text: 'REALTOR', confidence: 45, y: 0.3 },
  { text: "LET'S TALK ABOUT YOUR NEXT MOVE.", confidence: 60, y: 0.55 },
  { text: '727-623-8398', confidence: 67, y: 0.7 },
  { text: 'Se habla espanol BUY SELL INVEST | RELOCATE', confidence: 72, y: 0.85 },
];

const LOGO: OcrLine[] = [
  { text: 'S OUNDS +H DO', confidence: 70, y: 0.3 },
  { text: 'LIVE EVENT PRODUCTION', confidence: 96, y: 0.55 },
  { text: 'SOUND LIGHTING STAGE TRUSS', confidence: 79, y: 0.7 },
];

describe('readout classification on the owner proof fixtures', () => {
  it('the concert flyer yields its own hook, sub and CTA', () => {
    const r = classifyReadout(POSTER, { kind: 'flyer', fileName: 'poster.png' });
    expect(r.fields.hook1).toBe('ONE NIGHT.');
    expect(r.fields.hook2).toBe('TWO SOUNDS.');
    expect(r.fields.sub).toBe('SAT - DEC 20 - THE GRAND HALL');
    expect(r.fields.cta).toBe('TICKETS OUT NOW');
    expect(r.genre).toBe('soca');
  });

  it('the realtor banner: its own phone number becomes the CTA (phone beats slogan)', () => {
    const r = classifyReadout(BANNER, { kind: 'flyer', fileName: 'banner.png' });
    expect(r.phone).toBe('727-623-8398');
    expect(r.fields.cta).toBe('CALL 727-623-8398');
    expect(r.genre).toBe('realestate');
    expect(r.lines.length).toBeGreaterThanOrEqual(4);
  });

  it('PROVENANCE LOCK: party bank copy cannot survive a trades read', () => {
    const cloud: OcrLine[] = [
      { text: 'ELECTRICAL', confidence: 92, y: 0.3, box: { x: 0.2, y: 0.3, w: 0.6, h: 0.08 } },
      { text: 'FLOORING', confidence: 88, y: 0.45, box: { x: 0.25, y: 0.45, w: 0.5, h: 0.07 } },
      { text: 'PLUMBING', confidence: 85, y: 0.6, box: { x: 0.25, y: 0.6, w: 0.5, h: 0.07 } },
      { text: 'CALL US', confidence: 90, y: 0.8 },
      { text: '407-616-2569', confidence: 78, y: 0.86 },
    ];
    const r = classifyReadout(cloud, { kind: 'logo', fileName: 'ramjitinvestment.png' });
    expect(r.genre).toBe('trades');
    expect(r.fields.cta).toBe('CALL 407-616-2569');
    expect(r.fields.sub).toContain('ELECTRICAL');
    const bankFilled = { hook1: 'ONE NIGHT.', hook2: 'TWO SOUNDS.', sub: 'ONE NIGHT ONLY', cta: 'TICKETS: LINK IN BIO', font: undefined } as never;
    const merged = mergeReadoutFields(bankFilled, new Set<string>(), r);
    expect(merged.hook1).toBe('ELECTRICAL');
    expect(merged.hook2).toBe('');
    expect(merged.sub).not.toContain('ONE NIGHT');
    expect(merged.cta).toBe('CALL 407-616-2569');
    const serialized = JSON.stringify(merged);
    expect(serialized).not.toContain('TWO SOUNDS');
    expect(serialized).not.toContain('TICKETS');
  });

  it('merge keeps fields the user typed in, even under a headline read', () => {
    const r = classifyReadout(POSTER, { kind: 'flyer', fileName: 'poster.png' });
    const current = { hook1: 'MY OWN HOOK', hook2: '', sub: '', cta: '', font: undefined } as never;
    const merged = mergeReadoutFields(current, new Set(['hook1']), r);
    expect(merged.hook1).toBe('MY OWN HOOK');
    expect(merged.hook2).toBe('TWO SOUNDS.');
  });

  it('the logo yields its tagline as headline and a bank CTA', () => {
    const r = classifyReadout(LOGO, { kind: 'logo', fileName: 'powerline.png' });
    expect(r.headline).toBe('LIVE EVENT PRODUCTION');
    expect(r.genre).toBe('business');
    expect(r.fields.cta).toBeTruthy();
  });

  it('no readable lines: fields stay empty except a safe CTA, genre from kind', () => {
    const r = classifyReadout([], { kind: 'portrait', fileName: 'photo.jpg' });
    expect(r.fields.hook1).toBeUndefined();
    expect(r.fields.cta).toBeTruthy();
    expect(r.lines).toHaveLength(0);
  });

  it('low-confidence garbage never becomes a headline', () => {
    const r = classifyReadout([{ text: 'xQ zZ wobble', confidence: 22, y: 0.05 }], { kind: 'flyer', fileName: 'x.png' });
    expect(r.fields.hook1).toBeUndefined();
    expect(r.lines).toHaveLength(0);
  });
});
