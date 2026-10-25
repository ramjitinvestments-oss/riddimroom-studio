import type { ImageTimelineItem, MotionSettings, Project } from '../../types/timeline';
import { addItem, generateTimelineId } from '../timeline/utils';
import type { OcrLine, ReadoutResult } from './readout';

/**
 * The word-box camera (R12) + stage backdrop.
 *
 * The OCR engine returns the box of every line it read. Instead of
 * a generic drift, the promo's camera now TRAVELS to the words
 * that matter — headline first, the biggest supporting lines next,
 * and the phone/CTA line for the close — by baking a `word-tour`
 * motion (see `computeMotionAdjustment`) into the hero item. And
 * when a recipe would float the art in a black void, a dimmed,
 * enlarged copy of the art itself becomes the stage.
 */

export interface TourStopChoice {
  line: OcrLine;
  zoom: number;
}

const HEADLINE_ZOOM = 1.55;
const SUPPORT_ZOOM = 1.4;
const FINALE_ZOOM = 1.3;

function boxArea(l: OcrLine): number {
  return l.box ? l.box.w * l.box.h : 0;
}

function boxCenter(l: OcrLine): { x: number; y: number } {
  return { x: (l.box?.x ?? 0) + (l.box?.w ?? 0) / 2, y: (l.box?.y ?? 0) + (l.box?.h ?? 0) / 2 };
}

/**
 * Choose the tour stops from a readout: the headline, up to two
 * biggest other boxed lines, then the phone/CTA line as the finale.
 * Fewer than two real stops = no tour (a single punch-zoom from the
 * recipe is the honest fallback).
 */
export function chooseTourStops(result: ReadoutResult): TourStopChoice[] {
  const stops: TourStopChoice[] = [];
  const head = result.headlineLine;
  if (!head?.box) return [];
  stops.push({ line: head, zoom: HEADLINE_ZOOM });
  const others = result.lines
    .filter((l) => l.box && l !== head && l !== result.ctaLine && l !== result.phoneLine && l.confidence >= 50 && l.text.length >= 3)
    .sort((a, b) => boxArea(b) - boxArea(a))
    .slice(0, 2);
  for (const l of others) stops.push({ line: l, zoom: SUPPORT_ZOOM });
  const finale = result.phoneLine?.box ? result.phoneLine : result.ctaLine?.box ? result.ctaLine : undefined;
  if (finale && finale !== head) stops.push({ line: finale, zoom: FINALE_ZOOM });
  return stops.length >= 2 ? stops : [];
}

interface HeroPick {
  item: ImageTimelineItem;
  trackId: string;
  drawnArea: number;
}

function allImageItems(project: Project): Array<{ item: ImageTimelineItem; trackId: string }> {
  return project.items
    .filter((item) => item.type === 'image')
    .map((item) => ({ item: item as ImageTimelineItem, trackId: item.trackId }));
}

function assetAspect(project: Project, assetId: string): number {
  const a = project.mediaAssets[assetId];
  if (!a || !a.width || !a.height) return 1;
  return a.height / a.width;
}

function drawnSize(project: Project, item: ImageTimelineItem): { w: number; h: number } {
  const w = (item.scale || 1) * project.canvasWidth * 0.25;
  return { w, h: w * assetAspect(project, item.mediaAssetId) };
}

/** The dominant full-strength image item — the artwork hero. */
function pickHero(project: Project): HeroPick | null {
  let best: HeroPick | null = null;
  for (const { item, trackId } of allImageItems(project)) {
    if ((item.opacity ?? 1) < 0.9) continue; // backdrops and washes are not heroes
    const { w, h } = drawnSize(project, item);
    const area = w * h;
    if (!best || area > best.drawnArea) best = { item, trackId, drawnArea: area };
  }
  return best;
}

/**
 * Bake the tour into the hero item's motion. The stops' offsets are
 * computed from the item's real geometry: artwork point P must land
 * on the item's own center, so offset = -P * zoom (canvas fractions).
 */
export function bakeTourMotion(project: Project, hero: ImageTimelineItem, stops: TourStopChoice[]): MotionSettings {
  const W = project.canvasWidth;
  const H = project.canvasHeight;
  const { w: dw, h: dh } = drawnSize(project, hero);
  const baked = stops.map((s) => {
    const c = boxCenter(s.line);
    const px = (c.x - 0.5) * dw;
    const py = (c.y - 0.5) * dh;
    return { x: (-px * s.zoom) / W, y: (-py * s.zoom) / H, scale: s.zoom };
  });
  const n = baked.length;
  const tourStops = [
    { t: 0, x: 0, y: 0, scale: 1 },
    ...baked.map((b, i) => ({ t: 0.14 + (0.72 * (i + 1)) / n, ...b })),
    { t: 1, ...baked[n - 1] },
  ];
  return { type: 'word-tour', tourStops };
}

/** Apply the camera tour to the built project (no-op when the
    readout has no tour to give, or no dominant hero exists). */
export function applyCameraTour(project: Project, result: ReadoutResult): Project {
  const stops = chooseTourStops(result);
  if (stops.length < 2) return project;
  const hero = pickHero(project);
  if (!hero) return project;
  const heroSpan = hero.item.endTime - hero.item.startTime;
  const projectSpan = Math.max(0, ...project.items.map((i) => i.endTime));
  // A tour needs a hero that actually carries the promo — slice
  // recipes (many short items) keep their own dealt motion.
  if (projectSpan > 0 && heroSpan < projectSpan * 0.6) return project;
  const motion = bakeTourMotion(project, hero.item, stops);
  return {
    ...project,
    items: project.items.map((item) => (item.id === hero.item.id ? { ...item, motion } : item)),
  };
}

/**
 * The stage backdrop: if the hero doesn't fill the frame and no
 * dimmed backdrop copy exists yet, add one — the artwork itself,
 * enlarged and dimmed — so no promo ever floats in a black void.
 */
export function applyStageBackdrop(project: Project): Project {
  const items = allImageItems(project);
  if (items.some(({ item }) => (item.opacity ?? 1) < 0.9)) return project;
  const hero = pickHero(project);
  if (!hero) return project;
  const { w, h } = drawnSize(project, hero.item);
  const fillRatio = (w * h) / (project.canvasWidth * project.canvasHeight);
  if (fillRatio >= 0.92) return project;
  const backdrop: ImageTimelineItem = {
    ...hero.item,
    id: generateTimelineId('item'),
    scale: (hero.item.scale || 1) * 1.35,
    opacity: 0.32,
    zIndex: (hero.item.zIndex || 1) - 1,
    motion: { type: 'slow-zoom-in', intensity: 0.7 },
    animation: undefined,
  };
  return addItem(project, backdrop);
}
