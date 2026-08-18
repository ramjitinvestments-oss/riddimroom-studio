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

import type { AnimationPreset, CaptionTimelineItem, ImageTimelineItem, Project, TextTimelineItem, Transform } from '../../types/timeline';
import { getItemsAtTime } from '../timeline/utils';
import { getCaptionStyle } from '../captions/styles';

export interface FrameAssets {
  /** Loaded <img> elements keyed by MediaAsset id, for `image` timeline items. */
  images: Map<string, HTMLImageElement>;
  /** The currently-playing <video> element and which mediaAssetId it corresponds to, if any video item is active. */
  activeVideo?: { assetId: string; element: HTMLVideoElement } | null;
}

// ---------------------------------------------------------------------------
// Entrance/exit animation + fade — the "premium transitions" engine
// ---------------------------------------------------------------------------

/** Default entrance/exit duration for an animated item, capped to half the item's own on-screen duration so a very short clip doesn't animate through its entire lifespan. */
const ANIMATION_DURATION_SECONDS = 0.45;

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

export interface AnimatedAdjustment {
  opacityMul: number;
  offsetXPx: number;
  offsetYPx: number;
  scaleMul: number;
  blurPx: number;
}

const IDENTITY_ADJUSTMENT: AnimatedAdjustment = { opacityMul: 1, offsetXPx: 0, offsetYPx: 0, scaleMul: 1, blurPx: 0 };

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
  const dur = Math.min(ANIMATION_DURATION_SECONDS, Math.max(0.05, itemDurationSeconds / 2));
  const inEnter = sinceStart < dur;
  const inExit = untilEnd < dur;
  if (!inEnter && !inExit) return { ...IDENTITY_ADJUSTMENT };

  const enterP = easeOutCubic(clamp01(sinceStart / dur));
  const exitP = easeOutCubic(clamp01(untilEnd / dur));
  const a: AnimatedAdjustment = { ...IDENTITY_ADJUSTMENT };

  const applyEnterExitOpacity = () => {
    if (inEnter) a.opacityMul = Math.min(a.opacityMul, enterP);
    if (inExit) a.opacityMul = Math.min(a.opacityMul, exitP);
  };

  switch (preset) {
    case 'fade':
      applyEnterExitOpacity();
      if (inEnter) a.blurPx = Math.max(a.blurPx, (1 - enterP) * 8);
      if (inExit) a.blurPx = Math.max(a.blurPx, (1 - exitP) * 8);
      break;
    case 'slide-up':
      applyEnterExitOpacity();
      if (inEnter) a.offsetYPx += (1 - enterP) * canvasHeight * 0.18;
      if (inExit) a.offsetYPx -= (1 - exitP) * canvasHeight * 0.18;
      break;
    case 'slide-down':
      applyEnterExitOpacity();
      if (inEnter) a.offsetYPx -= (1 - enterP) * canvasHeight * 0.18;
      if (inExit) a.offsetYPx += (1 - exitP) * canvasHeight * 0.18;
      break;
    case 'slide-left':
      applyEnterExitOpacity();
      if (inEnter) a.offsetXPx += (1 - enterP) * canvasWidth * 0.22;
      if (inExit) a.offsetXPx -= (1 - exitP) * canvasWidth * 0.22;
      break;
    case 'slide-right':
      applyEnterExitOpacity();
      if (inEnter) a.offsetXPx -= (1 - enterP) * canvasWidth * 0.22;
      if (inExit) a.offsetXPx += (1 - exitP) * canvasWidth * 0.22;
      break;
    case 'zoom':
      applyEnterExitOpacity();
      if (inEnter) { a.scaleMul *= 0.55 + 0.45 * enterP; a.blurPx = Math.max(a.blurPx, (1 - enterP) * 6); }
      if (inExit) a.scaleMul *= 1 + (1 - exitP) * 0.35;
      break;
    case 'pop':
      applyEnterExitOpacity();
      if (inEnter) a.scaleMul *= Math.max(0, easeOutBack(clamp01(sinceStart / dur)));
      if (inExit) a.scaleMul *= 0.6 + 0.4 * exitP;
      break;
    default:
      // Not yet given bespoke motion — a real (if simple) fade beats a
      // silent no-op for a preset the UI lets the user pick.
      applyEnterExitOpacity();
      break;
  }
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
  let opacity = 1;
  if (fade.fadeInDuration > 0 && sinceStart < fade.fadeInDuration) {
    opacity = Math.min(opacity, clamp01(sinceStart / fade.fadeInDuration));
  }
  if (fade.fadeOutDuration > 0 && untilEnd < fade.fadeOutDuration) {
    opacity = Math.min(opacity, clamp01(untilEnd / fade.fadeOutDuration));
  }
  return opacity;
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
  if (adjustment.blurPx > 0.05) ctx.filter = `blur(${adjustment.blurPx.toFixed(2)}px)`;
  ctx.translate(centerXPx + adjustment.offsetXPx, centerYPx + adjustment.offsetYPx);
  if (transform.rotation) ctx.rotate((transform.rotation * Math.PI) / 180);
  if (adjustment.scaleMul !== 1) ctx.scale(adjustment.scaleMul, adjustment.scaleMul);
  draw(ctx);
  ctx.restore();
}

/** Shared timing → adjustment helper for the three animatable item types (video/image/text). */
function animationFor(
  item: { startTime: number; endTime: number; fade?: { fadeInDuration: number; fadeOutDuration: number }; animation?: { entrance?: AnimationPreset; exit?: AnimationPreset } },
  timeSeconds: number,
  canvasWidth: number,
  canvasHeight: number,
): AnimatedAdjustment {
  const sinceStart = timeSeconds - item.startTime;
  const untilEnd = item.endTime - timeSeconds;
  const duration = item.endTime - item.startTime;
  const preset = sinceStart <= duration / 2 ? item.animation?.entrance : item.animation?.exit;
  const a = computeEntranceExit(preset, sinceStart, untilEnd, duration, canvasWidth, canvasHeight);
  a.opacityMul *= computeFadeOpacity(item.fade, sinceStart, untilEnd);
  return a;
}

function drawVideoItem(
  ctx: CanvasRenderingContext2D,
  item: { position: Transform['position']; scale: number; rotation: number; opacity: number; startTime: number; endTime: number; fade?: { fadeInDuration: number; fadeOutDuration: number }; animation?: { entrance?: AnimationPreset; exit?: AnimationPreset } },
  videoEl: HTMLVideoElement,
  canvasWidth: number,
  canvasHeight: number,
  timeSeconds: number,
) {
  const centerX = (item.position.x / 100) * canvasWidth;
  const centerY = (item.position.y / 100) * canvasHeight;
  const w = canvasWidth * item.scale;
  const h = canvasHeight * item.scale;
  const adjustment = animationFor(item, timeSeconds, canvasWidth, canvasHeight);
  applyTransformedDraw(
    ctx,
    (c) => {
      try {
        c.drawImage(videoEl, -w / 2, -h / 2, w, h);
      } catch {
        // Video not yet seekable/decoded to this frame — skip this frame rather than throw.
      }
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
  const adjustment = animationFor(item, timeSeconds, canvasWidth, canvasHeight);
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
        if (assets.activeVideo && assets.activeVideo.assetId === item.mediaAssetId) {
          drawVideoItem(ctx, item, assets.activeVideo.element, canvasWidth, canvasHeight, timeSeconds);
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
}
