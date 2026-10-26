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

import type { AnimationPreset, CaptionTimelineItem, ColorGradeSettings, CropSettings, EndTransformSettings, FramingSettings, ImageTimelineItem, MotionSettings, Project, TextTimelineItem, Transform } from '../../types/timeline';
import { canvasFontStack } from '../fonts';
import { PIP_GOLD_RING_STOPS, tracePipShapePath } from '../pip';
import { getItemsAtTime } from '../timeline/utils';
import { colorGradeToFilter } from '../grades';
import { getCaptionStyle, resolveCaptionFontPx } from '../captions/styles';
import { findTransitionPreset, TRANSITION_INTENSITY_MAX, TRANSITION_INTENSITY_MIN } from '../transitions';
import { MOTION_INTENSITY_MAX, MOTION_INTENSITY_MIN } from '../motionEffects';
import { cineInOut, lerp, returnBlend, smootherstep } from '../motion/easing';
import { claimTextBox, type TextBox } from './textGuard';
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
  /**
   * Templates v3 additions — OPTIONAL on purpose: they are absent (not
   * merely identity-valued) unless a v3 preset sets them, so the exact
   * shape of adjustments for every pre-v3 preset is unchanged.
   * `brightnessMul`: 1 = unchanged; folded into the same `ctx.filter` as
   * blur/hue-rotate by `applyTransformedDraw` (luma-fade's sweep).
   * `maskProgress`: 1 = fully revealed; < 1 clips the item to a circle
   * of that fraction of its bounding diagonal, feathered at the edge
   * (mask-reveal) — applied by `applyTransformedDraw` when the caller
   * supplies the item's half-extents.
   */
  brightnessMul?: number;
  maskProgress?: number;
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
    case 'dip-to-white':
    case 'dip-to-gold': {
      // The item itself stays fully opaque and un-transformed — the "dip"
      // is entirely the overlay wash covering it, ramping from opaque
      // color (hiding the item at the very edge of the window) to
      // transparent (revealing it), and back on exit. A real cut-through-
      // color, not a disguised fade. 'dip-to-gold' (v3) is the same
      // mechanism through the brand gold #FFD100.
      a.overlayColor = preset === 'dip-to-black' ? '#000000' : preset === 'dip-to-white' ? '#ffffff' : '#FFD100';
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
    // --- Templates v3 premium build-out --------------------------------
    case 'cross-zoom':
      // Scale + blur crossfade: the item arrives oversized and blurred,
      // settling into focus (the "through the lens" punch), mirrored out.
      applyEnterExitOpacity();
      if (inEnter) { a.scaleMul *= 1 + (1 - enterP) * 0.6 * k; a.blurPx = Math.max(a.blurPx, (1 - enterP) * 16 * k); }
      if (inExit) { a.scaleMul *= 1 + (1 - exitP) * 0.6 * k; a.blurPx = Math.max(a.blurPx, (1 - exitP) * 16 * k); }
      break;
    case 'mask-reveal': {
      // Feathered circular reveal: `maskProgress` sweeps 0→1 (the clip
      // circle grows to cover the item's diagonal) with a slight scale
      // settle underneath; `applyTransformedDraw` renders the clip +
      // feather. Exit shrinks the circle back down.
      applyEnterExitOpacity();
      let maskProgress = 1;
      if (inEnter) maskProgress = Math.min(maskProgress, enterLinear);
      if (inExit) maskProgress = Math.min(maskProgress, exitLinear);
      a.maskProgress = maskProgress;
      if (inEnter) a.scaleMul *= 1 + (1 - enterP) * 0.06 * k;
      if (inExit) a.scaleMul *= 1 + (1 - exitP) * 0.06 * k;
      break;
    }
    case 'luma-fade':
      // Brightness-swept dissolve: the item materializes out of a blown-
      // out bright ghost (brightnessMul > 1) as its opacity ramps in —
      // highlights arrive first, like a film printer fade-in — and
      // dissolves back out through the same bright sweep.
      applyEnterExitOpacity();
      if (inEnter) a.brightnessMul = Math.max(a.brightnessMul ?? 1, 1 + (1 - enterLinear) * 1.6 * k);
      if (inExit) a.brightnessMul = Math.max(a.brightnessMul ?? 1, 1 + (1 - exitLinear) * 1.6 * k);
      break;
    case 'film-burn':
      // Warm additive burn: a deep-orange wash swells to a peak mid-
      // window and recedes (a smooth sine, distinct from light-leak's
      // pale wash and fire's flicker), with a gentle push-in underneath.
      a.overlayColor = '#ff7a1a';
      if (inEnter) { a.overlayAlpha = Math.max(a.overlayAlpha, Math.sin(enterLinear * Math.PI) * 0.85 * k); a.scaleMul *= 1 + (1 - enterP) * 0.08 * k; a.blurPx = Math.max(a.blurPx, (1 - enterP) * 4 * k); }
      if (inExit) { a.overlayAlpha = Math.max(a.overlayAlpha, Math.sin(exitLinear * Math.PI) * 0.85 * k); a.scaleMul *= 1 + (1 - exitP) * 0.08 * k; }
      applyEnterExitOpacity();
      break;
    case 'smooth-spin':
      // A gentle eased tilt-and-settle (±28°), the refined cousin of
      // 'spin''s full 360° — rotation stays small enough for footage.
      applyEnterExitOpacity();
      if (inEnter) { a.rotationDeltaDeg += (1 - enterP) * 28 * k; a.scaleMul *= 0.92 + 0.08 * enterP; }
      if (inExit) { a.rotationDeltaDeg -= (1 - exitP) * 28 * k; a.scaleMul *= 0.92 + 0.08 * exitP; }
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

/**
 * Tweaks round — looping audio (`AudioTimelineItem.loop`). Maps an item's
 * elapsed timeline seconds to the source position inside its trim window,
 * wrapping at the window's end: a 8s window asked for 20s of timeline
 * plays 0-8, 0-8, 0-4. Shared by PreviewPane and canvas2dRenderer so the
 * preview and the export wrap at exactly the same moments (each caller
 * compares its element's actual position against this target and seeks
 * when they diverge — the element's own `loop` property is deliberately
 * NOT used, since it wraps at the FILE's end, not the trim window's).
 * Within the first pass (`elapsed <= span`) this is exactly
 * `trimStart + elapsed`, i.e. identical to the non-loop mapping.
 */
export function computeLoopedSourceTime(trimStart: number, trimEnd: number, elapsedSeconds: number): number {
  const span = trimEnd - trimStart;
  const elapsed = Math.max(0, elapsedSeconds);
  if (!(span > 0)) return trimStart + elapsed;
  return trimStart + (elapsed % span);
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
    case 'word-tour': {
      // R12 word-box camera: interpolate offset + zoom between the
      // baked stops with a smoothstep inside each segment, so the
      // camera glides and settles on each word instead of cutting.
      const stops = (motion.tourStops || []).filter((st) => Number.isFinite(st.t)).sort((m, n) => m.t - n.t);
      if (stops.length > 0) {
        const first = stops[0];
        const last = stops[stops.length - 1];
        if (p <= first.t) {
          a.offsetXPx += first.x * canvasWidth;
          a.offsetYPx += first.y * canvasHeight;
          a.scaleMul *= first.scale;
        } else if (p >= last.t) {
          a.offsetXPx += last.x * canvasWidth;
          a.offsetYPx += last.y * canvasHeight;
          a.scaleMul *= last.scale;
        } else {
          for (let i = 0; i < stops.length - 1; i++) {
            const s0 = stops[i];
            const s1 = stops[i + 1];
            if (p >= s0.t && p <= s1.t) {
              const span = Math.max(0.0001, s1.t - s0.t);
              const u0 = (p - s0.t) / span;
              const u = smootherstep(u0);
              a.offsetXPx += (s0.x + (s1.x - s0.x) * u) * canvasWidth;
              a.offsetYPx += (s0.y + (s1.y - s0.y) * u) * canvasHeight;
              a.scaleMul *= s0.scale + (s1.scale - s0.scale) * u;
              break;
            }
          }
        }
      }
      break;
    }
    case 'ken-burns': {
      const { dx, dy } = motionDirectionVector(motion.direction, 'x');
      const ke = cineInOut(p);
      a.offsetXPx += -(ke - 0.5) * canvasWidth * 0.12 * k * dx;
      a.offsetYPx += -(ke - 0.5) * canvasHeight * 0.12 * k * dy;
      a.scaleMul *= 1 + ke * 0.15 * k;
      break;
    }
    case 'slow-zoom-in':
      a.scaleMul *= 1 + cineInOut(p) * 0.2 * k;
      break;
    case 'slow-zoom-out':
      a.scaleMul *= 1 + (1 - cineInOut(p)) * 0.2 * k;
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
    case 'dolly-push':
      // R22: a confident cinematic push — eased scale with a whisper
      // of forward drift. Pairs with homecoming for the return.
      a.scaleMul *= 1 + cineInOut(p) * 0.12 * k;
      a.offsetYPx += -Math.sin(p * Math.PI) * canvasHeight * 0.012 * k;
      break;
    case 'orbit-drift': {
      // R22: a slow orbital sway on a full cycle — home at both
      // ends by construction.
      const sway = Math.sin(p * Math.PI * 2);
      a.rotationDeltaDeg += sway * 2 * k;
      a.offsetXPx += sway * canvasWidth * 0.02 * k;
      a.scaleMul *= 1.05;
      break;
    }
    case 'focus-pull':
      // R22: rack into focus — opening blur resolves over the first
      // third while an opening scale settles to 1.
      a.blurPx = Math.max(a.blurPx, (1 - smootherstep(p / 0.32)) * 9 * k);
      a.scaleMul *= 1 + (1 - cineInOut(p)) * 0.04 * k;
      break;
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
  // R22 Homecoming: a flagged move blends back to the home framing
  // (the identity adjustment) across its final stretch, so the
  // piece lands on the full, uncropped artwork — on the same curve
  // it left on, never a snap.
  if (motion.homecoming) {
    const blend = returnBlend(p, 0.8);
    if (blend > 0) {
      a.scaleMul = lerp(a.scaleMul, 1, blend);
      a.offsetXPx = lerp(a.offsetXPx, 0, blend);
      a.offsetYPx = lerp(a.offsetYPx, 0, blend);
      a.rotationDeltaDeg = lerp(a.rotationDeltaDeg, 0, blend);
    }
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
  const combined: AnimatedAdjustment = {
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
  // Templates v3 optional fields: brightness multiplies like the other
  // gain fields; the mask takes whichever side reveals LESS (the more
  // closed mask wins, mirroring opacity's "most restrictive" rule). Keys
  // are only present when an input carried them, preserving the pre-v3
  // adjustment shape otherwise.
  if (transition.brightnessMul !== undefined || motion.brightnessMul !== undefined) {
    combined.brightnessMul = (transition.brightnessMul ?? 1) * (motion.brightnessMul ?? 1);
  }
  if (transition.maskProgress !== undefined || motion.maskProgress !== undefined) {
    combined.maskProgress = Math.min(transition.maskProgress ?? 1, motion.maskProgress ?? 1);
  }
  return combined;
}

function applyTransformedDraw(
  ctx: CanvasRenderingContext2D,
  draw: (ctx: CanvasRenderingContext2D) => void,
  transform: Transform,
  centerXPx: number,
  centerYPx: number,
  adjustment: AnimatedAdjustment = IDENTITY_ADJUSTMENT,
  options: {
    /** Item half-extents in draw space — required for the mask-reveal clip (v3); without them a mask adjustment degrades to its opacity ramp alone. */
    halfWidthPx?: number;
    halfHeightPx?: number;
    /** Extra `ctx.filter` fragment appended after blur/hue/brightness — the item's color grade (v3, `colorGradeToFilter`). */
    extraFilter?: string;
  } = {},
) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, transform.opacity * adjustment.opacityMul));
  const filters: string[] = [];
  if (adjustment.blurPx > 0.05) filters.push(`blur(${adjustment.blurPx.toFixed(2)}px)`);
  if (Math.abs(adjustment.hueRotateDeg) > 0.5) filters.push(`hue-rotate(${adjustment.hueRotateDeg.toFixed(1)}deg)`);
  if (adjustment.brightnessMul !== undefined && Math.abs(adjustment.brightnessMul - 1) > 0.01) {
    filters.push(`brightness(${adjustment.brightnessMul.toFixed(3)})`);
  }
  if (options.extraFilter) filters.push(options.extraFilter);
  if (filters.length > 0) ctx.filter = filters.join(' ');
  ctx.translate(centerXPx + adjustment.offsetXPx, centerYPx + adjustment.offsetYPx);
  const totalRotationDeg = (transform.rotation || 0) + adjustment.rotationDeltaDeg;
  if (totalRotationDeg) ctx.rotate((totalRotationDeg * Math.PI) / 180);
  if (Math.abs(adjustment.skewX) > 0.001) ctx.transform(1, 0, Math.tan(adjustment.skewX), 1, 0, 0);
  const scaleX = adjustment.scaleMul * adjustment.scaleXMul;
  const scaleY = adjustment.scaleMul * adjustment.scaleYMul;
  if (scaleX !== 1 || scaleY !== 1) ctx.scale(scaleX, scaleY);
  const maskProgress = adjustment.maskProgress;
  if (
    maskProgress !== undefined &&
    maskProgress < 0.999 &&
    options.halfWidthPx !== undefined &&
    options.halfHeightPx !== undefined
  ) {
    // Mask reveal (v3): clip to a circle of `maskProgress` × the item's
    // half-diagonal, then feather the rim — a `destination-out` radial
    // gradient erases progressively across a band just inside the clip
    // edge, so the reveal edge is soft instead of a hard circle cut.
    // (On the shared canvas the feather band fades toward whatever is
    // beneath the item — over the usual black frame that reads as a
    // soft dissolve rim, the standard canvas approximation of a
    // feathered mask.) Runs entirely inside this item's transform
    // context, so it tracks position/rotation/scale like every overlay.
    const hw = options.halfWidthPx;
    const hh = options.halfHeightPx;
    const halfDiagonal = Math.hypot(hw, hh);
    const feather = Math.max(4, halfDiagonal * 0.1);
    const r = clamp01(maskProgress) * (halfDiagonal + feather);
    ctx.beginPath();
    ctx.arc(0, 0, r + feather, 0, Math.PI * 2);
    ctx.clip();
    draw(ctx);
    ctx.save();
    ctx.filter = 'none';
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, r + feather);
    const bandStart = r + feather > 0 ? Math.max(0, Math.min(1, r / (r + feather))) : 0;
    gradient.addColorStop(bandStart, 'rgba(0,0,0,0)');
    gradient.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = gradient;
    ctx.fillRect(-hw, -hh, hw * 2, hh * 2);
    ctx.restore();
  } else {
    draw(ctx);
  }
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

/**
 * Phase 2.3 — keyframe-lite interpolation. Returns the item's effective
 * transform at `progress` (0 = item start, 1 = item end) between its base
 * `Transform` and its optional `endTransform`: position/scale/opacity
 * lerp (smoothstep when the end settings ask for easing); rotation always
 * holds at the base value. With no end transform this returns `base`
 * itself, so non-animated items render exactly as before. Exported for
 * unit tests — pure math, no canvas involved.
 */
export function interpolateTransform(base: Transform, end: EndTransformSettings | undefined, progress: number): Transform {
  if (!end) return base;
  const raw = clamp01(progress);
  const p = end.eased ? raw * raw * (3 - 2 * raw) : raw;
  const lerp = (a: number, b: number) => a + (b - a) * p;
  return {
    position: { x: lerp(base.position.x, end.position.x), y: lerp(base.position.y, end.position.y) },
    scale: lerp(base.scale, end.scale),
    rotation: base.rotation,
    opacity: lerp(base.opacity, end.opacity),
  };
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

/**
 * COVER-fit source rect: the centered sub-rectangle of a (srcW × srcH)
 * source that fills a (destW × destH) box with no distortion — the
 * overflow dimension is cropped symmetrically. Used by drawVideoItem so a
 * clip whose aspect differs from its target rect (e.g. a 16:9 clip on a
 * 9:16 canvas) is cropped, never stretched/squashed.
 */
export function coverSourceRect(
  srcW: number,
  srcH: number,
  destW: number,
  destH: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const srcAspect = srcW / srcH;
  const destAspect = destW / destH;
  if (srcAspect > destAspect) {
    // Source is wider than the box: crop left/right.
    const sw = srcH * destAspect;
    return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH };
  }
  // Source is taller than (or equal to) the box: crop top/bottom.
  const sh = srcW / destAspect;
  return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh };
}

/**
 * Cover-fit INSIDE an item's crop window: the window (percentages of the
 * source's own dimensions, `CropSettings`) is the visible region; the
 * destination aspect is cover-fit within it. No crop (or a degenerate
 * one) = the plain cover-fit of the whole source. This is what makes
 * `item.crop` real — before this helper existed the field was written
 * by nothing and read by nothing.
 */
/** R24 — clamps a stored crop-zoom to its supported range; anything unusable (absent, non-finite, < 1) is exactly 1 = today's cover fit. */
export function resolveCropZoom(zoom: number | undefined): number {
  if (zoom === undefined || !Number.isFinite(zoom)) return 1;
  return Math.max(1, Math.min(3, zoom));
}

/** R24 — clamps a stored crop-pan offset to -1..1; absent/non-finite = 0 = centred (today's cover fit). */
export function resolveCropOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.max(-1, Math.min(1, offset));
}

/** True when a framing (R24 zoom/pan) actually changes the source rect — zoom 1 with centred pan is the pre-R24 cover fit, bit for bit. */
export function hasActiveFraming(framing?: FramingSettings): boolean {
  if (!framing) return false;
  return resolveCropZoom(framing.cropZoom) !== 1 || resolveCropOffset(framing.cropOffsetX) !== 0 || resolveCropOffset(framing.cropOffsetY) !== 0;
}

export function croppedCoverSourceRect(
  srcW: number,
  srcH: number,
  destW: number,
  destH: number,
  crop?: { x: number; y: number; width: number; height: number },
  framing?: FramingSettings,
): { sx: number; sy: number; sw: number; sh: number } {
  // The base WINDOW the framing lives inside: the item's crop rect when
  // one is set (and non-degenerate), else the whole source.
  let wx = 0;
  let wy = 0;
  let ww = srcW;
  let wh = srcH;
  if (crop) {
    const cx = (crop.x / 100) * srcW;
    const cy = (crop.y / 100) * srcH;
    const cw = (crop.width / 100) * srcW;
    const ch = (crop.height / 100) * srcH;
    if (cw > 0 && ch > 0) {
      wx = cx;
      wy = cy;
      ww = cw;
      wh = ch;
    }
  }
  const inner = coverSourceRect(ww, wh, destW, destH);
  const base = { sx: wx + inner.sx, sy: wy + inner.sy, sw: inner.sw, sh: inner.sh };
  // Fast path: no R24 framing (or framing at its identity values) returns
  // the base rect untouched — rendering is identical to before R24.
  if (!hasActiveFraming(framing)) return base;
  // Zoom: shrink the cover window by 1/zoom (aspect preserved — the
  // cover rect already carries the destination aspect). Pan: the offset
  // (-1..1) positions the zoomed window across its feasible range inside
  // the base window, so the SAME stored offset keeps the same edge
  // pinned at every zoom ("zoom around the current pan position"), and
  // at zoom 1 it pans across exactly the cover-fit slack.
  const zoom = resolveCropZoom(framing?.cropZoom);
  const zw = base.sw / zoom;
  const zh = base.sh / zoom;
  const rangeX = Math.max(0, ww - zw);
  const rangeY = Math.max(0, wh - zh);
  const fracX = (resolveCropOffset(framing?.cropOffsetX) + 1) / 2;
  const fracY = (resolveCropOffset(framing?.cropOffsetY) + 1) / 2;
  // Final clamp: the window never leaves the base window (and therefore
  // never leaves the source), whatever the stored values were.
  const sx = Math.max(wx, Math.min(wx + rangeX, wx + rangeX * fracX));
  const sy = Math.max(wy, Math.min(wy + rangeY, wy + rangeY * fracY));
  return { sx, sy, sw: zw, sh: zh };
}

/**
 * R24 — per-axis pan slack (source px) for a framing at `zoom`: how far
 * the crop window can still travel inside its base window on each axis.
 * The PiP panel enables its X/Y sliders exactly when the matching slack
 * is > 0 — i.e. whenever the source is cover-fitted with room to move,
 * at zoom 1 or deeper — never gated on trim/source-duration slack.
 */
export function framingSlackPx(
  srcW: number,
  srcH: number,
  destW: number,
  destH: number,
  crop?: { x: number; y: number; width: number; height: number },
  zoom?: number,
): { x: number; y: number } {
  let ww = srcW;
  let wh = srcH;
  if (crop) {
    const cw = (crop.width / 100) * srcW;
    const ch = (crop.height / 100) * srcH;
    if (cw > 0 && ch > 0) {
      ww = cw;
      wh = ch;
    }
  }
  const cover = coverSourceRect(ww, wh, destW, destH);
  const z = resolveCropZoom(zoom);
  return { x: Math.max(0, ww - cover.sw / z), y: Math.max(0, wh - cover.sh / z) };
}

/**
 * R24 — the on-canvas box (px) of a PiP video item. Legacy framing
 * ('cover'/absent, and ALWAYS for the circle shape): the box follows the
 * canvas aspect, `canvas × scale` per axis. 'source' fit (camera PiP
 * default): the box's height follows the SOURCE aspect at the same
 * width, so the whole frame is visible at zoom 1. Falls back to the
 * legacy box while the source has no decoded dimensions yet — the next
 * frame corrects it, same philosophy as drawVideoItem's draw fallback.
 */
export function pipBoxPx(
  scale: number,
  canvasWidth: number,
  canvasHeight: number,
  pip: { shape: string; fit?: 'cover' | 'source' } | undefined,
  srcW: number,
  srcH: number,
): { w: number; h: number } {
  const w = canvasWidth * scale;
  let h = canvasHeight * scale;
  if (pip?.fit === 'source' && pip.shape !== 'circle' && srcW > 0 && srcH > 0) {
    h = (w * srcH) / srcW;
  }
  return { w, h };
}

/** The PiP finish fields the compositor consumes (mirrors PipSettings). */
export interface PipDrawSettings {
  shape: string;
  borderWidth: number;
  borderColor: string;
  /** R25: stroke the border with the two-stop gold gradient ring. */
  ringGradient?: boolean;
  shadow: boolean;
  /** R25: soft coloured glow under the media, from the same shape path. */
  glow?: boolean;
  glowColor?: string;
  isPip: boolean;
  fit?: 'cover' | 'source';
}

/**
 * R25 — clip the context to a PiP shape's outline (box w × h, centred on
 * the origin). The outline comes from the ONE registry tracer in
 * `lib/pip.ts`, so the clip, the border and the glow can never disagree
 * about a shape's geometry. Exported for the geometry tests.
 */
export function clipPipShape(
  c: CanvasRenderingContext2D,
  shape: string,
  w: number,
  h: number,
): void {
  c.beginPath();
  tracePipShapePath(c, shape, w, h);
  c.clip();
}

/**
 * R25 — stroke a PiP shape's outline as its border. Flat `borderColor`,
 * or the two-stop gold gradient ring when `ringGradient` is set. Traces
 * the same registry path as `clipPipShape` — the ring sits exactly on
 * the clipped edge. Exported for the geometry tests.
 */
export function strokePipBorder(
  c: CanvasRenderingContext2D,
  pip: { shape: string; borderWidth: number; borderColor: string; ringGradient?: boolean },
  w: number,
  h: number,
): void {
  c.save();
  c.lineWidth = pip.borderWidth;
  if (pip.ringGradient) {
    const grad = c.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
    grad.addColorStop(0, PIP_GOLD_RING_STOPS[0]);
    grad.addColorStop(1, PIP_GOLD_RING_STOPS[1]);
    c.strokeStyle = grad;
  } else {
    c.strokeStyle = pip.borderColor;
  }
  c.beginPath();
  tracePipShapePath(c, pip.shape, w, h);
  c.stroke();
  c.restore();
}

/**
 * R25 — paint the soft glow: the shape path filled with the glow colour
 * while a same-colour shadow bleeds outward. Drawn BEFORE the media (the
 * media covers the fill; only the bled shadow shows, hugging the shape).
 * Exported for the geometry tests.
 */
export function paintPipGlow(
  c: CanvasRenderingContext2D,
  pip: { shape: string; glowColor?: string },
  w: number,
  h: number,
): void {
  const color = pip.glowColor ?? '#FFD100';
  c.save();
  c.shadowColor = color;
  c.shadowBlur = 26;
  c.shadowOffsetX = 0;
  c.shadowOffsetY = 0;
  c.fillStyle = color;
  c.beginPath();
  tracePipShapePath(c, pip.shape, w, h);
  c.fill();
  c.restore();
}

function drawVideoItem(
  ctx: CanvasRenderingContext2D,
  item: { position: Transform['position']; scale: number; rotation: number; opacity: number; startTime: number; endTime: number; fade?: { fadeInDuration: number; fadeOutDuration: number }; animation?: { entrance?: AnimationPreset; exit?: AnimationPreset }; motion?: MotionSettings; endTransform?: EndTransformSettings; colorGrade?: ColorGradeSettings; crop?: CropSettings; flipX?: boolean; cropZoom?: number; cropOffsetX?: number; cropOffsetY?: number; pip?: PipDrawSettings },
  videoEl: HTMLVideoElement,
  canvasWidth: number,
  canvasHeight: number,
  timeSeconds: number,
) {
  // Keyframe-lite (Phase 2.3): the frame's effective transform — base
  // transform unless an end transform interpolates it across the item.
  const effective = interpolateTransform(item, item.endTransform, (timeSeconds - item.startTime) / Math.max(0.001, item.endTime - item.startTime));
  const centerX = (effective.position.x / 100) * canvasWidth;
  const centerY = (effective.position.y / 100) * canvasHeight;
  // R24: a source-fit PiP's box height follows the source aspect (see
  // pipBoxPx); every other video keeps the canvas-aspect box.
  const box = item.pip?.isPip
    ? pipBoxPx(effective.scale, canvasWidth, canvasHeight, item.pip, videoEl.videoWidth, videoEl.videoHeight)
    : { w: canvasWidth * effective.scale, h: canvasHeight * effective.scale };
  const w = box.w;
  const h = box.h;
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
      if (pip?.glow) paintPipGlow(c, pip, w, h);
      if (pip) {
        c.save();
        if (pip.shadow) { c.shadowColor = 'rgba(0,0,0,0.45)'; c.shadowBlur = 18; c.shadowOffsetY = 6; }
        // R25: the clip outline comes from the shape registry — for the
        // original three shapes the traced regions are identical to the
        // hand-coded branches they replace (arc / roundRect radius /
        // rect); the six new shapes trace their own outlines here.
        clipPipShape(c, pip.shape, w, h);
      }
      try {
        // COVER fit: crop the source to the target rect's aspect (see
        // coverSourceRect) instead of stretching the full frame into the
        // rect, which visibly distorted any clip whose aspect differed
        // from its box. Falls back to the plain full-frame draw while the
        // element has no decoded dimensions yet (videoWidth/Height 0).
        const srcW = videoEl.videoWidth;
        const srcH = videoEl.videoHeight;
        // R24 Flip: mirror ONLY the media (inside the PiP clip, under the
        // un-flipped border/overlays) via a -1 x-scale around the item's
        // centre — the destination rect is symmetric, so scale(-1, 1)
        // mirrors it in place.
        const flip = item.flipX === true;
        if (flip) {
          c.save();
          c.scale(-1, 1);
        }
        if (pip?.shape === 'circle') {
          // Cover-fit inside the circle: draw so the circle is fully filled (no letterbox).
          const r = Math.min(w, h) / 2;
          const size = r * 2;
          if (srcW > 0 && srcH > 0) {
            const s = croppedCoverSourceRect(srcW, srcH, size, size, item.crop, item);
            c.drawImage(videoEl, s.sx, s.sy, s.sw, s.sh, -size / 2, -size / 2, size, size);
          } else {
            c.drawImage(videoEl, -size / 2, -size / 2, size, size);
          }
        } else if (srcW > 0 && srcH > 0) {
          const s = croppedCoverSourceRect(srcW, srcH, w, h, item.crop, item);
          c.drawImage(videoEl, s.sx, s.sy, s.sw, s.sh, -w / 2, -h / 2, w, h);
        } else {
          c.drawImage(videoEl, -w / 2, -h / 2, w, h);
        }
        if (flip) c.restore();
      } catch {
        // Video not yet seekable/decoded to this frame — skip this frame rather than throw.
      }
      if (pip) {
        c.restore();
        // Border drawn after restore (outside clip) so it is not clipped
        // away — stroked along the same registry path as the clip (flat
        // colour, or the R25 gold gradient ring).
        if (pip.borderWidth > 0) {
          strokePipBorder(c, pip, w, h);
        }
      }
      drawAdjustmentOverlay(c, w / 2, h / 2, adjustment);
      drawMotionOverlay(c, w / 2, h / 2, adjustment);
    },
    effective,
    centerX,
    centerY,
    adjustment,
    { halfWidthPx: w / 2, halfHeightPx: h / 2, extraFilter: colorGradeToFilter(item.colorGrade) || undefined },
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
  // Keyframe-lite (Phase 2.3): same effective-transform treatment as video.
  const effective = interpolateTransform(item, item.endTransform, (timeSeconds - item.startTime) / Math.max(0.001, item.endTime - item.startTime));
  const centerX = (effective.position.x / 100) * canvasWidth;
  const centerY = (effective.position.y / 100) * canvasHeight;
  const baseWidth = canvasWidth * 0.25 * effective.scale;
  // Crop window (preset frame crops / reframe picker): when present,
  // only the window is drawn and the box follows the WINDOW's aspect.
  const crop = item.crop;
  const hasCrop = !!crop && crop.width > 0 && crop.height > 0 && img.naturalWidth > 0 && img.naturalHeight > 0;
  const aspect = hasCrop
    ? ((crop.height / 100) * img.naturalHeight) / ((crop.width / 100) * img.naturalWidth)
    : img.naturalHeight > 0 && img.naturalWidth > 0
      ? img.naturalHeight / img.naturalWidth
      : 1;
  const w = baseWidth;
  const h = baseWidth * aspect;
  const transitionAdjustment = animationFor(item, timeSeconds, canvasWidth, canvasHeight);
  const motionAdjustment = computeMotionAdjustment(item.motion, timeSeconds - item.startTime, item.endTime - item.startTime, canvasWidth, canvasHeight);
  const adjustment = combineAdjustments(transitionAdjustment, motionAdjustment);
  // R24 framing (zoom/pan): when active, the drawn source rect comes
  // from the same cover/zoom/pan math the video path uses, cover-fitting
  // inside the item's crop window (or the whole image) at the box's
  // aspect — at the box aspect the zoom-1 rect is exactly the window
  // above, so activating framing never jumps the framing at zoom 1.
  const framingActive = hasActiveFraming(item) && img.naturalWidth > 0 && img.naturalHeight > 0;
  applyTransformedDraw(
    ctx,
    (c) => {
      try {
        // R24 Flip: mirror only the media, in place (see drawVideoItem).
        const flip = item.flipX === true;
        if (flip) {
          c.save();
          c.scale(-1, 1);
        }
        if (framingActive) {
          const s = croppedCoverSourceRect(img.naturalWidth, img.naturalHeight, w, h, hasCrop ? crop : undefined, item);
          c.drawImage(img, s.sx, s.sy, s.sw, s.sh, -w / 2, -h / 2, w, h);
        } else if (hasCrop) {
          c.drawImage(
            img,
            (crop.x / 100) * img.naturalWidth,
            (crop.y / 100) * img.naturalHeight,
            (crop.width / 100) * img.naturalWidth,
            (crop.height / 100) * img.naturalHeight,
            -w / 2,
            -h / 2,
            w,
            h,
          );
        } else {
          c.drawImage(img, -w / 2, -h / 2, w, h);
        }
        if (flip) c.restore();
      } catch {
        // Defense in depth only — the isImageReady() gate in drawFrame is
        // the real guard against a broken image. Mirrors drawVideoItem's
        // existing try/catch so a race between the check and the draw call
        // can never crash the render/animation loop.
      }
      drawAdjustmentOverlay(c, w / 2, h / 2, adjustment);
      drawMotionOverlay(c, w / 2, h / 2, adjustment);
    },
    effective,
    centerX,
    centerY,
    adjustment,
    { halfWidthPx: w / 2, halfHeightPx: h / 2, extraFilter: colorGradeToFilter(item.colorGrade) || undefined },
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

function drawTextItem(ctx: CanvasRenderingContext2D, item: TextTimelineItem, canvasWidth: number, canvasHeight: number, timeSeconds: number, claimed?: TextBox[]) {
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
  // R22 occupancy guard: measure the real glyph box and claim it
  // against the frame's shared text map. A colliding text item is
  // shifted clear; one that cannot be placed is not drawn this
  // frame (entrances settle, and the next frame re-claims).
  let drawAdjustment = adjustment;
  if (claimed) {
    ctx.save();
    ctx.font = `${effectiveFontSize}px ${canvasFontStack(item.font)}`;
    const measuredWidth = ctx.measureText(displayText || ' ').width * Math.max(0.1, adjustment.scaleMul);
    ctx.restore();
    const box: TextBox = {
      x: centerX + adjustment.offsetXPx - measuredWidth / 2,
      y: centerY + adjustment.offsetYPx - effectiveFontSize * 0.59,
      w: measuredWidth,
      h: effectiveFontSize * 1.18,
    };
    const res = claimTextBox(claimed, box, canvasWidth, canvasHeight);
    if (!res.box) return;
    if (res.shiftedByPx !== 0) {
      drawAdjustment = { ...adjustment, offsetYPx: adjustment.offsetYPx + res.shiftedByPx };
    }
  }
  applyTransformedDraw(
    ctx,
    (c) => {
      c.font = `${effectiveFontSize}px ${canvasFontStack(item.font)}`;
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
    drawAdjustment,
    // Estimated text box (drawTextItem has no fixed draw box — see the
    // overlay note above) so a mask-reveal on a text item clips around
    // roughly the glyphs instead of skipping the mask entirely.
    { halfWidthPx: (displayText || ' ').length * effectiveFontSize * 0.32 + effectiveFontSize * 0.3, halfHeightPx: effectiveFontSize * 0.7 },
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
  item: { position: Transform['position']; scale: number; pip?: { shape: string; fit?: 'cover' | 'source'; isPip: boolean } },
  itemType: 'video' | 'image' | 'text',
  canvasWidth: number,
  canvasHeight: number,
  opts: { naturalImageAspect?: number; textWidthPx?: number; textHeightPx?: number; naturalVideoAspect?: number } = {},
): ItemBoundsPercent {
  let widthPx: number;
  let heightPx: number;
  if (itemType === 'video') {
    // Mirrors drawVideoItem: fills the canvas at scale 1. R24: a
    // source-fit PiP's box height follows the source aspect instead —
    // via pipBoxPx, the same helper drawVideoItem uses, whenever the
    // caller can supply the source's aspect.
    if (item.pip?.isPip && opts.naturalVideoAspect && opts.naturalVideoAspect > 0) {
      const box = pipBoxPx(item.scale, canvasWidth, canvasHeight, item.pip, opts.naturalVideoAspect, 1);
      widthPx = box.w;
      heightPx = box.h;
    } else {
      widthPx = canvasWidth * item.scale;
      heightPx = canvasHeight * item.scale;
    }
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
const CAPTION_SAFE_AREA_TOP_FRACTION = 0.13;
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
  claimed?: TextBox[],
) {
  const style = getCaptionStyle(item.captionStyleId);
  const centerX = canvasWidth / 2;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const activeIndex = item.words.findIndex((w) => relativeTime >= w.start && relativeTime < w.end);
  const words = item.words.map((w) => (style.uppercase ? w.text.toUpperCase() : w.text));
  const maxLineWidth = canvasWidth * CAPTION_MAX_LINE_WIDTH_FRACTION;

  // R19 size system: the style's authored size scales with the
  // canvas (1080 reference) and the item's size tier — then the FIT
  // GUARANTEE shrinks the cue (never below 62% of nominal) until
  // its widest word fits the frame and it wraps to at most 3 lines.
  // Big and always fitting, enforced by the renderer.
  const nominalPx = resolveCaptionFontPx(style, canvasWidth, item.sizeScale);
  let fontPx = nominalPx;
  let lines: CaptionLine[] = [{ words: [], widths: [], totalWidth: 0, startIndex: 0 }];
  for (const factor of [1, 0.93, 0.86, 0.79, 0.72, 0.66, 0.62]) {
    fontPx = nominalPx * factor;
    ctx.font = `${style.fontWeight ?? 700} ${fontPx}px ${style.fontFamily}`;
    const spaceWidth = ctx.measureText(' ').width;
    lines = wrapCaptionWords(ctx, words, spaceWidth, maxLineWidth);
    const widestWord = Math.max(0, ...lines.flatMap((l) => l.widths));
    // R22 zone discipline: a caption block may never grow past
    // ~36% of the frame height, whatever the size tier — a taller
    // block is what let big cues climb out of their anchor zone
    // into the next one (worst in square formats).
    const blockHeightPx = lines.length * fontPx * 1.28;
    if (widestWord <= maxLineWidth && lines.length <= 3 && blockHeightPx <= canvasHeight * 0.36) break;
  }
  const spaceWidth = ctx.measureText(' ').width;

  const lineHeight = fontPx * 1.28;
  // Anchor zones: bottom (default) pins the LAST line at the bottom
  // safe area and grows upward, clear of platform UI chrome; middle
  // centers the block; top pins the first line under the top safe
  // area.
  const anchor = item.anchorY ?? 'bottom';
  let lastLineCenterY =
    anchor === 'middle'
      ? canvasHeight * 0.5 + ((lines.length - 1) * lineHeight) / 2
      : anchor === 'top'
        ? canvasHeight * CAPTION_SAFE_AREA_TOP_FRACTION + (lines.length - 1) * lineHeight
        : canvasHeight * CAPTION_SAFE_AREA_BOTTOM_FRACTION;
  let firstLineCenterY = lastLineCenterY - (lines.length - 1) * lineHeight;

  // R22 occupancy guard: this cue claims its rendered block
  // against every text already drawn this frame (captions AND
  // recipe text items share one map). A cue that cannot be placed
  // without overlapping is shifted — or not drawn this frame.
  if (claimed) {
    const padX = fontPx * 0.34;
    const padY = fontPx * 0.2;
    const widest = Math.max(0, ...lines.map((l) => l.totalWidth));
    const top = firstLineCenterY - fontPx / 2 - padY;
    const height = (lines.length - 1) * lineHeight + fontPx + padY * 2;
    const res = claimTextBox(
      claimed,
      { x: centerX - widest / 2 - padX, y: top, w: widest + padX * 2, h: height },
      canvasWidth,
      canvasHeight,
    );
    if (!res.box) {
      ctx.restore();
      return;
    }
    if (res.shiftedByPx !== 0) {
      firstLineCenterY += res.shiftedByPx;
      lastLineCenterY += res.shiftedByPx;
    }
  }

  if (style.background) {
    const paddingX = fontPx * 0.34;
    const paddingY = fontPx * 0.2;
    const widestLine = Math.max(...lines.map((l) => l.totalWidth));
    const blockTop = firstLineCenterY - fontPx / 2 - paddingY;
    const blockHeight = lastLineCenterY + fontPx / 2 + paddingY - blockTop;
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
        ctx.lineWidth = style.strokeWidth * (fontPx / style.fontSize);
        ctx.strokeStyle = style.strokeColor;
        ctx.strokeText(word, 0, 0);
      }
      // Karaoke styles (Phase 2.3): a style with `highlightColor` fills
      // ONLY the active word in that color; words already spoken and words
      // still to come stay in the base `color` at near-full strength (they
      // are real caption text, not "upcoming" ghosts). Styles without a
      // highlight keep the original treatment: active word at full color,
      // the rest dimmed to 0.72 alpha.
      ctx.fillStyle = isActive
        ? (style.highlightColor ?? style.color)
        : style.highlightColor
          ? hexWithAlpha(style.color, 0.85)
          : hexWithAlpha(style.color, 0.72);
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
  // R22: one occupancy map for ALL text drawn this frame.
  const claimedTexts: TextBox[] = [];

  // R20 guarantee: at most ONE caption per anchor zone is drawn at
  // any instant — the newest cue in the zone wins (latest start,
  // then highest zIndex). Even a hand-edited project with stacked
  // caption windows can never render two cues on top of each other.
  const captionWinners = new Set<string>();
  {
    const byZone = new Map<string, (typeof activeItems)[number]>();
    for (const item of activeItems) {
      if (item.type !== 'caption') continue;
      const zone = (item as { anchorY?: string }).anchorY ?? 'bottom';
      const current = byZone.get(zone);
      if (
        !current ||
        item.startTime > current.startTime ||
        (item.startTime === current.startTime && item.zIndex >= current.zIndex)
      ) {
        byZone.set(zone, item);
      }
    }
    for (const winner of byZone.values()) captionWinners.add(winner.id);
  }

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
        drawTextItem(ctx, item, canvasWidth, canvasHeight, timeSeconds, claimedTexts);
        break;
      }
      case 'caption': {
        if (captionWinners.has(item.id)) {
          drawCaptionItem(ctx, item, timeSeconds - item.startTime, canvasWidth, canvasHeight, claimedTexts);
        }
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
