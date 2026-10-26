/**
 * R23 — Headline Poster Builder (WS1).
 *
 * Builds a still-first poster project: the user's photo, true-cover
 * cropped to the canvas, a gradient scrim band behind the words, and
 * a headline + sub stacked in the calmer end of the frame (bottom by
 * default, top when the top third is calmer). Every line is wrapped
 * and shrunk against a measurer before it is placed, and the stack
 * is laid out on the same box model the build-time audit uses
 * (`estimateTextBox`: height = fontPx * 1.18, centred on position),
 * so a built poster audits clean by construction.
 *
 * `buildPosterProject` is pure (no DOM): text measurement is injected
 * and defaults to the estimator, which agrees exactly with
 * `estimateTextBox` (width = len * fontPx * 0.64). The canvas-backed
 * measurer, the scrim file factory and the still renderer are the
 * only browser-only pieces.
 */

import type { ImageTimelineItem, MediaAsset, Project } from '../../types/timeline';
import { addItem, addMediaAsset, generateTimelineId, getProjectDuration, getTracksByType } from '../timeline/utils';
import { addTextItem } from '../timeline/insert';
import { canvasFontStack, DEFAULT_PROMO_FONT } from '../fonts';
import { drawFrame, type FrameAssets } from '../render/compositor';
import type { ArtworkAnalysis } from './analyze';

export type { FrameAssets };

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

export type PosterFormatId = '9:16' | '4:5' | '1:1';

export interface PosterFormat {
  id: PosterFormatId;
  label: string;
  canvasWidth: number;
  canvasHeight: number;
}

export const POSTER_FORMATS: Record<PosterFormatId, PosterFormat> = {
  '9:16': { id: '9:16', label: '9:16 — Vertical', canvasWidth: 1080, canvasHeight: 1920 },
  '4:5': { id: '4:5', label: '4:5 — Portrait', canvasWidth: 1080, canvasHeight: 1350 },
  '1:1': { id: '1:1', label: '1:1 — Square', canvasWidth: 1080, canvasHeight: 1080 },
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** 'B' = text block anchored to the bottom, 'T' = anchored to the top. */
export type PosterLayout = 'B' | 'T';
export type PosterLayoutChoice = 'auto' | PosterLayout;

export interface PosterTexts2 {
  headline: string;
  sub?: string;
  headlineFont?: string;
}

export interface PosterBuildOptions {
  layout: PosterLayout;
  durationSeconds?: number;
}

/** Returns the rendered width (px) of `text` at `fontPx` in `fontFamily`. */
export type TextMeasurer = (text: string, fontPx: number, fontFamily: string) => number;

// ---------------------------------------------------------------------------
// Measurers
// ---------------------------------------------------------------------------

/**
 * The estimator measurer: MUST agree with `estimateTextBox` in
 * lib/render/textGuard.ts (width = len * fontPx * 0.64), so a line
 * that fits under this measurer also fits the audit's box.
 */
export const estimatorMeasurer: TextMeasurer = (text, fontPx) => text.length * fontPx * 0.64;

/**
 * First (primary) weight per family — mirrors the WEIGHTS map in
 * lib/fonts.ts (which is not exported). Multi-weight entries there
 * are `;`-separated lists for the Google Fonts stylesheet; a canvas
 * font string takes a single weight, so the first entry is used.
 */
const CANVAS_FONT_WEIGHTS: Record<string, string> = {
  Anton: '400',
  'Bebas Neue': '400',
  'Archivo Black': '400',
  Bungee: '400',
  'Luckiest Guy': '400',
  Montserrat: '700',
  Oswald: '500',
  'Playfair Display': '700',
  Cinzel: '600',
  Poppins: '600',
  'Titan One': '400',
  'Alfa Slab One': '400',
};

/** Browser measurer: a shared canvas context's real `measureText`. */
export function createCanvasMeasurer(): TextMeasurer {
  let ctx: CanvasRenderingContext2D | null = null;
  return (text, fontPx, fontFamily) => {
    if (typeof document === 'undefined') return estimatorMeasurer(text, fontPx, fontFamily);
    if (!ctx) {
      const canvas = document.createElement('canvas');
      ctx = canvas.getContext('2d');
      if (!ctx) return estimatorMeasurer(text, fontPx, fontFamily);
    }
    const weight = CANVAS_FONT_WEIGHTS[fontFamily] ?? '400';
    ctx.font = `${weight} ${fontPx}px ${canvasFontStack(fontFamily)}`;
    return ctx.measureText(text).width;
  };
}

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

function greedyWrap(
  words: string[],
  maxWidthPx: number,
  fontPx: number,
  fontFamily: string,
  measurer: TextMeasurer,
): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || measurer(candidate, fontPx, fontFamily) <= maxWidthPx) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function truncateToFit(line: string, maxWidthPx: number, fontPx: number, fontFamily: string, measurer: TextMeasurer): string {
  if (measurer(line, fontPx, fontFamily) <= maxWidthPx) return line;
  let core = line.replace(/…+$/, '').trimEnd();
  while (core.length > 0 && measurer(`${core}…`, fontPx, fontFamily) > maxWidthPx) {
    core = core.slice(0, -1).trimEnd();
  }
  return core ? `${core}…` : '…';
}

/**
 * Greedy word-wrap into at most `maxLines` lines at `startFontPx`;
 * on overflow the font steps down (×0.92) until it fits or reaches
 * `minFontPx`. At the floor the text wraps anyway: lines beyond
 * `maxLines` fold into a truncated last line, and any line (notably
 * a single over-wide word) that still exceeds `maxWidthPx` is
 * truncated with '…'.
 */
export function wrapPosterText(
  text: string,
  opts: {
    maxWidthPx: number;
    startFontPx: number;
    minFontPx: number;
    fontFamily: string;
    measurer: TextMeasurer;
    maxLines: number;
  },
): { lines: string[]; fontPx: number } {
  const { maxWidthPx, fontFamily, measurer } = opts;
  const maxLines = Math.max(1, opts.maxLines);
  const minFontPx = Math.min(opts.minFontPx, opts.startFontPx);
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return { lines: [], fontPx: opts.startFontPx };
  const words = cleaned.split(' ');

  const fits = (lines: string[], fontPx: number): boolean =>
    lines.length <= maxLines && lines.every((l) => measurer(l, fontPx, fontFamily) <= maxWidthPx + 1e-6);

  let fontPx = opts.startFontPx;
  for (;;) {
    const lines = greedyWrap(words, maxWidthPx, fontPx, fontFamily, measurer);
    if (fits(lines, fontPx)) return { lines, fontPx };
    if (fontPx <= minFontPx + 1e-9) break;
    fontPx = Math.max(minFontPx, fontPx * 0.92);
  }

  // At the floor: wrap anyway, fold overflow into the last line,
  // and truncate anything still too wide with '…'.
  let lines = greedyWrap(words, maxWidthPx, minFontPx, fontFamily, measurer);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const rest = lines.slice(maxLines).join(' ');
    kept[maxLines - 1] = truncateToFit(
      `${kept[maxLines - 1]} ${rest}`.trim(),
      maxWidthPx,
      minFontPx,
      fontFamily,
      measurer,
    );
    // truncateToFit only adds '…' when the folded line is too wide;
    // a folded line that happens to fit still needs to signal the cut.
    if (!kept[maxLines - 1].endsWith('…') && measurer(kept[maxLines - 1], minFontPx, fontFamily) < maxWidthPx) {
      const withMark = `${kept[maxLines - 1]}…`;
      if (measurer(withMark, minFontPx, fontFamily) <= maxWidthPx) kept[maxLines - 1] = withMark;
    }
    lines = kept;
  }
  lines = lines.map((l) => truncateToFit(l, maxWidthPx, minFontPx, fontFamily, measurer));
  return { lines, fontPx: minFontPx };
}

// ---------------------------------------------------------------------------
// Layout choice — busyness of the top / bottom thirds
// ---------------------------------------------------------------------------

/**
 * Busyness of the top and bottom thirds: for each third, the
 * fraction of that third's height covered by the analysis' content
 * bands (each band clipped to the third). 0 = empty, 1 = full.
 */
export function thirdBusyness(analysis: ArtworkAnalysis): { top: number; bottom: number } {
  const coverage = (thirdStart: number, thirdEnd: number): number => {
    let covered = 0;
    for (const band of analysis.bands) {
      covered += Math.max(0, Math.min(band.y1, thirdEnd) - Math.max(band.y0, thirdStart));
    }
    const fraction = covered / (thirdEnd - thirdStart);
    return Math.max(0, Math.min(1, fraction));
  };
  return { top: coverage(0, 1 / 3), bottom: coverage(2 / 3, 1) };
}

/**
 * The text goes in the calmer third: lower coverage wins, ties go
 * to 'B' (the classic poster bottom), and when both thirds are
 * busy (>= 0.85 covered) the answer is still 'B' — the scrim band
 * guarantees the contrast either way.
 */
export function pickPosterLayout(analysis: ArtworkAnalysis): PosterLayout {
  const { top, bottom } = thirdBusyness(analysis);
  if (top >= 0.85 && bottom >= 0.85) return 'B';
  if (top < bottom) return 'T';
  return 'B';
}

// ---------------------------------------------------------------------------
// Project building (pure)
// ---------------------------------------------------------------------------

function nextZIndex(project: Project): number {
  return project.items.reduce((max, item) => Math.max(max, item.zIndex), -1) + 1;
}

function imageTrackId(project: Project): string {
  const tracks = getTracksByType(project, 'image');
  if (tracks.length === 0) throw new Error('Project has no image track.');
  return tracks[0].id;
}

function assetDims(asset: MediaAsset): { w: number; h: number } {
  return {
    w: asset.width && asset.width > 0 ? asset.width : 1000,
    h: asset.height && asset.height > 0 ? asset.height : 1000,
  };
}

interface PosterLine {
  text: string;
  fontPx: number;
  fontFamily: string;
  color: string;
  role: 'title' | 'overlay';
  /** True for the first sub line — the headline/sub gap lands above it. */
  startsSubBlock: boolean;
}

export function buildPosterProject(
  project: Project,
  photo: MediaAsset,
  scrim: MediaAsset | null,
  texts: PosterTexts2,
  opts: PosterBuildOptions,
  measurer: TextMeasurer = estimatorMeasurer,
): Project {
  const W = project.canvasWidth;
  const H = project.canvasHeight;
  const s = W / 1080;
  const margin = 75 * s;
  const maxWidthPx = W - 2 * margin;
  const duration =
    opts.durationSeconds ?? (getProjectDuration(project) > 0 ? getProjectDuration(project) : 5);

  const trackId = imageTrackId(project);
  let next = addMediaAsset(project, photo);
  if (scrim) next = addMediaAsset(next, scrim);

  // --- Photo: true cover via a centred crop window at canvas aspect.
  const { w: srcW, h: srcH } = assetDims(photo);
  const srcAspect = srcW / srcH;
  const canvasAspect = W / H;
  let crop: ImageTimelineItem['crop'];
  if (srcAspect > canvasAspect) {
    const widthPct = (canvasAspect / srcAspect) * 100;
    crop = { x: (100 - widthPct) / 2, y: 0, width: widthPct, height: 100 };
  } else if (srcAspect < canvasAspect) {
    const heightPct = (srcAspect / canvasAspect) * 100;
    crop = { x: 0, y: (100 - heightPct) / 2, width: 100, height: heightPct };
  } else {
    crop = { x: 0, y: 0, width: 100, height: 100 };
  }
  const photoItem: ImageTimelineItem = {
    id: generateTimelineId('item'),
    type: 'image',
    trackId,
    visible: true,
    mediaAssetId: photo.id,
    role: 'photo',
    position: { x: 50, y: 50 },
    // Rendered width = canvasWidth * 0.25 * scale = canvasWidth.
    scale: W / (W * 0.25),
    rotation: 0,
    opacity: 1,
    crop,
    startTime: 0,
    endTime: duration,
    zIndex: nextZIndex(next),
  };
  next = addItem(next, photoItem);

  // --- Scrim: full-width band hugging the text end of the canvas.
  if (scrim) {
    const { w: scrimW, h: scrimH } = assetDims(scrim);
    const heightPx = W * (scrimH / scrimW);
    const centerYPx = opts.layout === 'B' ? H - heightPx / 2 : heightPx / 2;
    const scrimItem: ImageTimelineItem = {
      id: generateTimelineId('item'),
      type: 'image',
      trackId,
      visible: true,
      mediaAssetId: scrim.id,
      role: 'graphic',
      position: { x: 50, y: (centerYPx / H) * 100 },
      scale: W / (W * 0.25),
      rotation: 0,
      opacity: 1,
      startTime: 0,
      endTime: duration,
      zIndex: nextZIndex(next),
    };
    next = addItem(next, scrimItem);
  }

  // --- Texts: wrap/shrink first, then stack on the audit box model.
  const headlineFont = texts.headlineFont ?? DEFAULT_PROMO_FONT;
  const headline = wrapPosterText(texts.headline.toUpperCase(), {
    maxWidthPx,
    startFontPx: 110 * s,
    minFontPx: 40 * s,
    fontFamily: headlineFont,
    measurer,
    maxLines: 2,
  });
  const subText = (texts.sub ?? '').trim();
  const sub = subText
    ? wrapPosterText(subText, {
        maxWidthPx,
        startFontPx: 43 * s,
        minFontPx: 24 * s,
        fontFamily: 'Montserrat',
        measurer,
        maxLines: 2,
      })
    : { lines: [] as string[], fontPx: 43 * s };

  const lines: PosterLine[] = [
    ...headline.lines.map((text) => ({
      text,
      fontPx: headline.fontPx,
      fontFamily: headlineFont,
      color: '#FFFFFF',
      role: 'title' as const,
      startsSubBlock: false,
    })),
    ...sub.lines.map((text, i) => ({
      text,
      fontPx: sub.fontPx,
      fontFamily: 'Montserrat',
      color: '#EDEAE2',
      role: 'overlay' as const,
      startsSubBlock: i === 0,
    })),
  ];
  if (lines.length === 0) return next;

  // Box model (estimateTextBox): box height = fontPx * 1.18, centred
  // on position.y. The gap between boxes must clear the audit's
  // pad: boxesOverlap(a, b, 6) reports an overlap whenever the
  // vertical gap is < 6px, so the base inter-box gap is 8px (the
  // brief's +2 pitch epsilon is not enough against a 6px pad).
  const BOX_GAP_PX = 8;
  const boxH = (l: PosterLine) => l.fontPx * 1.18;
  const gapAbove = (l: PosterLine) =>
    l.startsSubBlock ? BOX_GAP_PX + 0.3 * headline.fontPx : BOX_GAP_PX;
  const totalBlockH =
    lines.reduce((sum, l) => sum + boxH(l), 0) +
    lines.slice(1).reduce((sum, l) => sum + gapAbove(l), 0);

  // Layout B: the last line's box bottom sits at H - margin.
  // Layout T: the first line's box top sits at margin.
  let cursorTopPx = opts.layout === 'B' ? H - margin - totalBlockH : margin;
  lines.forEach((line, idx) => {
    const centerYPx = cursorTopPx + boxH(line) / 2;
    next = addTextItem(next, {
      text: line.text,
      atTime: 0,
      durationSeconds: duration,
      role: line.role,
      fontSize: line.fontPx,
      color: line.color,
      position: { x: 50, y: (centerYPx / H) * 100 },
      font: line.fontFamily,
    });
    cursorTopPx += boxH(line);
    if (idx < lines.length - 1) cursorTopPx += gapAbove(lines[idx + 1]);
  });
  return next;
}

// ---------------------------------------------------------------------------
// Scrim file (browser only)
// ---------------------------------------------------------------------------

/**
 * The gradient scrim PNG for a poster band. The canvas is 540 wide
 * and as tall as the band it will cover (55% of canvas height for
 * layout B, 50% for T), so the file's aspect matches the rect the
 * builder places it in. Follows the canvas pattern in analyze.ts'
 * sliceBandFiles.
 */
export async function createScrimFile(
  layout: PosterLayout,
  canvasWidth: number,
  canvasHeight: number,
): Promise<File> {
  const bandH = (layout === 'B' ? 0.55 : 0.5) * canvasHeight;
  const width = 540;
  const height = Math.max(1, Math.round((540 * bandH) / canvasWidth));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  if (layout === 'B') {
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(0.55, 'rgba(0,0,0,0.45)');
    gradient.addColorStop(1, 'rgba(0,0,0,0.88)');
  } else {
    gradient.addColorStop(0, 'rgba(0,0,0,0.88)');
    gradient.addColorStop(0.45, 'rgba(0,0,0,0.45)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not create the poster scrim.');
  return new File([blob], `poster-scrim-${layout.toLowerCase()}.png`, { type: 'image/png' });
}

// ---------------------------------------------------------------------------
// Still render (browser only; draw/canvas injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Render the poster at t=0 to a PNG blob, at exactly the project's
 * canvas size. The watermark (when enabled) is drawn by drawFrame
 * itself — nothing extra is added here.
 */
export async function renderPosterStillBlob(
  project: Project,
  assets: FrameAssets,
  deps?: {
    makeCanvas?: () => HTMLCanvasElement;
    draw?: (ctx: CanvasRenderingContext2D, project: Project, t: number, assets: FrameAssets) => void;
  },
): Promise<Blob> {
  const canvas = (deps?.makeCanvas ?? (() => document.createElement('canvas')))();
  canvas.width = project.canvasWidth;
  canvas.height = project.canvasHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser.');
  const draw = deps?.draw ?? drawFrame;
  draw(ctx, project, 0, assets);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not render the poster still.');
  return blob;
}
