/**
 * R40 P-18 — reduced motion, the JS half.
 *
 * The CSS half lives in src/index.css (a `prefers-reduced-motion`
 * block that calms app-driven transitions and the pulsing REC dot).
 * JS-driven looping animation can't be reached from CSS, so surfaces
 * that animate on a timer consult this helper instead: when the user
 * asks their phone for reduced motion, those loops simply don't run.
 */

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Minimal shape of the media query list this helper reads — injectable for tests. */
export interface MotionMediaQuery {
  matches: boolean;
}

/**
 * True when the environment reports the user's reduced-motion
 * preference. Any environment without matchMedia (older webviews,
 * server-side rendering, tests) reads as "no preference" — motion
 * stays as it was unless the preference is positively reported.
 */
export function prefersReducedMotion(mql?: MotionMediaQuery | null): boolean {
  if (mql) return mql.matches === true;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches === true;
  } catch {
    return false;
  }
}

/**
 * Whether a looping preview (the reel cards' auto-crossfade) may cycle
 * at all: it needs more than one frame AND no reduced-motion
 * preference. Under reduced motion the preview shows a single still
 * frame — the first one — and never cycles.
 */
export function reelCrossfadeAllowed(frameCount: number, reducedMotion: boolean): boolean {
  return frameCount > 1 && !reducedMotion;
}
