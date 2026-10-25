/**
 * Viral Promo — recipe builders.
 *
 * Each builder is a pure `(project) => project` transform in the same style
 * as the template apply functions: it places the user's ORIGINAL artwork
 * pixels on the timeline (full art and/or canvas-sliced band assets) with
 * the choreography proven in the offline proof set — slam hook, kinetic
 * band build, light-sweep shine, CTA card, logo power-on build, character
 * slam. Artwork is never redrawn or regenerated; only transforms, fades,
 * entrance animations and the compositor's motion effects move it.
 *
 * Canvas math mirrors `drawImageItem` in lib/render/compositor.ts: an
 * image item's rendered width = canvasWidth * 0.25 * scale, height follows
 * the source aspect. Positions are % of canvas (center-based).
 */

import type { ImageTimelineItem, MediaAsset, Project } from '../../types/timeline';
import { addItem, addMediaAsset, generateTimelineId, getTracksByType } from '../timeline/utils';
import { addTextItem } from '../timeline/insert';
import type { Band } from './analyze';

export type PromoRecipeId = 'kinetic-build' | 'logo-build' | 'slam';

export interface PromoTexts {
  hook1?: string;
  hook2?: string;
  cta?: string;
  sub?: string;
}

export interface SliceInput {
  asset: MediaAsset;
  band: Band;
}

const GOLD = '#FFD100';

function imageTrackId(project: Project): string {
  const tracks = getTracksByType(project, 'image');
  if (tracks.length === 0) throw new Error('Project has no image track.');
  return tracks[0].id;
}

interface Rect {
  cx: number; // center x, % of canvas width
  cy: number; // center y, % of canvas height
  scale: number; // item scale that renders the asset at the rect width
  widthPx: number;
  heightPx: number;
}

/** Rect for an asset of aspect h/w shown at a target width, centered at (cxPx, cyPx). */
function rectFor(project: Project, asset: MediaAsset, widthPx: number, cxPx: number, cyPx: number): Rect {
  const aw = asset.width && asset.width > 0 ? asset.width : 1000;
  const ah = asset.height && asset.height > 0 ? asset.height : 1000;
  const heightPx = (widthPx * ah) / aw;
  return {
    cx: (cxPx / project.canvasWidth) * 100,
    cy: (cyPx / project.canvasHeight) * 100,
    scale: widthPx / (project.canvasWidth * 0.25),
    widthPx,
    heightPx,
  };
}

/** Fit artwork inside the canvas: full-bleed width for portrait art, a wide card for landscape. */
function artRect(project: Project, asset: MediaAsset): Rect {
  const W = project.canvasWidth;
  const H = project.canvasHeight;
  const aw = asset.width && asset.width > 0 ? asset.width : W;
  const ah = asset.height && asset.height > 0 ? asset.height : H;
  let widthPx = W;
  let heightPx = (widthPx * ah) / aw;
  if (heightPx > H) {
    heightPx = H;
    widthPx = (heightPx * aw) / ah;
  }
  return rectFor(project, asset, widthPx, W / 2, H / 2);
}

type ImageItemOpts = Partial<ImageTimelineItem> & Pick<ImageTimelineItem, 'startTime' | 'endTime' | 'zIndex'>;

function imageItem(project: Project, trackId: string, asset: MediaAsset, rect: Rect, opts: ImageItemOpts): ImageTimelineItem {
  return {
    id: generateTimelineId('item'),
    type: 'image',
    trackId,
    visible: true,
    mediaAssetId: asset.id,
    role: 'graphic',
    position: { x: rect.cx, y: rect.cy },
    scale: rect.scale,
    rotation: 0,
    opacity: 1,
    ...opts,
  };
}

function withAssets(project: Project, assets: MediaAsset[]): Project {
  let next = project;
  for (const a of assets) next = addMediaAsset(next, a);
  return next;
}

function addHookTexts(project: Project, texts: PromoTexts, duration: number): Project {
  let next = project;
  if (texts.hook1) {
    next = addTextItem(next, {
      text: texts.hook1,
      atTime: 0.25,
      durationSeconds: Math.min(1.9, duration * 0.2),
      role: 'title',
      fontSize: 92,
      color: '#ffffff',
      position: { x: 50, y: 9 },
    });
  }
  if (texts.hook2) {
    next = addTextItem(next, {
      text: texts.hook2,
      atTime: 0.85,
      durationSeconds: Math.min(1.9, duration * 0.2),
      role: 'title',
      fontSize: 92,
      color: GOLD,
      position: { x: 50, y: 16.5 },
    });
  }
  return next;
}

/**
 * KINETIC BUILD (flyers/posters): ambient plate → bands land staggered on
 * the beat → light-sweep shine across the assembled art → CTA card + texts.
 * `slices` are the artwork's own bands, uploaded as separate assets.
 */
export function buildKineticProject(
  project: Project,
  art: MediaAsset,
  slices: SliceInput[],
  texts: PromoTexts,
  duration = 12,
): Project {
  const D = Math.min(20, Math.max(8, duration));
  const trackId = imageTrackId(project);
  let next = withAssets(project, [art, ...slices.map((s) => s.asset)]);
  const rect = artRect(next, art);
  const W = next.canvasWidth;
  const H = next.canvasHeight;
  const topPx = rect.cy * (H / 100) - rect.heightPx / 2;

  // Ambient plate: the art itself, oversized and dimmed, for the whole cut.
  next = addItem(
    next,
    imageItem(next, trackId, art, { ...rect, scale: rect.scale * 1.15 }, {
      startTime: 0,
      endTime: D,
      zIndex: 1,
      opacity: 0.35,
      motion: { type: 'vignette', intensity: 1 },
    }),
  );

  // Bands land staggered, alternating slide direction.
  const buildEnd = D * 0.6;
  slices.forEach((slice, i) => {
    const bandCenterYPx = topPx + ((slice.band.y0 + slice.band.y1) / 2) * rect.heightPx;
    const bandRect = rectFor(next, slice.asset, rect.widthPx, W / 2, bandCenterYPx);
    next = addItem(
      next,
      imageItem(next, trackId, slice.asset, bandRect, {
        startTime: 1.0 + i * 0.32,
        endTime: buildEnd,
        zIndex: 10 + i,
        animation: { entrance: i % 2 === 0 ? 'slide-left' : 'slide-right', intensity: 1 },
        fade: { fadeInDuration: 0.12, fadeOutDuration: 0 },
      }),
    );
  });

  // Shine pass: the full art at the exact assembled rect, light-sweep only.
  next = addItem(
    next,
    imageItem(next, trackId, art, rect, {
      startTime: D * 0.4,
      endTime: buildEnd,
      zIndex: 40,
      motion: { type: 'light-sweep', intensity: 1.2 },
    }),
  );

  // CTA card: the full art, calmer scale, gentle end pulse.
  const cardRect = rectFor(next, art, W * 0.8, W / 2, H * 0.42);
  next = addItem(
    next,
    imageItem(next, trackId, art, cardRect, {
      startTime: buildEnd,
      endTime: D,
      zIndex: 50,
      fade: { fadeInDuration: 0.3, fadeOutDuration: 0 },
      endTransform: {
        position: { x: cardRect.cx, y: cardRect.cy },
        scale: cardRect.scale * 1.03,
        opacity: 1,
        eased: true,
      },
    }),
  );

  next = addHookTexts(next, texts, D);
  if (texts.cta) {
    next = addTextItem(next, {
      text: texts.cta,
      atTime: buildEnd + 0.15,
      durationSeconds: D - buildEnd - 0.15,
      role: 'title',
      fontSize: 72,
      color: '#ffffff',
      position: { x: 50, y: 83 },
    });
  }
  if (texts.sub) {
    next = addTextItem(next, {
      text: texts.sub,
      atTime: buildEnd + 0.7,
      durationSeconds: D - buildEnd - 0.7,
      role: 'overlay',
      fontSize: 44,
      color: GOLD,
      position: { x: 50, y: 89.5 },
    });
  }
  return next;
}

/**
 * LOGO BUILD (logos on dark grounds): the logo's own element strips are
 * re-staged as a tall vertical lockup and power on one by one, then a
 * light-sweep sheen crosses the widest element and the CTA lands.
 */
export function buildLogoProject(
  project: Project,
  strips: SliceInput[],
  texts: PromoTexts,
  duration = 10,
): Project {
  const D = Math.min(20, Math.max(8, duration));
  const trackId = imageTrackId(project);
  let next = withAssets(project, strips.map((s) => s.asset));
  const W = next.canvasWidth;
  const H = next.canvasHeight;

  // Display widths: emblem (first strip) capped by height, wordmark full.
  const sized = strips.map((strip, i) => {
    const aw = strip.asset.width && strip.asset.width > 0 ? strip.asset.width : 1000;
    const ah = strip.asset.height && strip.asset.height > 0 ? strip.asset.height : 200;
    let widthPx = W * (i === 0 ? 0.66 : i === 1 ? 0.94 : 0.86);
    let heightPx = (widthPx * ah) / aw;
    const maxH = H * (i === 0 ? 0.3 : 0.17);
    if (heightPx > maxH) {
      heightPx = maxH;
      widthPx = (heightPx * aw) / ah;
    }
    return { strip, widthPx, heightPx };
  });
  const gapPx = H * 0.018;
  let totalH = sized.reduce((s, x) => s + x.heightPx, 0) + gapPx * Math.max(0, sized.length - 1);
  if (totalH > H * 0.78) {
    const f = (H * 0.78) / totalH;
    sized.forEach((x) => {
      x.widthPx *= f;
      x.heightPx *= f;
    });
    totalH = H * 0.78;
  }

  let cursorY = (H - totalH) / 2;
  let widest = 0;
  const rects: Rect[] = [];
  sized.forEach((x, i) => {
    if (x.widthPx > sized[widest].widthPx) widest = i;
    const centerY = cursorY + x.heightPx / 2;
    cursorY += x.heightPx + gapPx;
    const rect = rectFor(next, x.strip.asset, x.widthPx, W / 2, centerY);
    rects.push(rect);
    next = addItem(
      next,
      imageItem(next, trackId, x.strip.asset, rect, {
        startTime: 0.5 + i * 0.55,
        endTime: D,
        zIndex: 10 + i,
        animation: { entrance: 'pop', intensity: 1 },
        fade: { fadeInDuration: 0.2, fadeOutDuration: 0 },
      }),
    );
  });

  // Sheen pass over the widest element once the lockup is complete.
  const sheenRect = rects[widest];
  if (sheenRect) {
    const sheenStart = 0.5 + sized.length * 0.55 + 0.3;
    next = addItem(
      next,
      imageItem(next, trackId, sized[widest].strip.asset, sheenRect, {
        startTime: sheenStart,
        endTime: Math.min(D, sheenStart + 1.6),
        zIndex: 40,
        motion: { type: 'light-sweep', intensity: 1 },
      }),
    );
  }

  next = addHookTexts(next, { hook1: texts.hook1 }, D);
  if (texts.cta) {
    next = addTextItem(next, {
      text: texts.cta,
      atTime: 0.5 + sized.length * 0.55 + 0.9,
      durationSeconds: Math.max(1, D - (0.5 + sized.length * 0.55 + 0.9)),
      role: 'overlay',
      fontSize: 46,
      color: GOLD,
      position: { x: 50, y: ((cursorY + gapPx) / H) * 100 + 3 },
    });
  }
  return next;
}

/**
 * SLAM (character art / photos / portrait flyers): full-bleed cover with a
 * punch-zoom impact and slow push, hook type up top, then a calmer CTA
 * phase with a vignette. The artwork is never altered.
 */
export function buildSlamProject(
  project: Project,
  art: MediaAsset,
  texts: PromoTexts,
  duration = 10,
): Project {
  const D = Math.min(20, Math.max(8, duration));
  const trackId = imageTrackId(project);
  let next = withAssets(project, [art]);
  const W = next.canvasWidth;
  const H = next.canvasHeight;
  const aw = art.width && art.width > 0 ? art.width : W;
  const ah = art.height && art.height > 0 ? art.height : H;
  const coverWidth = Math.max(W, (H * aw) / ah);
  const cover = rectFor(next, art, coverWidth, W / 2, H / 2);
  const split = D * 0.62;

  next = addItem(
    next,
    imageItem(next, trackId, art, cover, {
      startTime: 0,
      endTime: split,
      zIndex: 10,
      motion: { type: 'punch-zoom', intensity: 1.1 },
      endTransform: {
        position: { x: cover.cx, y: cover.cy },
        scale: cover.scale * 1.1,
        opacity: 1,
        eased: true,
      },
    }),
  );
  next = addItem(
    next,
    imageItem(next, trackId, art, { ...cover, scale: cover.scale * 0.97 }, {
      startTime: split,
      endTime: D,
      zIndex: 11,
      motion: { type: 'vignette', intensity: 1 },
      fade: { fadeInDuration: 0.25, fadeOutDuration: 0 },
    }),
  );

  next = addHookTexts(next, texts, D);
  if (texts.cta) {
    next = addTextItem(next, {
      text: texts.cta,
      atTime: split + 0.2,
      durationSeconds: D - split - 0.2,
      role: 'title',
      fontSize: 76,
      color: '#ffffff',
      position: { x: 50, y: 84 },
    });
  }
  if (texts.sub) {
    next = addTextItem(next, {
      text: texts.sub,
      atTime: split + 0.8,
      durationSeconds: D - split - 0.8,
      role: 'overlay',
      fontSize: 44,
      color: GOLD,
      position: { x: 50, y: 90.5 },
    });
  }
  return next;
}
