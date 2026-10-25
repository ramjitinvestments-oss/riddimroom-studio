/**
 * Beat detection + hook finding for the Viral Finish (R17) — pure
 * functions over decoded audio samples, so they are fully testable
 * and run identically on any track the promo uses (the user's own
 * upload, a pack recording, a synth loop).
 *
 * detectBeats: frame-energy onset envelope → autocorrelation tempo
 * pick (50–200 BPM, slower octave preferred on ties) → phase-aligned
 * beat grid. Good enough to land caption word-pops and cuts on the
 * music's pulse; it is an estimator, not a transcription.
 *
 * findHookWindow: the most energetic window of a given length — the
 * chorus heuristic. A promo built from a full song should start at
 * its loudest, densest moment, not its intro.
 */

export interface BeatGrid {
  bpm: number;
  /** Beat times in seconds from the track's start. */
  beats: number[];
}

const FRAME_SECONDS = 0.01;

function frameEnergies(samples: Float32Array, sampleRate: number): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const frames = Math.floor(samples.length / hop);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = 0; i < hop; i++) {
      const v = samples[start + i];
      sum += v * v;
    }
    out[f] = Math.sqrt(sum / hop);
  }
  return out;
}

function onsetEnvelope(energies: Float32Array): Float32Array {
  const out = new Float32Array(energies.length);
  for (let i = 1; i < energies.length; i++) {
    out[i] = Math.max(0, energies[i] - energies[i - 1]);
  }
  // Light smoothing so a single click reads as one onset, not two.
  for (let i = 2; i < out.length; i++) {
    out[i] = out[i] * 0.6 + out[i - 1] * 0.25 + out[i - 2] * 0.15;
  }
  return out;
}

export function detectBeats(samples: Float32Array, sampleRate: number): BeatGrid {
  const duration = samples.length / sampleRate;
  if (duration < 2 || sampleRate <= 0) return { bpm: 0, beats: [] };
  const onset = onsetEnvelope(frameEnergies(samples, sampleRate));
  const framesPerSecond = 1 / FRAME_SECONDS;

  // Autocorrelation over the musical tempo range.
  const minLag = Math.floor(framesPerSecond * (60 / 200));
  const maxLag = Math.ceil(framesPerSecond * (60 / 50));
  let bestLag = 0;
  let bestScore = -Infinity;
  const scores: Array<{ lag: number; score: number }> = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = lag; i < onset.length; i++) sum += onset[i] * onset[i - lag];
    scores.push({ lag, score: sum });
    if (sum > bestScore) {
      bestScore = sum;
      bestLag = lag;
    }
  }
  if (!bestLag || bestScore <= 0) return { bpm: 0, beats: [] };
  // Octave sanity: a periodic pulse correlates almost as strongly at
  // twice its period (every other beat still aligns), so the true
  // period is the SHORTEST lag that scores within 90% of the best.
  const fundamental = scores.find((s) => s.score >= bestScore * 0.9);
  if (fundamental) bestLag = fundamental.lag;

  const period = bestLag / framesPerSecond;
  const bpm = 60 / period;

  // Phase: the offset whose beat positions collect the most onset.
  const steps = 24;
  let bestPhase = 0;
  let bestPhaseScore = -Infinity;
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * period;
    let sum = 0;
    for (let t = phase; t < duration; t += period) {
      const idx = Math.round(t * framesPerSecond);
      if (idx >= 0 && idx < onset.length) sum += onset[idx];
    }
    if (sum > bestPhaseScore) {
      bestPhaseScore = sum;
      bestPhase = phase;
    }
  }

  const beats: number[] = [];
  for (let t = bestPhase; t < duration; t += period) beats.push(+t.toFixed(3));
  return { bpm: Math.round(bpm), beats };
}

/**
 * The start (seconds) of the most energetic `windowSeconds` stretch
 * of the track. Returns 0 when the track is not longer than the
 * window (nothing to find — the whole track is the hook).
 */
export function findHookWindow(samples: Float32Array, sampleRate: number, windowSeconds: number): number {
  const duration = samples.length / sampleRate;
  if (duration <= windowSeconds + 0.5 || sampleRate <= 0) return 0;
  const energies = frameEnergies(samples, sampleRate);
  const winFrames = Math.round(windowSeconds / FRAME_SECONDS);
  if (winFrames <= 0 || winFrames >= energies.length) return 0;
  let sum = 0;
  for (let i = 0; i < winFrames; i++) sum += energies[i];
  let best = sum;
  let bestStart = 0;
  for (let i = 1; i + winFrames <= energies.length; i++) {
    sum += energies[i + winFrames - 1] - energies[i - 1];
    if (sum > best) {
      best = sum;
      bestStart = i;
    }
  }
  return +(bestStart * FRAME_SECONDS).toFixed(2);
}
