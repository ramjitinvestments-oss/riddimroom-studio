import { describe, it, expect } from 'vitest';
import { LOOP_DEFS, LOOP_STEPS, encodeWav, type WavSourceBuffer } from './loops';

/**
 * Phase 2.3 — the loop defs are data the synthesizer schedules blindly, so
 * pin their shape (in-range steps/notes, unique ids) and the WAV encoder's
 * framing (a malformed header would make the "generated loop" an
 * undecodable asset in the pool).
 */
describe('built-in loop defs', () => {
  it('has three loops with unique ids', () => {
    expect(LOOP_DEFS).toHaveLength(5);
    expect(new Set(LOOP_DEFS.map((d) => d.id)).size).toBe(5);
  });

  it('every event sits inside the 64-step grid with sane midi notes', () => {
    for (const def of LOOP_DEFS) {
      for (const step of [...def.kick, ...def.snare, ...def.hat]) {
        expect(step).toBeGreaterThanOrEqual(0);
        expect(step).toBeLessThan(LOOP_STEPS);
      }
      for (const [step, midi] of [...def.bass, ...def.lead]) {
        expect(step).toBeGreaterThanOrEqual(0);
        expect(step).toBeLessThan(LOOP_STEPS);
        expect(midi).toBeGreaterThanOrEqual(24);
        expect(midi).toBeLessThanOrEqual(96);
      }
      expect(def.kick.length).toBeGreaterThan(0);
      expect(def.bass.length).toBeGreaterThan(0);
    }
  });
});

describe('encodeWav', () => {
  function stubBuffer(frames: number, channels: number): WavSourceBuffer {
    return {
      numberOfChannels: channels,
      sampleRate: 44100,
      length: frames,
      getChannelData: (ch: number) => {
        const data = new Float32Array(frames);
        for (let i = 0; i < frames; i++) data[i] = ch === 0 ? 0.5 : -0.5;
        return data;
      },
    };
  }

  it('produces a RIFF/WAVE blob sized 44-byte header + 16-bit samples', async () => {
    const blob = encodeWav(stubBuffer(100, 2));
    expect(blob.size).toBe(44 + 100 * 2 * 2);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE');
    // First frame: +0.5 → 0x3FFF little-endian, then -0.5 → 0xC001.
    expect(bytes[44]).toBe(0xff);
    expect(bytes[45]).toBe(0x3f);
  });
});
