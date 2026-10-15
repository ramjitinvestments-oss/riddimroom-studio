/**
 * RiddimRoom Studio — built-in music loops (Phase 2.3).
 *
 * Three short Caribbean-flavored loops synthesized entirely client-side
 * with `OfflineAudioContext` (kick/snare/hats from oscillators + filtered
 * noise, bass and pluck leads from oscillators) — no audio files ship
 * with the app and nothing is fetched. A loop renders to a real WAV
 * `File`, which the Music panel then pushes through the EXACT same path a
 * user upload takes (`uploadMediaFile` → Firebase Storage → MediaAsset →
 * `appendMediaToTimeline`), so a generated loop is indistinguishable from
 * an uploaded track downstream: same asset pool, same audio item, same
 * preview/export mixing.
 *
 * Patterns are event lists over a fixed 64-step grid spanning the loop's
 * 8 seconds (step = 0.125s). Because the rendered audio is exactly 8s and
 * every pattern is periodic within that window, placing the item back to
 * back with itself (or looping the element) repeats seamlessly.
 */

export const LOOP_DURATION_SECONDS = 8;
export const LOOP_STEPS = 64;
export const LOOP_SAMPLE_RATE = 44100;

export interface LoopDef {
  id: string;
  label: string;
  description: string;
  /** Step indices (0..63) that trigger the instrument. */
  kick: number[];
  snare: number[];
  hat: number[];
  /** [step, midiNote] events. */
  bass: [number, number][];
  lead: [number, number][];
  /** Seconds the bass note rings (short/stabby vs long/round per loop). */
  bassDecaySeconds: number;
}

const every = (step: number, offset = 0): number[] => {
  const out: number[] = [];
  for (let s = offset; s < LOOP_STEPS; s += step) out.push(s);
  return out;
};

/** Repeats a per-bar (16-step) event list across all 4 bars. */
const perBar = (events: [number, number][]): [number, number][] => {
  const out: [number, number][] = [];
  for (let bar = 0; bar < 4; bar++) {
    for (const [step, note] of events) out.push([step + bar * 16, note]);
  }
  return out;
};

const perBarSteps = (steps: number[]): number[] => {
  const out: number[] = [];
  for (let bar = 0; bar < 4; bar++) for (const s of steps) out.push(s + bar * 16);
  return out;
};

export const LOOP_DEFS: LoopDef[] = [
  {
    id: 'soca-groove',
    label: 'Soca Groove',
    description: 'Four-on-the-floor drive, backbeat snare, rolling hats — A minor party energy.',
    kick: every(4),
    snare: perBarSteps([4, 12]),
    hat: every(2),
    bass: perBar([
      [0, 33], [3, 33], [6, 36], [8, 33], [11, 40], [12, 33], [14, 38],
    ]),
    lead: perBar([
      [0, 69], [4, 72], [8, 76], [12, 72],
    ]),
    bassDecaySeconds: 0.22,
  },
  {
    id: 'dancehall-riddim',
    label: 'Dancehall Riddim',
    description: 'Syncopated 3+3+2 kick, sparse hats, deep dotted bass — G minor.',
    kick: perBarSteps([0, 7, 10]),
    snare: perBarSteps([4, 12]),
    hat: every(4, 2),
    bass: perBar([
      [0, 31], [3, 31], [6, 34], [10, 31], [12, 36],
    ]),
    lead: perBar([
      [2, 65], [6, 65], [14, 68],
    ]),
    bassDecaySeconds: 0.3,
  },
  {
    id: 'chill-island',
    label: 'Chill Island',
    description: 'Half-time pulse, soft backbeat, long round bass and a lazy pentatonic pluck.',
    kick: [0, 24, 32, 56],
    snare: [16, 48],
    hat: every(8, 4),
    bass: [
      [0, 45], [16, 43], [32, 41], [48, 43],
    ],
    lead: [
      [0, 69], [8, 72], [16, 76], [24, 74], [32, 72], [40, 69], [48, 67], [56, 69],
    ],
    bassDecaySeconds: 1.4,
  },
];

export function getLoopDef(id: string): LoopDef | undefined {
  return LOOP_DEFS.find((def) => def.id === id);
}

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ---------------------------------------------------------------------------
// WAV encoding — 16-bit PCM, the universally decodable container every
// browser's <audio>/WebAudio stack accepts. Accepts a structural subset of
// AudioBuffer so it can be unit-tested without a real audio context.
// ---------------------------------------------------------------------------

export interface WavSourceBuffer {
  numberOfChannels: number;
  sampleRate: number;
  length: number;
  getChannelData: (channel: number) => Float32Array;
}

export function encodeWav(buffer: WavSourceBuffer): Blob {
  const channels = Math.max(1, Math.min(2, buffer.numberOfChannels));
  const sampleRate = buffer.sampleRate;
  const frames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  const channelData: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) channelData.push(buffer.getChannelData(ch));
  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let ch = 0; ch < channels; ch++) {
      const sample = Math.max(-1, Math.min(1, channelData[ch][frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([out], { type: 'audio/wav' });
}

// ---------------------------------------------------------------------------
// Synthesis — one tiny voice per instrument. Patterns and envelopes are
// fixed data/ramps; only the raw noise buffer behind snare/hats is
// random (inaudible — noise is noise), so a def always renders the same
// groove, just not a byte-identical WAV.
// ---------------------------------------------------------------------------

function scheduleKick(ctx: OfflineAudioContext, dest: AudioNode, time: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, time);
  osc.frequency.exponentialRampToValueAtTime(40, time + 0.12);
  gain.gain.setValueAtTime(0.95, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.26);
  osc.connect(gain).connect(dest);
  osc.start(time);
  osc.stop(time + 0.3);
}

function makeNoiseBuffer(ctx: OfflineAudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function scheduleSnare(ctx: OfflineAudioContext, dest: AudioNode, noise: AudioBuffer, time: number) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1800;
  filter.Q.value = 0.8;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.6, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.18);
  src.connect(filter).connect(gain).connect(dest);
  src.start(time);
  src.stop(time + 0.2);
}

function scheduleHat(ctx: OfflineAudioContext, dest: AudioNode, noise: AudioBuffer, time: number, accent: boolean) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 7000;
  const gain = ctx.createGain();
  const peak = accent ? 0.32 : 0.2;
  gain.gain.setValueAtTime(peak, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + (accent ? 0.09 : 0.05));
  src.connect(filter).connect(gain).connect(dest);
  src.start(time);
  src.stop(time + 0.1);
}

function scheduleBass(ctx: OfflineAudioContext, dest: AudioNode, time: number, midi: number, decaySeconds: number) {
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = midiToFreq(midi);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 320;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.5, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + decaySeconds);
  osc.connect(filter).connect(gain).connect(dest);
  osc.start(time);
  osc.stop(time + decaySeconds + 0.05);
}

function scheduleLead(ctx: OfflineAudioContext, dest: AudioNode, time: number, midi: number) {
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = midiToFreq(midi);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.22, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.32);
  osc.connect(gain).connect(dest);
  osc.start(time);
  osc.stop(time + 0.35);
}

/** Renders a loop def to a WAV `File`, ready for `uploadMediaFile`. Browser-only (OfflineAudioContext). */
export async function renderLoopFile(def: LoopDef): Promise<File> {
  const ctx = new OfflineAudioContext(2, LOOP_SAMPLE_RATE * LOOP_DURATION_SECONDS, LOOP_SAMPLE_RATE);
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);
  const noise = makeNoiseBuffer(ctx);
  const stepSeconds = LOOP_DURATION_SECONDS / LOOP_STEPS;
  const at = (step: number) => step * stepSeconds + 0.01;

  for (const step of def.kick) scheduleKick(ctx, master, at(step));
  for (const step of def.snare) scheduleSnare(ctx, master, noise, at(step));
  for (const step of def.hat) scheduleHat(ctx, master, noise, at(step), step % 8 === 0);
  for (const [step, midi] of def.bass) scheduleBass(ctx, master, at(step), midi, def.bassDecaySeconds);
  for (const [step, midi] of def.lead) scheduleLead(ctx, master, at(step), midi);

  const rendered = await ctx.startRendering();
  const blob = encodeWav(rendered);
  return new File([blob], `${def.id}.wav`, { type: 'audio/wav' });
}
