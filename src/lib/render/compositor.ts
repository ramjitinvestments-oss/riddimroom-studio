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
 */

import type { CaptionTimelineItem, ImageTimelineItem, Project, TextTimelineItem, Transform } from '../../types/timeline';
import { getItemsAtTime } from '../timeline/utils';
import { getCaptionStyle } from '../captions/styles';

export interface FrameAssets {
  /** Loaded <img> elements keyed by MediaAsset id, for `image` timeline items. */
  images: Map<string, HTMLImageElement>;
  /** The currently-playing <video> element and which mediaAssetId it corresponds to, if any video item is active. */
  activeVideo?: { assetId: string; element: HTMLVideoElement } | null;
}

function applyTransformedDraw(
  ctx: CanvasRenderingContext2D,
  draw: (ctx: CanvasRenderingContext2D) => void,
  transform: Transform,
  centerXPx: number,
  centerYPx: number,
) {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, transform.opacity));
  ctx.translate(centerXPx, centerYPx);
  if (transform.rotation) ctx.rotate((transform.rotation * Math.PI) / 180);
  draw(ctx);
  ctx.restore();
}

function drawVideoItem(
  ctx: CanvasRenderingContext2D,
  item: { position: Transform['position']; scale: number; rotation: number; opacity: number },
  videoEl: HTMLVideoElement,
  canvasWidth: number,
  canvasHeight: number,
) {
  const centerX = (item.position.x / 100) * canvasWidth;
  const centerY = (item.position.y / 100) * canvasHeight;
  const w = canvasWidth * item.scale;
  const h = canvasHeight * item.scale;
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
) {
  const centerX = (item.position.x / 100) * canvasWidth;
  const centerY = (item.position.y / 100) * canvasHeight;
  const baseWidth = canvasWidth * 0.25 * item.scale;
  const aspect = img.naturalHeight > 0 && img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : 1;
  const w = baseWidth;
  const h = baseWidth * aspect;
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
  );
}

function drawTextItem(ctx: CanvasRenderingContext2D, item: TextTimelineItem, canvasWidth: number, canvasHeight: number) {
  const centerX = (item.position.x / 100) * canvasWidth;
  const centerY = (item.position.y / 100) * canvasHeight;
  applyTransformedDraw(
    ctx,
    (c) => {
      c.font = `${item.fontSize}px Arial, Helvetica, sans-serif`;
      c.fillStyle = item.color;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(item.text, 0, 0);
    },
    item,
    centerX,
    centerY,
  );
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
  const centerY = canvasHeight * 0.82;

  ctx.save();
  ctx.font = `bold ${style.fontSize}px ${style.fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const activeIndex = item.words.findIndex((w) => relativeTime >= w.start && relativeTime < w.end);
  const words = item.words.map((w) => (style.uppercase ? w.text.toUpperCase() : w.text));
  const widths = words.map((w) => ctx.measureText(w).width);
  const spaceWidth = ctx.measureText(' ').width;
  const totalWidth = widths.reduce((sum, w) => sum + w, 0) + spaceWidth * Math.max(0, words.length - 1);

  if (style.background) {
    const paddingX = 24;
    const paddingY = 14;
    ctx.fillStyle = style.background;
    ctx.fillRect(centerX - totalWidth / 2 - paddingX, centerY - style.fontSize / 2 - paddingY, totalWidth + paddingX * 2, style.fontSize + paddingY * 2);
  }

  let cursorX = centerX - totalWidth / 2;
  words.forEach((word, index) => {
    const isActive = index === activeIndex;
    const x = cursorX + widths[index] / 2;
    if (style.strokeColor && style.strokeColor !== 'transparent' && style.strokeWidth > 0) {
      ctx.lineWidth = style.strokeWidth;
      ctx.strokeStyle = style.strokeColor;
      ctx.strokeText(word, x, centerY);
    }
    ctx.fillStyle = isActive ? style.color : hexWithAlpha(style.color, 0.72);
    ctx.fillText(word, x, centerY);
    cursorX += widths[index] + spaceWidth;
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
          drawVideoItem(ctx, item, assets.activeVideo.element, canvasWidth, canvasHeight);
        }
        break;
      }
      case 'image': {
        const img = assets.images.get(item.mediaAssetId);
        // isImageReady guards against drawing a broken image (failed
        // fetch/CORS-rejected/still-loading) — see its doc comment above.
        // This is a render-loop safety net, not a fix for *why* an image
        // might fail to load (e.g. missing Storage CORS config).
        if (img && isImageReady(img)) drawImageItem(ctx, item, img, canvasWidth, canvasHeight);
        break;
      }
      case 'text': {
        drawTextItem(ctx, item, canvasWidth, canvasHeight);
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
