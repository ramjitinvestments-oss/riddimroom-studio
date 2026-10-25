import { describe, it, expect } from 'vitest';
import { classifyReadout, type OcrLine } from './readout';

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

  it('the realtor banner yields its printed CTA and genre despite noise', () => {
    const r = classifyReadout(BANNER, { kind: 'flyer', fileName: 'banner.png' });
    expect(r.fields.cta).toContain('TALK ABOUT YOUR NEXT MOVE');
    expect(r.genre).toBe('realestate');
    expect(r.lines.length).toBeGreaterThanOrEqual(4);
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
