/**
 * R22 — one easing library for every camera and motion move.
 *
 * Before R22 the renderer mixed smoothstep (word-tour), linear
 * ramps (ken-burns, slow zooms) and easeOutCubic (entrances), which
 * is why moves felt mechanical next to the top-tier tools: premium
 * motion is mostly *velocity shaping*. Everything cinematic now
 * draws from these curves:
 *
 * - `smootherstep` — quintic 6t⁵−15t⁴+10t³; zero velocity AND zero
 *   acceleration at both ends, so chained segments (tour stops)
 *   join without a kink.
 * - `cineInOut` / `cineOut` — cubic-bezier film curves.
 * - `bump` — an out-and-back envelope (0 → 1 → 0) for homecoming
 *   moves: the camera leaves home and returns home.
 */

export function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

export function smootherstep(t: number): number {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** Cubic-bezier easing, solved by bisection on the x curve. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const sample = (a1: number, a2: number, u: number): number => {
    const v = 1 - u;
    return 3 * v * v * u * a1 + 3 * v * u * u * a2 + u * u * u;
  };
  return (t: number): number => {
    const x = clamp01(t);
    if (x === 0 || x === 1) return x;
    let lo = 0;
    let hi = 1;
    let u = x;
    for (let i = 0; i < 24; i++) {
      u = (lo + hi) / 2;
      const xu = sample(x1, x2, u);
      if (Math.abs(xu - x) < 0.0005) break;
      if (xu < x) lo = u;
      else hi = u;
    }
    return sample(y1, y2, u);
  };
}

/** The film-standard ease-in-out: gentle start, confident middle, soft landing. */
export const cineInOut = cubicBezier(0.42, 0, 0.58, 1);
/** Decelerating arrival — moves that settle onto a subject. */
export const cineOut = cubicBezier(0.16, 1, 0.3, 1);
/** Quick attack, long settle — punches and slams. */
export const snapOut = cubicBezier(0.22, 1.36, 0.36, 1);

/**
 * Out-and-back envelope: 0 at both ends, 1 at the middle, smooth
 * throughout (smootherstep up, mirrored down). Multiply any "away
 * from home" amount by this to guarantee the move comes home.
 */
export function bump(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? smootherstep(x * 2) : smootherstep((1 - x) * 2);
}

/**
 * The homecoming blend for a move's final stretch: 0 until
 * `returnStart`, then smootherstep to 1 at the end — the factor by
 * which an adjustment is blended back to identity (home framing).
 */
export function returnBlend(t: number, returnStart = 0.8): number {
  if (t <= returnStart) return 0;
  return smootherstep((t - returnStart) / (1 - returnStart));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
