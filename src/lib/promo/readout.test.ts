import { describe, it, expect } from 'vitest';
import { classifyReadout, mergeLineSets, mergeReadoutFields, stripJunkEdges, type OcrLine } from './readout';
import { chooseTourStops } from './camera';

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
    expect(r.fields.sub).toBe('FLOORING • PLUMBING'); // services, headline word excluded
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


  it('the owner word-cloud fixture (real lines from his test art): no garble CTA, no party bleed', () => {
    const cloud: OcrLine[] = [
    { text: "ELECTRICAL", confidence: 95, y: 0.003, box: { x: 0.627, y: 0.003, w: 0.110, h: 0.016 } },
    { text: ". \u00a50?-616-2569COUCRETE RAMTITINVESTMEN CONCRETE", confidence: 24, y: 0.152, box: { x: 0.072, y: 0.152, w: 0.851, h: 0.028 } },
    { text: "i vr RAMTITINVESTMEN ELECTRICAL FLOORING pac RAMTITINVESTMEN RENOVATIONS", confidence: 45, y: 0.294, box: { x: 0.024, y: 0.294, w: 0.950, h: 0.025 } },
    { text: "I) RENOVATIONS CALL VS RAMTITINVESTMEN REMODELING COMCRETE RAMTITINVESTMEN", confidence: 53, y: 0.403, box: { x: 0.070, y: 0.403, w: 0.834, h: 0.032 } },
    { text: "ELecTrICAL \u00a7 g MN caLL vs", confidence: 49, y: 0.551, box: { x: 0.074, y: 0.551, w: 0.872, h: 0.066 } },
    { text: "J 3 ELECTRICAL", confidence: 80, y: 0.587, box: { x: 0.469, y: 0.587, w: 0.476, h: 0.027 } },
    { text: "TILE F333 PAINTING", confidence: 71, y: 0.584, box: { x: 0.072, y: 0.584, w: 0.873, h: 0.068 } },
    { text: "REMODELING CSV, fH CALL Us", confidence: 58, y: 0.638, box: { x: 0.077, y: 0.638, w: 0.868, h: 0.038 } }
    ];
    const r = classifyReadout(cloud, { kind: 'logo', fileName: 'ramjitinvestment.png' });
    expect(r.genre).toBe('trades');
    expect(r.fields.hook1).toBe('ELECTRICAL');
    expect(r.fields.cta).toBe('CALL US TODAY');
    const merged = mergeReadoutFields(
      { hook1: 'ONE NIGHT.', hook2: 'TWO SOUNDS.', sub: 'ONE NIGHT ONLY', cta: 'TICKETS: LINK IN BIO', font: undefined } as never,
      new Set<string>(),
      r,
    );
    const all = JSON.stringify(merged);
    expect(all).not.toContain('TWO SOUNDS');
    expect(all).not.toContain('TICKETS');
    expect(all).not.toContain('§');
  });


  it('the owner G.S.Y.M. fixture (real auto + sparse lines, R13): gospel, art-true, no business bleed', () => {
    const auto: OcrLine[] = [
    { text: "4 r ez\u201d? 7 4 1/ /", confidence: 38, y: 0.148, box: { x: 0.179, y: 0.148, w: 0.734, h: 0.188 } },
    { text: "; #2", confidence: 0, y: 0.373, box: { x: 0.379, y: 0.373, w: 0.368, h: 0.020 } },
    { text: "cet Ee Tal Ralls Bie", confidence: 18, y: 0.448, box: { x: 0.135, y: 0.448, w: 0.792, h: 0.102 } },
    { text: "5 SAVED MIND", confidence: 89, y: 0.545, box: { x: 0.027, y: 0.545, w: 0.880, h: 0.071 } },
    { text: "re 4 =", confidence: 42, y: 0.701, box: { x: 0.083, y: 0.701, w: 0.876, h: 0.043 } },
    { text: "Fo , YA, 5", confidence: 11, y: 0.669, box: { x: 0.052, y: 0.669, w: 0.835, h: 0.118 } },
    { text: "=== -/J RIDDIMROOM\" ===", confidence: 55, y: 0.848, box: { x: 0.251, y: 0.848, w: 0.499, h: 0.064 } }
    ];
    const sparse: OcrLine[] = [
    { text: "i", confidence: 0, y: 0.183, box: { x: 0.589, y: 0.183, w: 0.130, h: 0.108 } },
    { text: "J", confidence: 87, y: 0.182, box: { x: 0.775, y: 0.182, w: 0.023, h: 0.117 } },
    { text: "\u00ae", confidence: 34, y: 0.400, box: { x: 0.876, y: 0.400, w: 0.029, h: 0.046 } },
    { text: "=", confidence: 25, y: 0.468, box: { x: 0.272, y: 0.468, w: 0.062, h: 0.045 } },
    { text: "os ~", confidence: 0, y: 0.420, box: { x: 0.535, y: 0.420, w: 0.169, h: 0.092 } },
    { text: "SAVED", confidence: 96, y: 0.545, box: { x: 0.291, y: 0.545, w: 0.205, h: 0.059 } },
    { text: "MIND", confidence: 96, y: 0.546, box: { x: 0.753, y: 0.546, w: 0.154, h: 0.058 } },
    { text: "ae SN", confidence: 37, y: 0.722, box: { x: 0.930, y: 0.722, w: 0.029, h: 0.015 } },
    { text: "re", confidence: 6, y: 0.797, box: { x: 0.360, y: 0.797, w: 0.034, h: 0.010 } },
    { text: "Nor", confidence: 21, y: 0.645, box: { x: 0.599, y: 0.645, w: 0.214, h: 0.139 } },
    { text: "=", confidence: 39, y: 0.809, box: { x: 0.397, y: 0.809, w: 0.023, h: 0.004 } },
    { text: "ee", confidence: 0, y: 0.809, box: { x: 0.398, y: 0.809, w: 0.049, h: 0.007 } },
    { text: "= =", confidence: 52, y: 0.811, box: { x: 0.251, y: 0.811, w: 0.109, h: 0.085 } },
    { text: "IDDIMROOM =", confidence: 51, y: 0.797, box: { x: 0.449, y: 0.797, w: 0.301, h: 0.111 } }
    ];
    const r = classifyReadout(mergeLineSets(auto, sparse), { kind: 'logo', fileName: '1000090027_0_v8eg.png' });
    expect(r.genre).toBe('gospel');
    expect(r.fields.hook1).toBe('SAVED');
    expect(r.fields.hook2).toBe('MIND');
    expect(r.fields.sub).toBe('RIDDIMROOM');
    expect(r.fields.cta).toBe('ALL ARE WELCOME');
    const stops = chooseTourStops(r);
    expect(stops.length).toBeGreaterThanOrEqual(2);
  });

  it('stripJunkEdges removes OCR edge residue but keeps sentence punctuation', () => {
    expect(stripJunkEdges('5 SAVED MIND')).toBe('SAVED MIND');
    expect(stripJunkEdges('=== -/J RIDDIMROOM" ===')).toBe('RIDDIMROOM');
    expect(stripJunkEdges('ONE NIGHT. TWO SOUNDS.')).toBe('ONE NIGHT. TWO SOUNDS.');
    expect(stripJunkEdges('TICKETS OUT NOW')).toBe('TICKETS OUT NOW');
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
