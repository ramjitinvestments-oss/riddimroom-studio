import { describe, it, expect } from 'vitest';
import { detectBeats, findHookWindow } from './beats';

const SR = 8000; // the detector is rate-agnostic; 8k keeps tests fast

/** A click train: short decaying bursts at a fixed tempo over noise. */
function clickTrack(bpm: number, seconds: number, amp = 0.9): Float32Array {
  const out = new Float32Array(Math.floor(SR * seconds));
  for (let i = 0; i < out.length; i++) out[i] = (Math.sin(i * 0.7) * 0.5 + Math.sin(i * 0.13) * 0.5) * 0.04;
  const period = 60 / bpm;
  for (let t = 0.5; t < seconds; t += period) {
    const start = Math.floor(t * SR);
    for (let i = 0; i < 240 && start + i < out.length; i++) {
      out[start + i] += amp * Math.exp(-i / 60) * Math.sin(i * 0.9);
    }
  }
  return out;
}

describe('detectBeats', () => {
  it('finds a 100 BPM pulse and a beat grid on the clicks', () => {
    const { bpm, beats } = detectBeats(clickTrack(100, 12), SR);
    expect(Math.abs(bpm - 100)).toBeLessThanOrEqual(4);
    expect(beats.length).toBeGreaterThanOrEqual(16);
    // Consecutive beats are one period apart.
    const gaps = beats.slice(1).map((b, i) => b - beats[i]);
    for (const g of gaps) expect(Math.abs(g - 0.6)).toBeLessThan(0.05);
  });

  it('finds a 150 BPM dancehall pulse', () => {
    const { bpm } = detectBeats(clickTrack(150, 10), SR);
    expect(Math.abs(bpm - 150)).toBeLessThanOrEqual(6);
  });

  it('silence and near-silence yield no grid, never a crash', () => {
    expect(detectBeats(new Float32Array(SR * 6), SR).beats).toHaveLength(0);
    expect(detectBeats(new Float32Array(10), SR).bpm).toBe(0);
  });
});

describe('findHookWindow', () => {
  it('a short track has no hook to find', () => {
    expect(findHookWindow(clickTrack(100, 8), SR, 12)).toBe(0);
  });

  it('the loud half is the hook', () => {
    const quiet = clickTrack(100, 10, 0.12);
    const loud = clickTrack(100, 10, 0.95);
    const both = new Float32Array(quiet.length + loud.length);
    both.set(quiet, 0);
    both.set(loud, quiet.length);
    const start = findHookWindow(both, SR, 6);
    expect(start).toBeGreaterThanOrEqual(9);
    expect(start).toBeLessThanOrEqual(14.5);
  });
});
