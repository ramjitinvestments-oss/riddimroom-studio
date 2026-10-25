/**
 * Viral Promo — recipe builders.
 *
 * Each builder is a pure `(project) => project` transform in the same style
 * as the template apply functions: it places the user's ORIGINAL artwork
 * pixels on the timeline (full art and/or canvas-sliced band assets) with
 * the choreography proven in the offline proof set — slam hook, kinetic
 * band build, light-sweep shine, CTA card, logo power-on build, character
 * slam, countdown, newsflash, lineup reveal, versus and flyer stack.
 * Artwork is never redrawn or regenerated; only transforms, fades,
 * entrance animations and the compositor's motion effects move it.
 *
 * Canvas math mirrors `drawImageItem` in lib/render/compositor.ts: an
 * image item's rendered width = canvasWidth * 0.25 * scale, height follows
 * the source aspect. Positions are % of canvas (center-based). All
 * geometry derives from the project's canvas size, so every recipe works
 * at 9:16, 16:9, 1:1 and 4:5.
 */

import type { ColorGradeSettings, ImageTimelineItem, MediaAsset, Project } from '../../types/timeline';
import { addItem, addMediaAsset, generateTimelineId, getTracksByType } from '../timeline/utils';
import { dealTreatments } from './deck';
import { addTextItem } from '../timeline/insert';
import { getGradePreset } from '../grades';
import type { Band } from './analyze';

export type PromoRecipeId =
  | 'kinetic-build' | 'logo-build' | 'slam' | 'spin-slam'
  | 'countdown' | 'newsflash' | 'lineup' | 'versus' | 'flyer-stack';

export type PromoSkinId = 'dancehall-raw' | 'soca-shine' | 'gospel-light' | 'corporate-clean';

export interface PromoSkin {
  label: string;
  /** Accent colour for added type (hook line 2, sub lines). */
  accent: string;
  /** Studio grade preset applied to the artwork items. */
  gradeId: string;
  /** Timing/intensity multiplier: >1 = faster, harder hits. */
  energy: number;
}

export const PROMO_SKINS: Record<PromoSkinId, PromoSkin> = {
  'dancehall-raw': { label: 'Dancehall Raw', accent: '#FFD100', gradeId: 'vivid-party', energy: 1.15 },
  'soca-shine': { label: 'Soca Shine', accent: '#FFB03A', gradeId: 'cinematic-warm', energy: 1.05 },
  'gospel-light': { label: 'Gospel Light', accent: '#FFE9A8', gradeId: 'clean-commercial', energy: 0.9 },
  'corporate-clean': { label: 'Corporate Clean', accent: '#7FD4FF', gradeId: 'clean-commercial', energy: 0.85 },
};

export interface PromoBuildOpts {
  /** Total length in seconds (clamped 8..20). */
  duration?: number;
  /** 'fit' = whole artwork visible (default, text-safe). 'fill' = cover the screen, edges may crop. */
  fit?: 'fit' | 'fill';
  skin?: PromoSkinId;
  /** Extra photos for the photo-cut montage in single-art recipes. */
  extras?: MediaAsset[];
}

export interface PromoTexts {
  hook1?: string;
  hook2?: string;
  cta?: string;
  sub?: string;
  /** Premium font family for the added type (lib/fonts). */
  font?: string;
}

export interface SliceInput {
  asset: MediaAsset;
  band: Band;
}

interface SkinResolved {
  accent: string;
  grade?: ColorGradeSettings;
  energy: number;
}

function resolveSkin(opts?: PromoBuildOpts): SkinResolved {
  const skin = PROMO_SKINS[opts?.skin ?? 'dancehall-raw'];
  const preset = getGradePreset(skin.gradeId);
  return { accent: skin.accent, grade: preset ? { ...preset.grade } : undefined, energy: skin.energy };
}

function durationOf(opts?: PromoBuildOpts): number {
  return Math.min(20, Math.max(8, opts?.duration ?? 12));
}

function imageTrackId(project: Project): string {
  const tracks = getTracksByType(project, 'image');
  if (tracks.length === 0) throw new Error('Project has no image track.');
  return tracks[0].id;
}

interface Rect {
  cx: number;
  cy: number;
  scale: number;
  widthPx: number;
  heightPx: number;
}

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

function assetAspect(asset: MediaAsset): number {
  const aw = asset.width && asset.width > 0 ? asset.width : 1000;
  const ah = asset.height && asset.height > 0 ? asset.height : 1000;
  return ah / aw;
}

/** The artwork's stage rect: fit-inside (whole art visible) or fill (cover). */
function artRect(project: Project, asset: MediaAsset, fit: 'fit' | 'fill' = 'fit'): Rect {
  const W = project.canvasWidth;
  const H = project.canvasHeight;
  const a = assetAspect(asset);
  if (fit === 'fill') {
    const widthPx = Math.max(W, H / a);
    return rectFor(project, asset, widthPx, W / 2, H / 2);
  }
  let widthPx = W;
  let heightPx = widthPx * a;
  if (heightPx > H) {
    heightPx = H;
    widthPx = heightPx / a;
  }
  return rectFor(project, asset, widthPx, W / 2, H / 2);
}

/** Shrink a rect (same center) until its height fits a canvas budget.
    Fixed-fraction rects (newsflash stage, versus cards, stack,
    finale cards) are sized from canvas WIDTH — on a square or wide
    stage a portrait artwork would otherwise spill off the top and
    bottom. Fit is always whole-art: shrink, never crop. */
function clampRectHeight(project: Project, asset: MediaAsset, rect: Rect, maxHeightPx: number): Rect {
  if (rect.heightPx <= maxHeightPx) return rect;
  const widthPx = maxHeightPx / assetAspect(asset);
  return rectFor(project, asset, widthPx, (rect.cx / 100) * project.canvasWidth, (rect.cy / 100) * project.canvasHeight);
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

function addHookTexts(project: Project, texts: PromoTexts, accent: string, until: number): Project {
  let next = project;
  if (texts.hook1) {
    next = addTextItem(next, {
      text: texts.hook1, atTime: 0.25, durationSeconds: Math.min(1.9, Math.max(0.8, until)),
      role: 'title', fontSize: 92, color: '#ffffff', position: { x: 50, y: 9 }, font: texts.font,
    });
  }
  if (texts.hook2) {
    next = addTextItem(next, {
      text: texts.hook2, atTime: 0.85, durationSeconds: Math.min(1.9, Math.max(0.8, until)),
      role: 'title', fontSize: 92, color: accent, position: { x: 50, y: 16.5 }, font: texts.font,
    });
  }
  return next;
}

function addCtaTexts(project: Project, texts: PromoTexts, accent: string, from: number, duration: number): Project {
  let next = project;
  if (texts.cta) {
    next = addTextItem(next, {
      text: texts.cta, atTime: from, durationSeconds: Math.max(0.5, duration - from),
      role: 'title', fontSize: 72, color: '#ffffff', position: { x: 50, y: 83 }, font: texts.font,
    });
  }
  if (texts.sub) {
    next = addTextItem(next, {
      text: texts.sub, atTime: from + 0.55, durationSeconds: Math.max(0.5, duration - from - 0.55),
      role: 'overlay', fontSize: 44, color: accent, position: { x: 50, y: 89.5 }, font: texts.font,
    });
  }
  return next;
}

/**
 * PHOTO CUTS — the montage for single-art recipes: extra photos cut
 * in full-bleed across [from, to], each dealt its own entrance +
 * drift from the animation deck (never the same treatment twice in
 * a row). Cuts shorter than 0.7s are skipped — extras beyond the
 * window's capacity simply don't make the cut.
 */
function addPhotoCuts(
  project: Project,
  trackId: string,
  extras: MediaAsset[],
  from: number,
  to: number,
  skin: SkinResolved,
  zBase: number,
): Project {
  let next = project;
  const windowSeconds = to - from;
  if (windowSeconds <= 0 || extras.length === 0) return next;
  const usable = extras.slice(0, Math.max(1, Math.floor(windowSeconds / 0.7)));
  const seg = windowSeconds / usable.length;
  const dealt = dealTreatments(usable.length);
  usable.forEach((asset, i) => {
    const cover = artRect(next, asset, 'fill');
    next = addItem(next, imageItem(next, trackId, asset, cover, {
      startTime: from + i * seg, endTime: from + (i + 1) * seg, zIndex: zBase + i,
      animation: { entrance: dealt[i].entrance, intensity: skin.energy },
      motion: { ...dealt[i].drift, intensity: skin.energy },
      fade: { fadeInDuration: 0.1, fadeOutDuration: 0 }, colorGrade: skin.grade,
    }));
  });
  return next;
}

/**
 * KINETIC BUILD (flyers/posters): ambient plate → bands land staggered on
 * the beat → light-sweep shine across the assembled art → CTA card + texts.
 */
export function buildKineticProject(
  project: Project,
  art: MediaAsset,
  slices: SliceInput[],
  texts: PromoTexts,
  opts?: PromoBuildOpts,
): Project {
  const D = durationOf(opts);
  const skin = resolveSkin(opts);
  const trackId = imageTrackId(project);
  let next = withAssets(project, [art, ...slices.map((s) => s.asset)]);
  const rect = artRect(next, art, opts?.fit ?? 'fit');
  const W = next.canvasWidth;
  const H = next.canvasHeight;
  const topPx = rect.cy * (H / 100) - rect.heightPx / 2;

  next = addItem(next, imageItem(next, trackId, art, { ...rect, scale: rect.scale * 1.15 }, {
    startTime: 0, endTime: D, zIndex: 1, opacity: 0.35,
    motion: { type: 'vignette', intensity: 1 }, colorGrade: skin.grade,
  }));

  const buildEnd = D * 0.6;
  const stagger = 0.32 / skin.energy;
  const sliceDeck = dealTreatments(slices.length);
  slices.forEach((slice, i) => {
    const bandCenterYPx = topPx + ((slice.band.y0 + slice.band.y1) / 2) * rect.heightPx;
    const bandRect = rectFor(next, slice.asset, rect.widthPx, W / 2, bandCenterYPx);
    next = addItem(next, imageItem(next, trackId, slice.asset, bandRect, {
      startTime: 1.0 + i * stagger, endTime: buildEnd, zIndex: 10 + i,
      animation: { entrance: sliceDeck[i].entrance, intensity: skin.energy },
      fade: { fadeInDuration: 0.12, fadeOutDuration: 0 }, colorGrade: skin.grade,
    }));
  });

  next = addItem(next, imageItem(next, trackId, art, rect, {
    startTime: D * 0.4, endTime: buildEnd, zIndex: 40,
    motion: { type: 'light-sweep', intensity: Math.min(2, 1.2 * skin.energy) }, colorGrade: skin.grade,
  }));

  const extras = opts?.extras ?? [];
  const cutsWindow = extras.length > 0 ? D * 0.2 : 0;
  const cardStart = buildEnd + cutsWindow;
  if (extras.length > 0) {
    next = withAssets(next, extras);
    next = addPhotoCuts(next, trackId, extras, buildEnd, cardStart, skin, 45);
  }
  const cardRect = clampRectHeight(next, art, rectFor(next, art, W * 0.8, W / 2, H * 0.42), H * 0.8);
  next = addItem(next, imageItem(next, trackId, art, cardRect, {
    startTime: cardStart, endTime: D, zIndex: 50,
    fade: { fadeInDuration: 0.3, fadeOutDuration: 0 }, colorGrade: skin.grade,
    endTransform: { position: { x: cardRect.cx, y: cardRect.cy }, scale: cardRect.scale * 1.03, opacity: 1, eased: true },
  }));

  next = addHookTexts(next, texts, skin.accent, D * 0.2);
  next = addCtaTexts(next, texts, skin.accent, cardStart + 0.15, D);
  return next;
}

/**
 * LOGO BUILD (logos on dark grounds): the logo's own element strips are
 * re-staged as a vertical lockup (a centered lockup in landscape formats)
 * and power on one by one, then a light-sweep sheen crosses the widest
 * element and the CTA lands.
 */
export function buildLogoProject(
  project: Project,
  strips: SliceInput[],
  texts: PromoTexts,
  opts?: PromoBuildOpts,
): Project {
  const D = durationOf(opts);
  const skin = resolveSkin(opts);
  const trackId = imageTrackId(project);
  let next = withAssets(project, strips.map((s) => s.asset));
  const W = next.canvasWidth;
  const H = next.canvasHeight;
  const landscape = W > H;
  const widthCap = landscape ? 0.55 : 0.94;

  const sized = strips.map((strip, i) => {
    const a = assetAspect(strip.asset);
    let widthPx = W * Math.min(widthCap, i === 0 ? 0.66 : i === 1 ? 0.94 : 0.86);
    let heightPx = widthPx * a;
    const maxH = H * (i === 0 ? 0.3 : 0.17);
    if (heightPx > maxH) {
      heightPx = maxH;
      widthPx = heightPx / a;
    }
    return { strip, widthPx, heightPx };
  });
  const gapPx = H * 0.018;
  let totalH = sized.reduce((s, x) => s + x.heightPx, 0) + gapPx * Math.max(0, sized.length - 1);
  if (totalH > H * 0.78) {
    const f = (H * 0.78) / totalH;
    sized.forEach((x) => { x.widthPx *= f; x.heightPx *= f; });
    totalH = H * 0.78;
  }

  let cursorY = (H - totalH) / 2;
  let widest = 0;
  const rects: Rect[] = [];
  const stagger = 0.55 / skin.energy;
  sized.forEach((x, i) => {
    if (x.widthPx > sized[widest].widthPx) widest = i;
    const centerY = cursorY + x.heightPx / 2;
    cursorY += x.heightPx + gapPx;
    const rect = rectFor(next, x.strip.asset, x.widthPx, W / 2, centerY);
    rects.push(rect);
    next = addItem(next, imageItem(next, trackId, x.strip.asset, rect, {
      startTime: 0.5 + i * stagger, endTime: D, zIndex: 10 + i,
      animation: { entrance: 'pop', intensity: skin.energy },
      fade: { fadeInDuration: 0.2, fadeOutDuration: 0 }, colorGrade: skin.grade,
    }));
  });

  const sheenRect = rects[widest];
  if (sheenRect) {
    const sheenStart = 0.5 + sized.length * stagger + 0.3;
    next = addItem(next, imageItem(next, trackId, sized[widest].strip.asset, sheenRect, {
      startTime: sheenStart, endTime: Math.min(D, sheenStart + 1.6), zIndex: 40,
      motion: { type: 'light-sweep', intensity: 1 }, colorGrade: skin.grade,
    }));
  }

  next = addHookTexts(next, { hook1: texts.hook1 }, skin.accent, D * 0.2);
  if (texts.cta) {
    const ctaAt = 0.5 + sized.length * stagger + 0.9;
    next = addTextItem(next, {
      text: texts.cta, atTime: ctaAt, durationSeconds: Math.max(1, D - ctaAt),
      role: 'overlay', fontSize: 46, color: skin.accent,
      position: { x: 50, y: ((cursorY + gapPx) / H) * 100 + 3 },
    });
  }
  return next;
}

/**
 * SLAM (character art / photos / portrait flyers): full-bleed cover with a
 * punch-zoom impact and slow push, hook type up top, then a calmer CTA
 * phase. The 'spin-slam' variant enters with a spin + flash instead.
 */
export function buildSlamProject(
  project: Project,
  art: MediaAsset,
  texts: PromoTexts,
  opts?: PromoBuildOpts & { variant?: 'slam' | 'spin' },
): Project {
  const D = durationOf(opts);
  const skin = resolveSkin(opts);
  const trackId = imageTrackId(project);
  let next = withAssets(project, [art]);
  const cover = artRect(next, art, opts?.fit ?? 'fit');
  const split = D * 0.62;
  const spin = opts?.variant === 'spin';

  const extras = opts?.extras ?? [];
  const heroEnd = extras.length > 0 ? D * 0.34 : split;
  if (extras.length > 0) next = withAssets(next, extras);
  next = addItem(next, imageItem(next, trackId, art, cover, {
    startTime: 0, endTime: heroEnd, zIndex: 10,
    motion: spin ? { type: 'flash', intensity: 1 } : { type: 'punch-zoom', intensity: 1.1 * skin.energy },
    animation: spin ? { entrance: 'spin', intensity: skin.energy } : undefined,
    colorGrade: skin.grade,
    endTransform: { position: { x: cover.cx, y: cover.cy }, scale: cover.scale * 1.1, opacity: 1, eased: true },
  }));
  if (extras.length > 0) {
    next = addPhotoCuts(next, trackId, extras, heroEnd, split, skin, 12);
  }
  next = addItem(next, imageItem(next, trackId, art, { ...cover, scale: cover.scale * 0.97 }, {
    startTime: split, endTime: D, zIndex: 11,
    motion: { type: 'vignette', intensity: 1 },
    fade: { fadeInDuration: 0.25, fadeOutDuration: 0 }, colorGrade: skin.grade,
  }));

  next = addHookTexts(next, texts, skin.accent, D * 0.2);
  next = addCtaTexts(next, texts, skin.accent, split + 0.2, D);
  return next;
}

/**
 * COUNTDOWN (events): the art on stage under a giant 3-2-1, then the
 * event name and CTA land. Numbers are added type; the art is untouched.
 */
export function buildCountdownProject(
  project: Project,
  art: MediaAsset,
  texts: PromoTexts,
  opts?: PromoBuildOpts,
): Project {
  const D = durationOf(opts);
  const skin = resolveSkin(opts);
  const trackId = imageTrackId(project);
  let next = withAssets(project, [art]);
  const rect = artRect(next, art, opts?.fit ?? 'fit');

  next = addItem(next, imageItem(next, trackId, art, rect, {
    startTime: 0, endTime: D, zIndex: 10, opacity: 0.55,
    motion: { type: 'punch-zoom', intensity: skin.energy }, colorGrade: skin.grade,
  }));

  const countEnd = D * 0.55;
  const step = countEnd / 3;
  const cdExtras = opts?.extras ?? [];
  if (cdExtras.length > 0) {
    next = withAssets(next, cdExtras);
    next = addPhotoCuts(next, trackId, cdExtras, 0.3, countEnd + (D - countEnd) * 0.3, skin, 12);
  }
  ['3', '2', '1'].forEach((n, i) => {
    next = addTextItem(next, {
      text: n, atTime: 0.3 + i * step, durationSeconds: step,
      role: 'title', fontSize: 320, color: i === 2 ? skin.accent : '#ffffff',
      position: { x: 50, y: 44 },
    });
  });
  if (texts.hook1) {
    next = addTextItem(next, {
      text: texts.hook1, atTime: countEnd + 0.1, durationSeconds: D - countEnd - 0.1,
      role: 'title', fontSize: 96, color: '#ffffff', position: { x: 50, y: 30 }, font: texts.font,
    });
  }
  next = addCtaTexts(next, texts, skin.accent, countEnd + 0.3, D);
  return next;
}

/**
 * NEWSFLASH (announcements/drops): glitch-in stage art, headline up top,
 * lower-third stack landing in sequence.
 */
export function buildNewsflashProject(
  project: Project,
  art: MediaAsset,
  texts: PromoTexts,
  opts?: PromoBuildOpts,
): Project {
  const D = durationOf(opts);
  const skin = resolveSkin(opts);
  const trackId = imageTrackId(project);
  let next = withAssets(project, [art]);
  const W = next.canvasWidth;
  const H = next.canvasHeight;
  const rect = clampRectHeight(next, art, rectFor(next, art, W * 0.86, W / 2, H * 0.42), H * 0.8);

  next = addItem(next, imageItem(next, trackId, art, rect, {
    startTime: 0.2, endTime: D, zIndex: 10,
    animation: { entrance: 'glitch', intensity: skin.energy },
    motion: { type: 'light-sweep', intensity: 0.8 }, colorGrade: skin.grade,
  }));
  if (texts.hook1) {
    next = addTextItem(next, {
      text: texts.hook1, atTime: 0.2, durationSeconds: D - 0.2,
      role: 'title', fontSize: 84, color: '#ffffff', position: { x: 50, y: 10 },
    });
  }
  if (texts.hook2) {
    next = addTextItem(next, {
      text: texts.hook2, atTime: 0.7, durationSeconds: D - 0.7,
      role: 'title', fontSize: 58, color: skin.accent, position: { x: 50, y: 74 },
    });
  }
  next = addCtaTexts(next, texts, skin.accent, 1.2, D);
  return next;
}

/**
 * LINEUP REVEAL (cast/lineup posters): the poster slams in, then each
 * artwork gets a solo hero moment with its name punched in, then the
 * poster returns for the CTA finale. `arts[0]` is the poster.
 */
export function buildLineupProject(
  project: Project,
  arts: Array<{ asset: MediaAsset; name: string }>,
  texts: PromoTexts,
  opts?: PromoBuildOpts,
): Project {
  const D = durationOf(opts);
  const skin = resolveSkin(opts);
  const trackId = imageTrackId(project);
  let next = withAssets(project, arts.map((a) => a.asset));
  const poster = arts[0].asset;
  const solos = arts.slice(1);
  const seg = D / (solos.length + 2); // intro + one segment per solo + finale

  const posterCover = artRect(next, poster, 'fill');
  next = addItem(next, imageItem(next, trackId, poster, posterCover, {
    startTime: 0, endTime: seg, zIndex: 10,
    motion: { type: 'punch-zoom', intensity: skin.energy }, colorGrade: skin.grade,
  }));
  next = addHookTexts(next, texts, skin.accent, seg * 0.5);

  const soloDeck = dealTreatments(solos.length);
  solos.forEach((entry, i) => {
    const start = seg * (i + 1);
    const cover = artRect(next, entry.asset, 'fill');
    next = addItem(next, imageItem(next, trackId, entry.asset, cover, {
      startTime: start, endTime: start + seg, zIndex: 20 + i,
      animation: { entrance: soloDeck[i].entrance, intensity: skin.energy },
      motion: { ...soloDeck[i].drift, intensity: skin.energy },
      fade: { fadeInDuration: 0.15, fadeOutDuration: 0 }, colorGrade: skin.grade,
    }));
    next = addTextItem(next, {
      text: entry.name.toUpperCase(), atTime: start + 0.1, durationSeconds: seg - 0.1,
      role: 'title', fontSize: 96, color: '#ffffff', position: { x: 50, y: 11 }, font: texts.font,
    });
    if (texts.hook2) {
      next = addTextItem(next, {
        text: texts.hook2, atTime: start + 0.35, durationSeconds: seg - 0.35,
        role: 'overlay', fontSize: 46, color: skin.accent, position: { x: 50, y: 17.5 }, font: texts.font,
      });
    }
  });

  const finaleAt = seg * (solos.length + 1);
  const card = clampRectHeight(next, poster, rectFor(next, poster, next.canvasWidth * 0.84, next.canvasWidth / 2, next.canvasHeight * 0.42), next.canvasHeight * 0.72);
  next = addItem(next, imageItem(next, trackId, poster, card, {
    startTime: finaleAt, endTime: D, zIndex: 60,
    fade: { fadeInDuration: 0.25, fadeOutDuration: 0 }, colorGrade: skin.grade,
  }));
  next = addCtaTexts(next, texts, skin.accent, finaleAt + 0.15, D);
  return next;
}

/**
 * VERSUS (clash cards / sound clashes / match-ups): two artworks slide in
 * from opposite sides, the VS mark lands between them, CTA closes.
 */
export function buildVersusProject(
  project: Project,
  a: MediaAsset,
  b: MediaAsset,
  texts: PromoTexts,
  opts?: PromoBuildOpts,
): Project {
  const D = durationOf(opts);
  const skin = resolveSkin(opts);
  const trackId = imageTrackId(project);
  let next = withAssets(project, [a, b]);
  const W = next.canvasWidth;
  const H = next.canvasHeight;
  const rectA = clampRectHeight(next, a, rectFor(next, a, W * 0.44, W * 0.26, H * 0.42), H * 0.72);
  const rectB = clampRectHeight(next, b, rectFor(next, b, W * 0.44, W * 0.74, H * 0.42), H * 0.72);

  next = addItem(next, imageItem(next, trackId, a, rectA, {
    startTime: 0.3, endTime: D, zIndex: 10,
    animation: { entrance: 'slide-left', intensity: skin.energy }, colorGrade: skin.grade,
  }));
  next = addItem(next, imageItem(next, trackId, b, rectB, {
    startTime: 0.3, endTime: D, zIndex: 11,
    animation: { entrance: 'slide-right', intensity: skin.energy }, colorGrade: skin.grade,
  }));
  next = addTextItem(next, {
    text: 'VS', atTime: 0.8, durationSeconds: D - 0.8,
    role: 'title', fontSize: 150, color: skin.accent, position: { x: 50, y: 42 },
  });
  if (texts.hook1) {
    next = addTextItem(next, {
      text: texts.hook1, atTime: 0.2, durationSeconds: D - 0.2,
      role: 'title', fontSize: 80, color: '#ffffff', position: { x: 50, y: 10 },
    });
  }
  next = addCtaTexts(next, texts, skin.accent, D * 0.55, D);
  return next;
}

/**
 * FLYER STACK (multiple flyers/products): the artworks fan in as a
 * rotated stack, the top one gets the shine pass, CTA closes.
 */
export function buildStackProject(
  project: Project,
  arts: MediaAsset[],
  texts: PromoTexts,
  opts?: PromoBuildOpts,
): Project {
  const D = durationOf(opts);
  const skin = resolveSkin(opts);
  const trackId = imageTrackId(project);
  let next = withAssets(project, arts);
  const W = next.canvasWidth;
  const H = next.canvasHeight;
  const rotations = [-7, 5, -3, 0, 6, -5];

  const stackDeck = dealTreatments(arts.length);
  arts.forEach((art, i) => {
    const rect = clampRectHeight(next, art, rectFor(next, art, W * 0.62, W / 2, H * 0.44), H * 0.78);
    next = addItem(next, imageItem(next, trackId, art, rect, {
      startTime: 0.4 + i * (0.5 / skin.energy), endTime: D, zIndex: 10 + i,
      rotation: rotations[i % rotations.length],
      animation: { entrance: stackDeck[i].entrance, intensity: skin.energy },
      fade: { fadeInDuration: 0.15, fadeOutDuration: 0 }, colorGrade: skin.grade,
    }));
  });

  const top = arts[arts.length - 1];
  const topRect = clampRectHeight(next, top, rectFor(next, top, W * 0.62, W / 2, H * 0.44), H * 0.78);
  const shineAt = 0.4 + arts.length * (0.5 / skin.energy) + 0.3;
  next = addItem(next, imageItem(next, trackId, top, topRect, {
    startTime: shineAt, endTime: Math.min(D, shineAt + 1.6), zIndex: 40,
    rotation: rotations[(arts.length - 1) % rotations.length],
    motion: { type: 'light-sweep', intensity: 1 }, colorGrade: skin.grade,
  }));

  next = addHookTexts(next, texts, skin.accent, D * 0.2);
  next = addCtaTexts(next, texts, skin.accent, shineAt + 0.4, D);
  return next;
}

/** Music pack: the built-in loop each skin's promo ships with (fitted to length). */
export const PROMO_SKIN_LOOP: Record<PromoSkinId, string> = {
  'dancehall-raw': 'dancehall-riddim',
  'soca-shine': 'soca-groove',
  'gospel-light': 'gospel-light',
  'corporate-clean': 'corporate-pulse',
};
