import { describe, it, expect } from 'vitest';
import {
  LIGHT_GRID_COLS,
  LIGHT_GRID_ROWS,
  analyzeLightSample,
  lightAdvice,
  lightStateLabel,
} from './lightMeter';

/** A uniform RGBA buffer of one grey value. */
function grayFrame(width: number, height: number, value: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }
  return data;
}

function setPixel(data: Uint8ClampedArray, width: number, x: number, y: number, value: number) {
  const o = (y * width + x) * 4;
  data[o] = value;
  data[o + 1] = value;
  data[o + 2] = value;
  data[o + 3] = 255;
}

describe('analyzeLightSample', () => {
  it('reads a near-black frame as too-dark with no clipping and no zebra', () => {
    const r = analyzeLightSample({ data: grayFrame(48, 48, 10), width: 48, height: 48 });
    expect(r.state).toBe('too-dark');
    expect(r.meanLuma).toBeCloseTo(10 / 255, 5);
    expect(r.clippedFraction).toBe(0);
    expect(r.zebraCells).toHaveLength(LIGHT_GRID_COLS * LIGHT_GRID_ROWS);
    expect(r.zebraCells.every((c) => c === false)).toBe(true);
  });

  it('reads a mid-grey frame as good', () => {
    const r = analyzeLightSample({ data: grayFrame(48, 48, 128), width: 48, height: 48 });
    expect(r.state).toBe('good');
    expect(r.meanLuma).toBeCloseTo(128 / 255, 5);
  });

  it('reads a bright-but-not-clipping frame as bright', () => {
    const r = analyzeLightSample({ data: grayFrame(48, 48, 200), width: 48, height: 48 });
    expect(r.state).toBe('bright');
    expect(r.clippedFraction).toBe(0);
  });

  it('reads a fully white frame as blowing out, every zebra cell flagged', () => {
    const r = analyzeLightSample({ data: grayFrame(48, 48, 255), width: 48, height: 48 });
    expect(r.state).toBe('blowing-out');
    expect(r.clippedFraction).toBe(1);
    expect(r.zebraCells.every((c) => c === true)).toBe(true);
  });

  it('flags only the zebra cell whose own clipping passes the threshold', () => {
    // 96x96 sample -> each grid cell covers 4x4 pixels. Blow out the
    // top-left cell only: 16 of 9216 pixels = ~0.17% of the frame,
    // far under the 2% blowing-out threshold, so the state stays
    // good while that one cell earns stripes.
    const data = grayFrame(96, 96, 128);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) setPixel(data, 96, x, y, 255);
    const r = analyzeLightSample({ data, width: 96, height: 96 });
    expect(r.state).toBe('good');
    expect(r.clippedFraction).toBeCloseTo(16 / 9216, 6);
    expect(r.zebraCells[0]).toBe(true);
    expect(r.zebraCells.filter(Boolean)).toHaveLength(1);
  });

  it('does not flag a cell for a single hot pixel', () => {
    const data = grayFrame(96, 96, 128);
    setPixel(data, 96, 0, 0, 255);
    const r = analyzeLightSample({ data, width: 96, height: 96 });
    expect(r.zebraCells.every((c) => c === false)).toBe(true);
  });

  it('crosses into blowing-out once 2% of the frame clips', () => {
    // 48x48 = 2304 px; 2% = ~46 px. Blow a 7x7 block (49 px) white.
    const data = grayFrame(48, 48, 128);
    for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) setPixel(data, 48, x, y, 255);
    const r = analyzeLightSample({ data, width: 48, height: 48 });
    expect(r.clippedFraction).toBeGreaterThanOrEqual(0.02);
    expect(r.state).toBe('blowing-out');
  });

  it('weights colour channels by luma — pure green reads brighter than pure blue', () => {
    const green = new Uint8ClampedArray([0, 255, 0, 255]);
    const blue = new Uint8ClampedArray([0, 0, 255, 255]);
    const g = analyzeLightSample({ data: green, width: 1, height: 1 });
    const b = analyzeLightSample({ data: blue, width: 1, height: 1 });
    expect(g.meanLuma).toBeCloseTo(0.7152, 4);
    expect(b.meanLuma).toBeCloseTo(0.0722, 4);
  });

  it('supports pre-computed grayscale samples', () => {
    const data = new Uint8ClampedArray(100).fill(30);
    const r = analyzeLightSample({ data, width: 10, height: 10, format: 'gray' });
    expect(r.state).toBe('too-dark');
    expect(r.meanLuma).toBeCloseTo(30 / 255, 5);
  });

  it('returns the no-signal result for invalid input instead of inventing a warning', () => {
    const empty = analyzeLightSample({ data: new Uint8ClampedArray(0), width: 0, height: 0 });
    expect(empty.state).toBe('good');
    expect(empty.meanLuma).toBe(0);
    expect(empty.zebraCells).toHaveLength(LIGHT_GRID_COLS * LIGHT_GRID_ROWS);
    const short = analyzeLightSample({ data: new Uint8ClampedArray(3), width: 48, height: 48 });
    expect(short.state).toBe('good');
  });
});

describe('lightStateLabel / lightAdvice', () => {
  it('labels each state in plain words', () => {
    expect(lightStateLabel('too-dark')).toBe('Too dark');
    expect(lightStateLabel('good')).toBe('Good light');
    expect(lightStateLabel('bright')).toBe('Very bright');
    expect(lightStateLabel('blowing-out')).toBe('Highlights blowing out');
  });

  it('too dark + a demanding capture names the cleaner 1080p trade verbatim', () => {
    const r = analyzeLightSample({ data: grayFrame(24, 24, 30), width: 24, height: 24 });
    expect(lightAdvice(r, { demandingCapture: true, torchAvailable: false })).toBe(
      'Too dark — 1080p will look cleaner than 4K here',
    );
    expect(lightAdvice(r, { demandingCapture: false, torchAvailable: false })).toBe(
      'Too dark — add light if you can, or face a window',
    );
  });

  it('very dark + an available rear light appends the flashlight prompt', () => {
    const r = analyzeLightSample({ data: grayFrame(24, 24, 10), width: 24, height: 24 });
    expect(r.meanLuma).toBeLessThan(0.1);
    expect(lightAdvice(r, { demandingCapture: true, torchAvailable: true })).toBe(
      'Too dark — 1080p will look cleaner than 4K here. Or try the flashlight.',
    );
    // Merely dark (not VERY dark) never gets the prompt.
    const dim = analyzeLightSample({ data: grayFrame(24, 24, 40), width: 24, height: 24 });
    expect(lightAdvice(dim, { demandingCapture: true, torchAvailable: true })).toBe(
      'Too dark — 1080p will look cleaner than 4K here',
    );
  });

  it('good light needs no advice; bright and blowing-out get their lines', () => {
    const good = analyzeLightSample({ data: grayFrame(24, 24, 128), width: 24, height: 24 });
    expect(lightAdvice(good, { demandingCapture: true, torchAvailable: true })).toBeNull();
    const bright = analyzeLightSample({ data: grayFrame(24, 24, 200), width: 24, height: 24 });
    expect(lightAdvice(bright, { demandingCapture: false, torchAvailable: false })).toBe(
      'Plenty of light here — you are good to record.',
    );
    const blown = analyzeLightSample({ data: grayFrame(24, 24, 255), width: 24, height: 24 });
    expect(lightAdvice(blown, { demandingCapture: false, torchAvailable: false })).toMatch(/washing out/);
  });
});
