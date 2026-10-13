/**
 * RiddimRoom Studio — frame compositor.
 *
 * Draws one frame of a `Project` at a given timeline position onto a 2D
 * canvas context. Shared, on purpose, by both the live editor preview
 * (`PreviewPane`) and the export renderer (`Canvas2DRenderer`) — a
 * WYSIWYG guarantee only holds if preview and export literally run the
 * same drawing code, not two hand-kept-in-sync implementations.
 *
 * Sizing convention (documented since the data model stores percentages/
 * scale multipliers, not pixels, per `Transform`'s own comments):
 * - `video` items fill the canvas at `scale: 1` (position is the fill's
 *   center, almost always {50, 50}); `scale` multiplies that fill size.
 * - `image` items (including watermarks/logos) draw at 25% of canvas width
 *   at `scale: 1`, aspect-ratio preserved from the source image's natural
 *   dimensions — a sane default for a watermark/logo/sticker, adjustable
 *   per item via `scale`.
 * - `text`/`caption` items size directly from `fontSize` (pixels), not
 *   `scale`.
 *
 * Transitions/animation (added in the "live editor repair" pass): every
 * visual item type already carried `fade`/`animation` fields in the data
 * model (`types/timeline.ts`) but the compositor never read them — a
 * transition button that changes project state without affecting a single
 * rendered pixel is exactly the "fake" UI this pass was asked to eliminate.
 * `computeEntranceExit` below is now the one place that turns an
 * `AnimationPreset` + how far into/from the item's own start/end the
 * current frame is into a real opacity/position/scale/blur adjustment,
 * shared by video/image/text so "premium transitions" means real
 * per-frame compositor math, not a CSS class. `FadeSettings` (a separate,
 * simpler linear opacity ramp, independent of the `animation` preset) is
 * also wired in — two adjacent items on the same track with complementary
 * fade-out/fade-in and an overlapping time range genuinely cross-dissolve,
 * because both are drawn (back-to-front by zIndex) during the overlap with
 * opposing opacity ramps.
 */

import type { AnimationPreset, CaptionTimelineItem, ImageTimelineItem, MotionSettings, Project, TextTimelineItem, Transform } from '../../types/timeline';
import { getItemsAtTime } from '../timeline/utils';
import { getCaptionStyle } from '../captions/styles';
import { findTransitionPreset, TRANSITION_INTENSITY_MAX, TRANSITION_INTENSITY_MIN } from '../transitions';
import { MOTION_INTENSITY_MAX, MOTION_INTENSITY_MIN } from '../motionEffects';
import { MAX_FADE_SECONDS } from '../media/constants';

export interface FrameAssets {
  /** Loaded <img> elements keyed by MediaAsset id, for `image` timeline items. */
  images: Map<string, HTMLImageElement>;
  /** The currently-playing <video> element and which mediaAssetId it corresponds to, if any video item is active. */
  activeVideo?: { assetId: string; element: HTMLVideoElement } | null;
  /** v1 PiP: all decoded <video> elements keyed by MediaAsset id. When present, drawFrame prefers this map so main + PiP videos can draw in the same frame. */
  videos?: Map<string, HTMLVideoElement>;
}

// ---------------------------------------------------------------------------
// Entrance/exit animation + fade — the "premium transitions" engine
// ---------------------------------------------------------------------------

/** Fallback entrance/exit duration for a preset with no catalog entry (see lib/transitions.ts), capped to half the item's own on-screen duration so a very short clip doesn't animate through its entire lifespan. */
const FALLBACK_ANIMATION_DURATION_SECONDS = 0.45;

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Overshoot easing — settles past 1 then back to 1, the "punch/pop" feel. */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const x = clamp01(t);
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

/** Damped oscillation, e.g. `dampedSine(t, 3)` rings 3 times while decaying to 0 — used for bounce/elastic/heartbeat's "settles after overshooting" feel. Deterministic (pure function of t), never Math.random(), so preview and export always agree frame-for-frame. */
function dampedSine(t: number, cycles: number): number {
  const x = clamp01(t);
  return Math.sin(x * Math.PI * cycles) * (1 - x);
}

export interface AnimatedAdjustment {
  opacityMul: number;
  offsetXPx: number;
  offsetYPx: number;
  scaleMul: number;
  blurPx: number;
  /**
   * "Final production fix" spec item 7 additions — a handful of presets
   * (dip-to-black/white, light-leak, flash, spin, flip, skew, glitch,
   * rainbow) need more than uniform opacity/offset/scale/blur to look
   * distinct rather than like a re-skinned fade. Every field here defaults
   * to a no-op value and is additive/multiplicative on top of the item's
   * own static Transform, exactly like the fields above.
   */
  /** 0-1 straight overlay-color wash drawn over the item's own bounds (dip-to-black/white, light-leak, flash). */
  overlayAlpha: number;
  overlayColor: string;
  /** Radians — canvas horizontal shear, applied before scale (skew). */
  skewX: number;
  /** Independent per-axis scale multipliers, layered on top of `scaleMul` (flip's "thin sliver" horizontal collapse, slideSplit's squeeze). */
  scaleXMul: number;
  scaleYMul: number;
  /** Degrees, added to the item's own static rotation (spin). */
  rotationDeltaDeg: number;
  /** CSS `hue-rotate()` degrees, combined into the same canvas filter as blur (rainbow). */
  hueRotateDeg: number;
  /**
   * "Final production fix" spec item 8 (motion/zoom effects) additions —
   * `spotlight`/`vignette` need a radial darken-the-edges treatment (not a
   * flat single-alpha wash like `overlayAlpha`), and `light-sweep` needs a
   * moving linear-gradient highlight band. Both are drawn by
   * `drawMotionOverlay`, separately from `drawAdjustmentOverlay`'s flat
   * rect, since neither is expressible as a uniform color+alpha.
   */
  /** 0-1, radial darken-toward-edges strength (vignette/spotlight/product-focus). */
  vignetteAlpha: number;
  /** 0-1, extra brightness at the vignette's center, on top of `vignetteAlpha`'s darkened edges (spotlight only). */
  spotlightBoost: number;
  /** Offsets the vignette/spotlight gradient's center away from the item's own center (spotlight's slow drift). */
  vignetteCenterOffsetXPx: number;
  vignetteCenterOffsetYPx: number;
  /** 0-1 peak brightness of the light-sweep band; 0 = no sweep drawn. */
  sweepAlpha: number;
  /** 0-1, where along the item's own width the sweep band currently sits. */
  sweepPositionPercent: number;
}

const IDENTITY_ADJUSTMENT: AnimatedAdjustment = {
  opacityMul: 1,
  offsetXPx: 0,
  offsetYPx: 0,
  scaleMul: 1,
  blurPx: 0,
  overlayAlpha: 0,
  overlayColor: '#000000',
  skewX: 0,
  scaleXMul: 1,
  scaleYMul: 1,
  rotationDeltaDeg: 0,
  hueRotateDeg: 0,
  vignetteAlpha: 0,
  spotlightBoost: 0,
  vignetteCenterOffsetXPx: 0,
  vignetteCenterOffsetYPx: 0,
  sweepAlpha: 0,
  sweepPositionPercent: 0.5,
};

/**
 * Computes the entrance/exit adjustment for a frame `sinceStart` seconds
 * after the item started and `untilEnd` seconds before it ends. Every
 * implemented preset does real, distinct motion (opacity/position/scale/
 * blur) rather than being a no-op; a preset the type system allows but this
 * pass didn't hand-implement (e.g. 'shake', 'glitch') still gets a plain
 * fade rather than silently doing nothing, so no animation choice in the UI
 * ever looks "broken" — see the header comment for which presets have
 * bespoke motion.
 */
export function computeEntranceExit(
  preset: AnimationPreset | undefined,
  sinceStart: number,
  untilEnd: number,
  itemDurationSeconds: number,
  canvasWidth: number,
  canvasHeight: number,
  /** "Final production fix" spec item 7 — multiplies every preset's displacement/scale-delta/blur amount; 1 = the preset's normal look. Clamped to the catalog's supported range so a corrupt/out-of-range saved value can't produce an unusable (e.g. inverted or absurdly huge) transition. */
  intensity: number = 1,
): AnimatedAdjustment {
  // Callers (`animationFor`) mutate the returned object in place
  // (`a.opacityMul *= computeFadeOpacity(...)`), so every early return here
  // MUST hand back a fresh copy, never the shared `IDENTITY_ADJUSTMENT`
  // singleton by reference — returning the singleton directly let a single
  // faded/animating item permanently corrupt it (e.g. one video item's
  // fade-in multiplying it down to 0), after which every other item that
  // hit this fast path for the rest of the session inherited that same
  // corrupted opacity and silently rendered invisible. Found via headless
  // pixel-sampling verification (Priority 6/7 real-content checks) — a
  // video item and a kinetic text item both progressively faded to fully
  // transparent a few seconds into playback with no console error.
  if (!preset || preset === 'none') return { ...IDENTITY_ADJUSTMENT };
  const k = Math.max(TRANSITION_INTENSITY_MIN, Math.min(TRANSITION_INTENSITY_MAX, intensity || 1));
  const catalogDuration = findTransitionPreset(preset)?.defaultDurationSeconds ?? FALLBACK_ANIMATION_DURATION_SECONDS;
  const dur = Math.min(catalogDuration, Math.max(0.05, itemDurationSeconds / 2));
  const inEnter = sinceStart < dur;
  const inExit = untilEnd < dur;
  if (!inEnter && !inExit) return { ...IDENTITY_ADJUSTMENT };

  const enterP = easeOutCubic(clamp01(sinceStart / dur));
  const exitP = easeOutCubic(clamp01(untilEnd / dur));
  const enterLinear = clamp01(sinceStart / dur);
  const exitLinear = clamp01(untilEnd / dur);
  const a: AnimatedAdjustment = { ...IDENTITY_ADJUSTMENT };

  const applyEnterExitOpacity = () => {
    if (inEnter) a.opacityMul = Math.min(a.opacityMul, enterP);
    if (inExit) a.opacityMul = Math.min(a.opacityMul, exitP);
  };

  switch (preset) {
    // --- Clean / Professional ---------------------------------------
    case 'fade':
      applyEnterExitOpacity();
      if (inEnter) a.blurPx = Math.max(a.blurPx, (1 - enterP) * 8 * k);
      if (inExit) a.blurPx = Math.max(a.blurPx, (1 - exitP) * 8 * k);
      break;
    case 'slide-up':
      applyEnterExitOpacity();
      if (inEnter) a.offsetYPx += (1 - enterP) * canvasHeight * 0.18 * k;
      if (inExit) a.offsetYPx -= (1 - exitP) * canvasHeight * 0.18 * k;
      break;
    case 'slide-down':
      applyEnterExitOpacity();
      if (inEnter) a.offsetYPx -= (1 - enterP) * canvasHeight * 0.18 * k;
      if (inExit) a.offsetYPx += (1 - exitP) * canvasHeight * 0.18 * k;
      break;
    case 'slide-left':
      applyEnterExitOpacity();
      if (inEnter) a.offsetXPx += (1 - enterP) * canvasWidth * 0.22 * k;
      if (inExit) a.offsetXPx -= (1 - exitP) * canvasWidth * 0.22 * k;
      break;
    case 'slide-right':
      applyEnterExitOpacity();
      if (inEnter) a.offsetXPx -= (1 - enterP) * canvasWidth * 0.22 * k;
      if (inExit) a.offsetXPx += (1 - exitP) * canvasWidth * 0.22 * k;
      break;
    case 'dip-to-black':
    case 'dip-to-white': {
      // The item itself stays fully opaque and un-transformed — the "dip"
      // is entirely the overlay wash covering it, ramping from opaque
      // color (hiding the item at the very edge of the window) to
      // transparent (revealing it), and back on exit. A real cut-through-
      // color, not a disguised fade.
      a.overlayColor = preset === 'dip-to-black' ? '#000000' : '#ffffff';
      if (inEnter) a.overlayAlpha = Math.max(a.overlayAlpha, 1 - enterLinear);
      if (inExit) a.overlayAlpha = Math.max(a.overlayAlpha, 1 - exitLinear);
      break;
    }

    // --- Modern / Social ----------------------------------------------
    case 'pop':
      applyEnterExitOpacity();
      if (inEnter) a.scaleMul *= Math.max(0, 1 + (easeOutBack(enterLinear) - 1) * k);
      if (inExit) a.scaleMul *= 1 - (1 - exitP) * 0.4 * k;
      break;
    case 'zoom':
      applyEnterExitOpacity();
      if (inEnter) { a.scaleMul *= 1 - (1 - enterP) * 0.45 * k; a.blurPx = Math.max(a.blurPx, (1 - enterP) * 6 * k); }
      if (inExit) a.scaleMul *= 1 + (1 - exitP) * 0.35 * k;
      break;
    case 'bounce':
      applyEnterExitOpacity();
      if (inEnter) a.offsetYPx += -dampedSine(enterLinear, 2.5) * canvasHeight * 0.12 * k + (1 - enterP) * canvasHeight * 0.05 * k;
      if (inExit) a.offsetYPx += (1 - exitP) * canvasHeight * 0.1 * k;
      break;
    case 'shake':
      // Deterministic high-frequency jitter (sum of two sines at
      // incommensurate frequencies), decaying to 0 — never Math.random(),
      // so the exact same frame renders identically in preview and export.
      if (inEnter) {
        const decay = 1 - enterLinear;
        a.offsetXPx += (Math.sin(enterLinear * 55) * 0.6 + Math.sin(enterLinear * 37 + 1.3) * 0.4) * decay * 14 * k;
      }
      if (inExit) {
        const decay = 1 - exitLinear;
        a.offsetXPx += (Math.sin(exitLinear * 55) * 0.6 + Math.sin(exitLinear * 37 + 1.3) * 0.4) * decay * 14 * k;
      }
      applyEnterExitOpacity();
      break;
    case 'glitch':
      // Stepped (not smooth) horizontal jitter + a blur flicker — reads as
      // "digital glitch" rather than a smooth shake.
      if (inEnter) {
        const step = Math.floor(enterLinear * 10) / 10;
        a.offsetXPx += (Math.sin(step * 97) > 0 ? 1 : -1) * (1 - enterLinear) * 18 * k;
        a.blurPx = Math.max(a.blurPx, (Math.sin(step * 53) > 0.3 ? 4 : 0) * k);
      }
      if (inExit) {
        const step = Math.floor(exitLinear * 10) / 10;
        a.offsetXPx += (Math.sin(step * 97) > 0 ? 1 : -1) * (1 - exitLinear) * 18 * k;
      }
      applyEnterExitOpacity();
      break;
    case 'skew':
      applyEnterExitOpacity();
      if (inEnter) a.skewX += (1 - enterP) * 0.35 * k;
      if (inExit) a.skewX -= (1 - exitP) * 0.35 * k;
      break;
    case 'flip':
      // scaleXMul sweeps through 0 (edge-on, a real "card flip" moment)
      // rather than just easing 0→1 like a normal scale-in.
      applyEnterExitOpacity();
      if (inEnter) a.scaleXMul *= Math.cos((1 - enterP) * (Math.PI / 2) * Math.min(1, k));
      if (inExit) a.scaleXMul *= Math.cos((1 - exitP) * (Math.PI / 2) * Math.min(1, k));
      break;

    // --- Premium / Cinematic -------------------------------------------
    case 'smoke':
      applyEnterExitOpacity();
      if (inEnter) a.blurPx = Math.max(a.blurPx, (1 - enterP) * 22 * k);
      if (inExit) a.blurPx = Math.max(a.blurPx, (1 - exitP) * 22 * k);
      break;
    case 'elastic':
      applyEnterExitOpacity();
      if (inEnter) a.scaleMul *= 1 + dampedSine(enterLinear, 2) * 0.35 * k;
      if (inExit) a.scaleMul *= 1 + dampedSine(exitLinear, 2) * 0.25 * k;
      break;
    case 'light-leak':
      a.overlayColor = '#fff2c2';
      if (inEnter) { a.overlayAlpha = Math.max(a.overlayAlpha, Math.sin(enterLinear * Math.PI) * 0.7 * k); a.blurPx = Math.max(a.blurPx, (1 - enterP) * 5 * k); }
      if (inExit) a.overlayAlpha = Math.max(a.overlayAlpha, Math.sin(exitLinear * Math.PI) * 0.7 * k);
      applyEnterExitOpacity();
      break;
    case 'film-dissolve':
      applyEnterExitOpacity();
      if (inEnter) { a.blurPx = Math.max(a.blurPx, (1 - enterP) * 14 * k); a.scaleMul *= 1 + (1 - enterP) * 0.05 * k; }
      if (inExit) a.blurPx = Math.max(a.blurPx, (1 - exitP) * 14 * k);
      break;
    case 'lens-blur':
      applyEnterExitOpacity();
      if (inEnter) a.blurPx = Math.max(a.blurPx, (1 - enterP) * 16 * k);
      if (inExit) a.blurPx = Math.max(a.blurPx, (1 - exitP) * 16 * k);
      break;
    case 'whip-pan':
      applyEnterExitOpacity();
      if (inEnter) { a.offsetXPx += (1 - enterLinear) * canvasWidth * 0.6 * k; a.blurPx = Math.max(a.blurPx, (1 - enterP) * 18 * k); }
      if (inExit) { a.offsetXPx -= (1 - exitLinear) * canvasWidth * 0.6 * k; a.blurPx = Math.max(a.blurPx, (1 - exitP) * 18 * k); }
      break;
    case 'spin':
      applyEnterExitOpacity();
      if (inEnter) { a.rotationDeltaDeg += (1 - enterP) * 360 * k; a.scaleMul *= 0.7 + 0.3 * enterP; }
      if (inExit) a.rotationDeltaDeg -= (1 - exitP) * 360 * k;
      break;

    // --- Marketing / Advertising ----------------------------------------
    case 'fire':
      applyEnterExitOpacity();
      a.overlayColor = '#ff6a1a';
      if (inEnter) { a.overlayAlpha = Math.max(a.overlayAlpha, (Math.sin(enterLinear * 26) * 0.5 + 0.5) * (1 - enterLinear) * 0.35 * k); a.scaleMul *= 1 + (1 - enterP) * 0.15 * k; }
      if (inExit) a.overlayAlpha = Math.max(a.overlayAlpha, (Math.sin(exitLinear * 26) * 0.5 + 0.5) * (1 - exitLinear) * 0.35 * k);
      break;
    case 'rainbow':
      applyEnterExitOpacity();
      if (inEnter) a.hueRotateDeg += (1 - enterLinear) * 360 * k;
      if (inExit) a.hueRotateDeg += (1 - exitLinear) * 360 * k;
      break;
    case 'heartbeat':
      applyEnterExitOpacity();
      if (inEnter) a.scaleMul *= 1 + (Math.max(0, Math.sin(enterLinear * Math.PI * 4)) * 0.18) * (1 - enterLinear) * k;
      if (inExit) a.scaleMul *= 1 + (Math.max(0, Math.sin(exitLinear * Math.PI * 4)) * 0.18) * (1 - exitLinear) * k;
      break;
    case 'slideSplit':
      applyEnterExitOpacity();
      if (inEnter) { a.offsetXPx += (1 - enterP) * canvasWidth * 0.16 * k; a.scaleXMul *= 1 - (1 - enterP) * 0.3 * k; }
      if (inExit) { a.offsetXPx -= (1 - exitP) * canvasWidth * 0.16 * k; a.scaleXMul *= 1 - (1 - exitP) * 0.3 * k; }
      break;
    case 'fadeup':
      applyEnterExitOpacity();
      if (inEnter) a.offsetYPx += (1 - enterP) * canvasHeight * 0.06 * k;
      if (inExit) a.offsetYPx -= (1 - exitP) * canvasHeight * 0.06 * k;
      break;
    case 'snap-zoom':
      applyEnterExitOpacity();
      if (inEnter) { a.scaleMul *= Math.max(0.1, easeOutBack(enterLinear) * Math.min(1, k) + (1 - Math.min(1, k))); a.blurPx = Math.max(a.blurPx, (1 - enterP) * 10 * k); }
      if (inExit) a.scaleMul *= Math.max(0.1, 1 + (1 - exitP) * 0.5 * k);
      break;
    case 'flash':
      applyEnterExitOpacity();
      a.overlayColor = '#ffffff';
      if (inEnter) a.overlayAlpha = Math.max(a.overlayAlpha, Math.pow(1 - enterLinear, 3) * k);
      if (inExit) a.overlayAlpha = Math.max(a.overlayAlpha, Math.pow(1 - exitLinear, 3) * k);
      break;

    default:
      // Not yet given bespoke motion (e.g. a text-only kinetic-reveal
      // preset used on a non-text item) — a real fade beats a silent
      // no-op for any preset value the UI could ever hand in here.
      applyEnterExitOpacity();
      break;
  }
  a.overlayAlpha = clamp01(a.overlayAlpha);
  return a;
}

/**
 * Linear fade-in/out from `FadeSettings`, independent of `animation` — this
 * is what makes a cross-dissolve between two overlapping adjacent clips
 * possible (see header comment). Exported (full-app audio audit) because
 * `AudioTimelineItem.fade` needs the identical ramp applied to a Web Audio
 * gain node rather than canvas opacity — same math, different destination
 * — in both `PreviewPane.tsx` (live playback) and `canvas2dRenderer.ts`
 * (export), so an audio item's fade-in/fade-out inspector fields are never
 * a control that changes project state with no audible effect.
 */
export function computeFadeOpacity(
  fade: { fadeInDuration: number; fadeOutDuration: number } | undefined,
  sinceStart: number,
  untilEnd: number,
): number {
  if (!fade) return 1;
  // "Universal 30-second media standard" spec item 12 — a fade duration
  // must never exceed `min(MAX_FADE_SECONDS, clip duration)`. Clamped HERE
  // (not just in the inspector UI that sets `fade.fadeInDuration`/
  // `fadeOutDuration`) so it's a correctness guarantee regardless of how a
  // bad value got into project data — old saved projects, a future caller
  // that forgets to clamp, whatever. `sinceStart + untilEnd` is exactly this
  // item's own duration at any point in its playback (it's `(t - startTime)
  // + (endTime - t)` = `endTime - startTime`), so no separate duration
  // parameter is needed. Previously an unclamped fade longer than the clip
  // meant the ramp never reached full opacity/volume even at the clip's
  // midpoint — a real, audible/visible bug, not just a UI nicety.
  const itemDuration = Math.max(0, sinceStart + untilEnd);
  const fadeInDuration = Math.max(0, Math.min(fade.fadeInDuration, MAX_FADE_SECONDS, itemDuration));
  const fadeOutDuration = Math.max(0, Math.min(fade.fadeOutDuration, MAX_FADE_SECONDS, itemDuration));
  let opacity = 1;
  if (fadeInDuration > 0 && sinceStart < fadeInDuration) {
    opacity = Math.min(opacity, clamp01(sinceStart / fadeInDuration));
  }
  if (fadeOutDuration > 0 && untilEnd < fadeOutDuration) {
    opacity = Math.min(opacity, clamp01(untilEnd / fadeOutDuration));
  }
  return opacity;
}

// ---------------------------------------------------------------------------
// Motion/zoom effects (Ken Burns family) — "final production fix" spec item
// 8. Deliberately separate from `computeEntranceExit`: these run
// CONTINUOUSLY across an item's entire on-screen duration (as a function of
// how far into its own lifespan the current frame is), not just briefly at
// entrance/exit, and can be layered on top of an entrance/exit transition
// that's active on the very same frame (`combineAdjustments` below).
// ---------------------------------------------------------------------------

function motionDirectionVector(direction: MotionSettings['direction'] | undefined, fallback: 'x' | 'y'): { dx: number; dy: number } {
  switch (direction) {
    case 'left':
      return { dx: -1, dy: 0 };
    case 'right':
      return { dx: 1, dy: 0 };
    case 'up':
      return { dx: 0, dy: -1 };
    case 'down':
      return { dx: 0, dy: 1 };
    default:
      // No direction chosen — pick a sane default axis per effect so it's
      // never a silent no-op just because direction was left unset.
      return fallback === 'x' ? { dx: 1, dy: 0 } : { dx: 0, dy: -1 };
  }
}

/**
 * Computes the continuous motion-effect adjustment for a frame `elapsedSeconds`
 * into an item's own on-screen lifespan (`durationSeconds` long). Every
 * implemented effect does real, distinct, deterministic motion — never
 * `Math.random()`, so preview and export always agree frame-for-frame,
 * matching `computeEntranceExit`'s own guarantee.
 */
export function computeMotionAdjustment(
  motion: MotionSettings | undefined,
  elapsedSeconds: number,
  durationSeconds: number,
  canvasWidth: number,
  canvasHeight: number,
): AnimatedAdjustment {
  if (!motion || motion.type === 'none') return { ...IDENTITY_ADJUSTMENT };
  const k = Math.max(MOTION_INTENSITY_MIN, Math.min(MOTION_INTENSITY_MAX, motion.intensity || 1));
  const duration = Math.max(0.1, durationSeconds);
  const p = clamp01(elapsedSeconds / duration);
  const a: AnimatedAdjustment = { ...IDENTITY_ADJUSTMENT };

  switch (motion.type) {
    case 'ken-burns': {
      const { dx, dy } = motionDirectionVector(motion.direction, 'x');
      a.offsetXPx += -(p - 0.5) * canvasWidth * 0.12 * k * dx;
      a.offsetYPx += -(p - 0.5) * canvasHeight * 0.12 * k * dy;
      a.scaleMul *= 1 + p * 0.15 * k;
      break;
    }
    case 'slow-zoom-in':
      a.scaleMul *= 1 + p * 0.2 * k;
      break;
    case 'slow-zoom-out':
      a.scaleMul *= 1 + (1 - p) * 0.2 * k;
      break;
    case 'dynamic-zoom':
      a.scaleMul *= 1 + Math.sin(p * Math.PI) * 0.18 * k;
      break;
    case 'punch-zoom':
      // Exponential decay — a sharp punch-in right at the start that
      // quickly settles to normal size, rather than a linear ease.
      a.scaleMul *= 1 + Math.exp(-p * 10) * 0.3 * k;
      break;
    case 'product-focus':
      a.scaleMul *= 1 + p * 0.08 * k;
      a.vignetteAlpha = Math.max(a.vignetteAlpha, 0.25 * k);
      break;
    case 'parallax': {
      const { dx, dy } = motionDirectionVector(motion.direction, 'x');
      a.offsetXPx += (p - 0.5) * canvasWidth * 0.18 * k * dx;
      a.offsetYPx += (p - 0.5) * canvasHeight * 0.18 * k * dy;
      // Scaled up a little so the wider drift never exposes an edge gap.
      a.scaleMul *= 1.08;
      break;
    }
    case 'subtle-shake':
      // Continuous, not decaying — this is the "handheld camera" feel for
      // the item's whole on-screen lifespan, distinct from the transition
      // catalog's 'shake' preset (which only plays briefly at entrance/exit
      // and decays to nothing).
      a.offsetXPx += (Math.sin(elapsedSeconds * 9) * 0.5 + Math.sin(elapsedSeconds * 13 + 0.7) * 0.5) * 3 * k;
      a.offsetYPx += (Math.sin(elapsedSeconds * 11 + 1.1) * 0.5 + Math.sin(elapsedSeconds * 7 + 2.2) * 0.5) * 3 * k;
      break;
    case 'spotlight':
      a.vignetteAlpha = Math.max(a.vignetteAlpha, 0.55 * k);
      a.spotlightBoost = Math.max(a.spotlightBoost, 0.35 * k);
      a.vignetteCenterOffsetXPx += Math.sin(elapsedSeconds * 0.6) * canvasWidth * 0.06 * k;
      a.vignetteCenterOffsetYPx += Math.cos(elapsedSeconds * 0.6) * canvasHeight * 0.06 * k;
      break;
    case 'vignette':
      // A slow "breathing" strength rather than a static filter, so it
      // still reads as motion, not a one-time style choice.
      a.vignetteAlpha = Math.max(a.vignetteAlpha, (0.35 + 0.08 * Math.sin(elapsedSeconds * 1.0)) * k);
      break;
    case 'flash':
      // Periodic strobe pulses (sharp, via a high power), distinct from the
      // transition catalog's one-shot 'flash' preset.
      a.overlayColor = '#ffffff';
      a.overlayAlpha = Math.max(a.overlayAlpha, Math.pow(Math.max(0, Math.sin(elapsedSeconds * 2)), 8) * 0.7 * k);
      break;
    case 'light-sweep':
      // One bright band sweeping left-to-right across the item's own width
      // over its full on-screen duration.
      a.sweepAlpha = Math.max(a.sweepAlpha, 0.55 * k);
      a.sweepPositionPercent = p;
      break;
    default:
      break;
  }
  a.overlayAlpha = clamp01(a.overlayAlpha);
  a.vignetteAlpha = clamp01(a.vignetteAlpha);
  a.spotlightBoost = clamp01(a.spotlightBoost);
  a.sweepAlpha = clamp01(a.sweepAlpha);
  return a;
}

/**
 * Merges an entrance/exit transition adjustment with a continuous motion
 * adjustment for the same frame — both can be active simultaneously (e.g. a
 * photo fading in via `computeEntranceExit` while continuously Ken-Burns
 * panning via `computeMotionAdjustment`). Multiplicative fields multiply,
 * additive/offset fields add, "strongest wins" fields (overlay/blur/vignette)
 * take the max, matching how `computeEntranceExit`'s own presets already
 * combine sub-effects internally.
 */
export function combineAdjustments(transition: AnimatedAdjustment, motion: AnimatedAdjustment): AnimatedAdjustment {
  return {
    opacityMul: transition.opacityMul * motion.opacityMul,
    offsetXPx: transition.offsetXPx + motion.offsetXPx,
    offsetYPx: transition.offsetYPx + motion.offsetYPx,
    scaleMul: transition.scaleMul * motion.scaleMul,
    blurPx: Math.max(transition.blurPx, motion.blurPx),
    overlayAlpha: Math.max(transition.overlayAlpha, motion.overlayAlpha),
    overlayColor: transition.overlayAlpha >= motion.overlayAlpha ? transition.overlayColor : motion.overlayColor,
    skewX: transition.skewX + motion.skewX,
    scaleXMul: transition.scaleXMul * motion.scaleXMul,
    scaleYMul: transition.scaleYMul * motion.scaleYMul,
    rotationDeltaDeg: transition.rotationDeltaDeg + motion.rotationDeltaDeg,
    hueRotateDeg: transition.hueRotateDeg + motion.hueRotateDeg,
    vignetteAlpha: Math.max(transition.vignetteAlpha, motion.vignetteAlpha),
    spotlightBoost: Math.max(transition.spotlightBoost, motion.spotlightBoost),
    vignetteCenterOffsetXPx: transition.vignetteCenterOffsetXPx + motion.vignetteCenterOffsetXPx,
    vignetteCenterOffsetYPx: transition.vignetteCenterOffsetYPx + motion.vignetteCenterOffsetYPx,
    sweepAlpha: Math.max(transition.sweepAlpha, motion.sweepAlpha),
    sweepPositionPercent: motion.sweepAlpha >= transition.sweepAlpha ? motion.sweepPositionPercent : transition.sweepPositionPercent,
  };
}

function applyTransformedDraw(
  ctx: CanvasRenderingContext2D,
  draw: (ctx: CanvasRenderingContext2D) => void,
  transform: Transform,
  centerXPx: number,
  centerYPx: number,
  adjustment: AnimatedAdjustment = IDENTITY_ADJUSTMENT,
) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, transform.opacity * adjustment.opacityMul));
  const filters: string[] = [];
  if (adjustment.blurPx > 0.05) filters.push(`blur(${adjustment.blurPx.toFixed(2)}px)`);
  if (Math.abs(adjustment.hueRotateDeg) > 0.5) filters.push(`hue-rotate(${adjustment.hueRotateDeg.toFixed(1)}deg)`);
  if (filters.length > 0) ctx.filter = filters.join(' ');
  ctx.translate(centerXPx + adjustment.offsetXPx, centerYPx + adjustment.offsetYPx);
  const totalRotationDeg = (transform.rotation || 0) + adjustment.rotationDeltaDeg;
  if (totalRotationDeg) ctx.rotate((totalRotationDeg * Math.PI) / 180);
  if (Math.abs(adjustment.skewX) > 0.001) ctx.transform(1, 0, Math.tan(adjustment.skewX), 1, 0, 0);
  const scaleX = adjustment.scaleMul * adjustment.scaleXMul;
  const scaleY = adjustment.scaleMul * adjustment.scaleYMul;
  if (scaleX !== 1 || scaleY !== 1) ctx.scale(scaleX, scaleY);
  draw(ctx);
  ctx.restore();
}

/**
 * Draws the dip-to-black/white, light-leak, flash, and fire-pulse overlay
 * wash (see `computeEntranceExit`) centered on the origin of whatever
 * transform `draw`'s caller already set up — must be called from *inside*
 * that caller's `draw` closure (same translate/rotate/scale context the
 * item's own content just drew in), not after `applyTransformedDraw`
 * returns, so the overlay tracks the item's position/rotation/scale
 * exactly rather than being a canvas-axis-aligned rectangle.
 */
function drawAdjustmentOverlay(ctx: CanvasRenderingContext2D, halfWidthPx: number, halfHeightPx: number, adjustment: AnimatedAdjustment) {
  if (adjustment.overlayAlpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = clamp01(adjustment.overlayAlpha);
  ctx.fillStyle = adjustment.overlayColor;
  ctx.fillRect(-halfWidthPx, -halfHeightPx, halfWidthPx * 2, halfHeightPx * 2);
  ctx.restore();
}

/**
 * Draws the motion-effect vignette/spotlight (radial gradient, darkened
 * edges with an optional brighter center) and light-sweep (moving linear
 * gradient band) overlays — see `computeMotionAdjustment`'s doc comment for
 * why these need real gradients rather than `drawAdjustmentOverlay`'s flat
 * single-alpha rect. Same calling convention as `drawAdjustmentOverlay`:
 * must run from inside the item's own transform context.
 */
function drawMotionOverlay(ctx: CanvasRenderingContext2D, halfWidthPx: number, halfHeightPx: number, adjustment: AnimatedAdjustment) {
  if (adjustment.vignetteAlpha > 0.01) {
    ctx.save();
    const cx = adjustment.vignetteCenterOffsetXPx;
    const cy = adjustment.vignetteCenterOffsetYPx;
    const outerRadius = Math.max(halfWidthPx, halfHeightPx) * 1.15;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, outerRadius);
    if (adjustment.spotlightBoost > 0.01) {
      gradient.addColorStop(0, `rgba(255,255,255,${clamp01(adjustment.spotlightBoost).toFixed(3)})`);
      gradient.addColorStop(0.45, 'rgba(0,0,0,0)');
    } else {
      gradient.addColorStop(0, 'rgba(0,0,0,0)');
      gradient.addColorStop(0.55, 'rgba(0,0,0,0)');
    }
    gradient.addColorStop(1, `rgba(0,0,0,${clamp01(adjustment.vignetteAlpha).toFixed(3)})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(-halfWidthPx, -halfHeightPx, halfWidthPx * 2, halfHeightPx * 2);
    ctx.restore();
  }
  if (adjustment.sweepAlpha > 0.01) {
    ctx.save();
    const width = halfWidthPx * 2;
    const bandCenter = -halfWidthPx + adjustment.sweepPositionPercent * width;
    const bandWidth = Math.max(width * 0.18, 20);
    const gradient = ctx.createLinearGradient(bandCenter - bandWidth, 0, bandCenter + bandWidth, 0);
    gradient.addColorStop(0, 'rgba(255,255,255,0)');
    gradient.addColorStop(0.5, `rgba(255,255,255,${clamp01(adjustment.sweepAlpha).toFixed(3)})`);
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(-halfWidthPx, -halfHeightPx, halfWidthPx * 2, halfHeightPx * 2);
    ctx.restore();
  }
}

/** Shared timing → adjustment helper for the three animatable item types (video/image/text). */
function animationFor(
  item: {
    startTime: number;
    endTime: number;
    fade?: { fadeInDuration: number; fadeOutDuration: number };
    animation?: { entrance?: AnimationPreset; exit?: AnimationPreset; intensity?: number };
  },
  timeSeconds: number,
  canvasWidth: number,
  canvasHeight: number,
): AnimatedAdjustment {
  const sinceStart = timeSeconds - item.startTime;
  const untilEnd = item.endTime - timeSeconds;
  const duration = item.endTime - item.startTime;
  const preset = sinceStart <= duration / 2 ? item.animation?.entrance : item.animation?.exit;
  const a = computeEntranceExit(preset, sinceStart, untilEnd, duration, canvasWidth, canvasHeight, item.animation?.intensity);
  a.opacityMul *= computeFadeOpacity(item.fade, sinceStart, untilEnd);
  return a;
}

function drawVideoItem(
  ctx: CanvasRenderingContext2D,
  item: { position: Transform['position']; scale: number; rotation: number; opacity: number; startTime: number; endTime: number; fade?: { fadeInDuration: number; fadeOutDuration: number }; animation?: { entrance?: AnimationPreset; exit?: AnimationPreset }; motion?: MotionSettings; pip?: { shape: string; borderWidth: number; borderColor: string; shadow: boolean; isPip: boolean } },
  videoEl: HTMLVideoElement,
  canvasWidth: number,
  canvasHeight: number,
  timeSeconds: number,
) {
  const centerX = (item.position.x / 100) * canvasWidth;
  const centerY = (item.position.y / 100) * canvasHeight;
  const w = canvasWidth * item.scale;
  const h = canvasHeight * item.scale;
  const transitionAdjustment = animationFor(item, timeSeconds, canvasWidth, canvasHeight);
  const motionAdjustment = computeMotionAdjustment(item.motion, timeSeconds - item.startTime, item.endTime - item.startTime, canvasWidth, canvasHeight);
  const adjustment = combineAdjustments(transitionAdjustment, motionAdjustment);
  const isPip = !!item.pip?.isPip;
  applyTransformedDraw(
    ctx,
    (c) => {
      // PiP clipping: circle / rounded-rect clip + optional border + shadow.
      // Runs inside the item's own transform context, so it tracks position/rotation/scale.
      const pip = isPip ? item.pip! : null;
      if (pip) {
        c.save();
        if (pip.shadow) { c.shadowColor = 'rgba(0,0,0,0.45)'; c.shadowBlur = 18; c.shadowOffsetY = 6; }
        c.beginPath();
        if (pip.shape === 'circle') {
          // Circle inscribed in the video rect (uses min side so it stays round even for 16:9 sources).
          const r = Math.min(w, h) / 2;
          c.arc(0, 0, r, 0, Math.PI * 2);
        } else if (pip.shape === 'rounded') {
          const rad = Math.min(28, Math.min(w, h) * 0.12);
          c.roundRect(-w / 2, -h / 2, w, h, rad);
        } else {
          c.rect(-w / 2, -h / 2, w, h);
        }
        c.clip();
      }
      try {
        if (pip?.shape === 'circle') {
          // Cover-fit inside the circle: draw so the circle is fully filled (no letterbox).
          const r = Math.min(w, h) / 2;
          const size = r * 2;
          c.drawImage(videoEl, -size / 2, -size / 2, size, size);
        } else {
          c.drawImage(videoEl, -w / 2, -h / 2, w, h);
        }
      } catch {
        // Video not yet seekable/decoded to this frame — skip this frame rather than throw.
      }
      if (pip) {
        c.restore();
        // Border drawn after restore (outside clip) so it is not clipped away.
        if (pip.borderWidth > 0) {
          c.save();
          c.lineWidth = pip.borderWidth;
          c.strokeStyle = pip.borderColor;
          c.beginPath();
          if (pip.shape === 'circle') {
            const r = Math.min(w, h) / 2;
            c.arc(0, 0, r, 0, Math.PI * 2);
          } else if (pip.shape === 'rounded') {
            const rad = Math.min(28, Math.min(w, h) * 0.12);
            c.roundRect(-w / 2, -h / 2, w, h, rad);
          } else {
            c.rect(-w / 2, -h / 2, w, h);
          }
          c.stroke();
          c.restore();
        }
      }
      drawAdjustmentOverlay(c, w / 2, h / 2, adjustment);
      drawMotionOverlay(c, w / 2, h / 2, adjustment);
    },
    item,
    centerX,
    centerY,
    adjustment,
  );
}

/**
 * True once `img` has finished loading successfully and has real pixel
 * dimensions. A broken image (failed network fetch, CORS rejection, 404,
 * etc.) still has `complete === true` but `naturalWidth === 0` — this is
 * the standard way to tell "loaded" apart from "finished trying and
 * failed" for an `HTMLImageElement`. `drawImage()` throws a synchronous
 * `InvalidStateError` on a broken image, so every caller must gate on this
 * before drawing rather than assuming a non-null `img` is usable.
 */
function isImageReady(img: HTMLImageElement): boolean {
  return img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
}

function drawImageItem(
  ctx: CanvasRenderingContext2D,
  item: ImageTimelineItem,
  img: HTMLImageElement,
  canvasWidth: number,
  canvasHeight: number,
  timeSeconds: number,
) {
  const centerX = (item.position.x / 100) * canvasWidth;
  const centerY = (item.position.y / 100) * canvasHeight;
  const baseWidth = canvasWidth * 0.25 * item.scale;
  const aspect = img.naturalHeight > 0 && img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : 1;
  const w = baseWidth;
  const h = baseWidth * aspect;
  const transitionAdjustment = animationFor(item, timeSeconds, canvasWidth, canvasHeight);
  const motionAdjustment = computeMotionAdjustment(item.motion, timeSeconds - item.startTime, item.endTime - item.startTime, canvasWidth, canvasHeight);
  const adjustment = combineAdjustments(transitionAdjustment, motionAdjustment);
  applyTransformedDraw(
    ctx,
    (c) => {
      try {
        c.drawImage(img, -w / 2, -h / 2, w, h);
      } catch {
        // Defense in depth only — the isImageReady() gate in drawFrame is
        // the real guard against a broken image. Mirrors drawVideoItem's
        // existing try/catch so a race between the check and the draw call
        // can never crash the render/animation loop.
      }
      drawAdjustmentOverlay(c, w / 2, h / 2, adjustment);
      drawMotionOverlay(c, w / 2, h / 2, adjustment);
    },
    item,
    centerX,
    centerY,
    adjustment,
  );
}

/** Splits `text` into whichever unit `preset` reveals progressively; `null` means "draw the whole string at once" (no kinetic reveal). */
function kineticRevealText(text: string, preset: AnimationPreset | undefined, sinceStart: number, durationSeconds: number): string {
  if (preset === 'typewriter') {
    const revealSeconds = Math.min(durationSeconds * 0.6, Math.max(0.3, text.length * 0.045));
    const fraction = clamp01(sinceStart / revealSeconds);
    return text.slice(0, Math.round(text.length * fraction));
  }
  if (preset === 'word-by-word') {
    const words = text.split(' ');
    const revealSeconds = Math.min(durationSeconds * 0.7, Math.max(0.3, words.length * 0.18));
    const fraction = clamp01(sinceStart / revealSeconds);
    const count = Math.max(1, Math.round(words.length * fraction));
    return words.slice(0, count).join(' ');
  }
  return text;
}

function drawTextItem(ctx: CanvasRenderingContext2D, item: TextTimelineItem, canvasWidth: number, canvasHeight: number, timeSeconds: number) {
  const centerX = (item.position.x / 100) * canvasWidth;
  const centerY = (item.position.y / 100) * canvasHeight;
  const adjustment = animationFor(item, timeSeconds, canvasWidth, canvasHeight);
  const sinceStart = timeSeconds - item.startTime;
  const duration = item.endTime - item.startTime;
  const displayText = kineticRevealText(item.text, item.animation?.entrance, sinceStart, duration);
  // `item.scale` is part of the shared `Transform` every text item carries
  // (and was already user-adjustable via the inspector's "Scale" slider),
  // but was never actually read here — found during the full-app button
  // audit as a control that updates project state with zero visible effect
  // ("dead control" per the audit's own definition). Folding it into the
  // effective font size is what makes that slider (and canvas-drag resize,
  // see PreviewPane.tsx) do something real.
  const effectiveFontSize = item.fontSize * (item.scale || 1);
  applyTransformedDraw(
    ctx,
    (c) => {
      c.font = `${effectiveFontSize}px Arial, Helvetica, sans-serif`;
      c.fillStyle = item.color;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(displayText, 0, 0);
      // Text has no fixed draw box (see getItemBoundsPercent's own note),
      // so the overlay-based presets (dip/light-leak/flash/fire) measure a
      // padded box around the text actually drawn this frame rather than
      // skipping overlay support for this item type.
      const textWidth = c.measureText(displayText || ' ').width;
      drawAdjustmentOverlay(c, textWidth / 2 + effectiveFontSize * 0.3, effectiveFontSize * 0.7, adjustment);
    },
    item,
    centerX,
    centerY,
    adjustment,
  );
}

// ---------------------------------------------------------------------------
// On-canvas selection geometry — full-app audit ("free canvas positioning")
//
// The editor preview needs to draw a real selection box + drag/resize
// handles around whichever video/image/text item is selected, using the
// EXACT same size/position rules `drawVideoItem`/`drawImageItem`/
// `drawTextItem` use to actually draw it — otherwise the handles would be a
// second, hand-kept-in-sync notion of "how big is this item" that drifts
// from what's really rendered. `getItemBoundsPercent` is that one shared
// source of truth, expressed as percentages of canvas width/height (not
// pixels) so the caller (PreviewPane, an HTML overlay on top of the canvas
// element) can position a CSS box without needing to know the canvas's
// on-screen pixel size at all.
// ---------------------------------------------------------------------------

export interface ItemBoundsPercent {
  /** Left edge, as a percentage (0-100) of canvas width. */
  leftPercent: number;
  /** Top edge, as a percentage (0-100) of canvas height. */
  topPercent: number;
  widthPercent: number;
  heightPercent: number;
}

export function getItemBoundsPercent(
  item: { position: Transform['position']; scale: number },
  itemType: 'video' | 'image' | 'text',
  canvasWidth: number,
  canvasHeight: number,
  opts: { naturalImageAspect?: number; textWidthPx?: number; textHeightPx?: number } = {},
): ItemBoundsPercent {
  let widthPx: number;
  let heightPx: number;
  if (itemType === 'video') {
    // Mirrors drawVideoItem: fills the canvas at scale 1.
    widthPx = canvasWidth * item.scale;
    heightPx = canvasHeight * item.scale;
  } else if (itemType === 'image') {
    // Mirrors drawImageItem: 25% of canvas width at scale 1, source aspect preserved.
    const baseWidth = canvasWidth * 0.25 * item.scale;
    const aspect = opts.naturalImageAspect ?? 1;
    widthPx = baseWidth;
    heightPx = baseWidth * aspect;
  } else {
    // text — drawTextItem has no fixed box (it's font-size/measureText
    // driven), so the caller measures the actual rendered text and passes
    // the result through rather than this function guessing at a size.
    widthPx = opts.textWidthPx ?? canvasWidth * 0.3;
    heightPx = opts.textHeightPx ?? 40;
  }
  const widthPercent = (widthPx / canvasWidth) * 100;
  const heightPercent = (heightPx / canvasHeight) * 100;
  return {
    leftPercent: item.position.x - widthPercent / 2,
    topPercent: item.position.y - heightPercent / 2,
    widthPercent,
    heightPercent,
  };
}

// ---------------------------------------------------------------------------
// Captions — premium short-form styling: line wrapping, safe-area
// placement, and a per-word "pop" as each word becomes active.
// ---------------------------------------------------------------------------

const CAPTION_SAFE_AREA_BOTTOM_FRACTION = 0.82;
const CAPTION_MAX_LINE_WIDTH_FRACTION = 0.86;
const CAPTION_WORD_POP_SECONDS = 0.18;

interface CaptionLine {
  words: string[];
  widths: number[];
  totalWidth: number;
  startIndex: number;
}

function wrapCaptionWords(ctx: CanvasRenderingContext2D, words: string[], spaceWidth: number, maxLineWidth: number): CaptionLine[] {
  const lines: CaptionLine[] = [];
  let current: CaptionLine = { words: [], widths: [], totalWidth: 0, startIndex: 0 };
  words.forEach((word, index) => {
    const width = ctx.measureText(word).width;
    const extra = current.words.length > 0 ? spaceWidth + width : width;
    if (current.words.length > 0 && current.totalWidth + extra > maxLineWidth) {
      lines.push(current);
      current = { words: [], widths: [], totalWidth: 0, startIndex: index };
    }
    current.words.push(word);
    current.widths.push(width);
    current.totalWidth += current.widths.length > 1 ? spaceWidth + width : width;
  });
  if (current.words.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [{ words: [], widths: [], totalWidth: 0, startIndex: 0 }];
}

function drawCaptionItem(
  ctx: CanvasRenderingContext2D,
  item: CaptionTimelineItem,
  relativeTime: number,
  canvasWidth: number,
  canvasHeight: number,
) {
  const style = getCaptionStyle(item.captionStyleId);
  const centerX = canvasWidth / 2;

  ctx.save();
  ctx.font = `bold ${style.fontSize}px ${style.fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const activeIndex = item.words.findIndex((w) => relativeTime >= w.start && relativeTime < w.end);
  const words = item.words.map((w) => (style.uppercase ? w.text.toUpperCase() : w.text));
  const spaceWidth = ctx.measureText(' ').width;
  const maxLineWidth = canvasWidth * CAPTION_MAX_LINE_WIDTH_FRACTION;
  const lines = wrapCaptionWords(ctx, words, spaceWidth, maxLineWidth);

  const lineHeight = style.fontSize * 1.28;
  // Anchor the LAST line at the bottom safe area and grow upward, matching
  // how short-form captions are conventionally placed (stays clear of
  // platform UI chrome at the bottom of the frame) regardless of how many
  // lines a long cue wraps into.
  const lastLineCenterY = canvasHeight * CAPTION_SAFE_AREA_BOTTOM_FRACTION;
  const firstLineCenterY = lastLineCenterY - (lines.length - 1) * lineHeight;

  if (style.background) {
    const paddingX = 24;
    const paddingY = 14;
    const widestLine = Math.max(...lines.map((l) => l.totalWidth));
    const blockTop = firstLineCenterY - style.fontSize / 2 - paddingY;
    const blockHeight = lastLineCenterY + style.fontSize / 2 + paddingY - blockTop;
    ctx.fillStyle = style.background;
    ctx.fillRect(centerX - widestLine / 2 - paddingX, blockTop, widestLine + paddingX * 2, blockHeight);
  }

  lines.forEach((line, lineIndex) => {
    const centerY = firstLineCenterY + lineIndex * lineHeight;
    let cursorX = centerX - line.totalWidth / 2;
    line.words.forEach((word, wordIndexInLine) => {
      const wordIndex = line.startIndex + wordIndexInLine;
      const isActive = wordIndex === activeIndex;
      const width = line.widths[wordIndexInLine];
      const x = cursorX + width / 2;

      // Premium "punch" — the word that just became active pops in with a
      // brief overshoot scale rather than a flat highlight swap.
      let scaleMul = 1;
      if (isActive) {
        const sinceWordStart = relativeTime - item.words[wordIndex].start;
        if (sinceWordStart >= 0 && sinceWordStart < CAPTION_WORD_POP_SECONDS) {
          scaleMul = Math.max(0.8, easeOutBack(clamp01(sinceWordStart / CAPTION_WORD_POP_SECONDS)));
        }
      }

      ctx.save();
      ctx.translate(x, centerY);
      if (scaleMul !== 1) ctx.scale(scaleMul, scaleMul);
      if (style.strokeColor && style.strokeColor !== 'transparent' && style.strokeWidth > 0) {
        ctx.lineWidth = style.strokeWidth;
        ctx.strokeStyle = style.strokeColor;
        ctx.strokeText(word, 0, 0);
      }
      ctx.fillStyle = isActive ? style.color : hexWithAlpha(style.color, 0.72);
      ctx.fillText(word, 0, 0);
      ctx.restore();

      cursorX += width + spaceWidth;
    });
  });
  ctx.restore();
}

function hexWithAlpha(color: string, alpha: number): string {
  // Caption colors in the style catalog are always #rrggbb; falls back to
  // the raw color unchanged for anything else (e.g. a future named color).
  if (/^#([0-9a-fA-F]{6})$/.test(color)) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return color;
}

/** Draws one composited frame for `project` at `timeSeconds` into `ctx`. Clears and fills black first. */
export function drawFrame(ctx: CanvasRenderingContext2D, project: Project, timeSeconds: number, assets: FrameAssets): void {
  const { canvasWidth, canvasHeight } = project;
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  const activeItems = getItemsAtTime(project, timeSeconds); // already sorted back-to-front by zIndex

  for (const item of activeItems) {
    if (!item.visible) continue;
    switch (item.type) {
      case 'video': {
        const videoEl =
          assets.videos?.get(item.mediaAssetId) ??
          (assets.activeVideo && assets.activeVideo.assetId === item.mediaAssetId ? assets.activeVideo.element : undefined);
        if (videoEl) {
          drawVideoItem(ctx, item, videoEl, canvasWidth, canvasHeight, timeSeconds);
        }
        break;
      }
      case 'image': {
        const img = assets.images.get(item.mediaAssetId);
        // isImageReady guards against drawing a broken image (failed
        // fetch/CORS-rejected/still-loading) — see its doc comment above.
        // This is a render-loop safety net, not a fix for *why* an image
        // might fail to load (e.g. missing Storage CORS config).
        if (img && isImageReady(img)) drawImageItem(ctx, item, img, canvasWidth, canvasHeight, timeSeconds);
        break;
      }
      case 'text': {
        drawTextItem(ctx, item, canvasWidth, canvasHeight, timeSeconds);
        break;
      }
      case 'caption': {
        drawCaptionItem(ctx, item, timeSeconds - item.startTime, canvasWidth, canvasHeight);
        break;
      }
      case 'audio':
        break; // nothing to draw
      default:
        break;
    }
  }

  // v1 free-tier watermark: premium pill badge, bottom-right. Paid projects
  // set watermarkEnabled=false. Undefined = true (pre-v1 projects default to free).
  // Design: subtle dark pill (not a big logo), small yellow RiddimRoom dot + clean
  // white text. Sits bottom-right so it never covers centered captions or PiP.
  // Opacity + size kept low on purpose — free users should not hate it.
  if (project.watermarkEnabled !== false) {
    ctx.save();
    const label = 'Made with RiddimRoom Studio';
    const fontSize = Math.max(13, Math.round(canvasWidth * 0.016));
    ctx.font = `600 ${fontSize}px Inter, Arial, Helvetica, sans-serif`;
    const textWidth = ctx.measureText(label).width;
    const dotRadius = Math.max(3.5, fontSize * 0.28);
    const padX = Math.round(fontSize * 0.85);
    const padY = Math.round(fontSize * 0.45);
    const pillW = padX * 2 + dotRadius * 2 + 6 + textWidth;
    const pillH = fontSize + padY * 2;
    const margin = Math.round(canvasWidth * 0.018);
    const x = canvasWidth - margin - pillW;
    const y = canvasHeight - margin - pillH;
    const radius = pillH / 2;
    // Pill background
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, pillW, pillH, radius);
    } else {
      ctx.rect(x, y, pillW, pillH);
    }
    ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.stroke();
    // Yellow RiddimRoom dot
    const dotX = x + padX + dotRadius;
    const dotY = y + pillH / 2;
    ctx.beginPath();
    ctx.arc(dotX, dotY, dotRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#FFD100';
    ctx.fill();
    // Label
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillText(label, dotX + dotRadius + 6, dotY + 1);
    ctx.restore();
  }
}
