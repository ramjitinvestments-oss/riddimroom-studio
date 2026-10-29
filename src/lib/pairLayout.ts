/**
 * RiddimRoom Studio — R32 Phase 4 pair geometry + pair bookkeeping.
 *
 * A PAIR is two visual items (video or image, camera-recorded or
 * imported — the tooling is source-agnostic) placed at the same
 * timeline start and arranged together: Corner PiP (one full frame,
 * one overlay) or Split 50/50 (two equal tiles). Both items carry the
 * same `PairSettings` bookkeeping (types/timeline.ts); legacy camera
 * pairs placed by R29–R31 carry none and are recognised through the
 * Phase 3 detection in `lib/templates/pairMotion.ts` instead.
 *
 * TILE GEOMETRY — the decision, and why. The compositor draws a
 * video item into a box of `canvas × scale` on BOTH axes (a source-
 * fit PiP swaps the height for the source's aspect at the same
 * width), and an image item into a width plus the source/crop
 * aspect. A half-canvas tile has NEITHER aspect in general: a
 * stacked tile on a 1080×1920 canvas is 1080×960 (aspect 1.125)
 * while the canvas is 0.5625 and a 16:9 source is 1.778 — so no
 * position/scale/fit combination can express it, for any source.
 * (The one apparent exception — setting an image item's `crop`
 * window to the tile aspect and scaling the width up — hijacks the
 * crop window, which is a content crop the user and preset applies
 * own, and breaks the framing maths that lives inside it.) Phase 4
 * therefore adds the one minimal extension, `frameRect` (percentages
 * of canvas): when present, the shared compositor draws the item
 * into exactly that box. Everything else is REUSED, not paralleled:
 * inside the tile box the source is cover-cropped by the same
 * `croppedCoverSourceRect` the renderer always used, and the
 * existing cropZoom/cropOffsetX/Y fields remain the per-tile focal
 * controls. Preview and export stay identical because both call the
 * same `drawFrame` — there is no second renderer to drift.
 *
 * The divider is pair data (style + width on the bookkeeping); the
 * compositor paints it once per frame over the seam from the same
 * `dividerBandPx` geometry published here, in both render paths.
 *
 * Pure functions, unit-tested; no dependencies.
 */

import type {
  FrameRect,
  ImageTimelineItem,
  MediaAsset,
  PairDividerStyle,
  PairLayout,
  PairOrientation,
  PairSettings,
  Project,
  TimelineItem,
  VideoTimelineItem,
} from '../types/timeline';
import { generateTimelineId, updateItem } from './timeline/utils';
import { PIP_SYNC_NUDGE_MAX_FRAMES, isPipItem, swapMainAndPip } from './pip';
import { findPairMainVideo, isCameraPipItem } from './templates/pairMotion';

export type PairVisualItem = VideoTimelineItem | ImageTimelineItem;

/** A rectangle in canvas pixels (x/y = left/top edge). */
export interface RectPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Divider colours the compositor paints (gold = the brand gold). */
export const PAIR_DIVIDER_COLORS: Record<Exclude<PairDividerStyle, 'none'>, string> = {
  white: '#FFFFFF',
  gold: '#FFD100',
};

/** The divider a fresh split pair gets: white, 4px (see insert.ts for the reasoning). */
export const PAIR_DIVIDER_DEFAULT_STYLE: PairDividerStyle = 'white';
export const PAIR_DIVIDER_DEFAULT_WIDTH_PX = 4;
export const PAIR_DIVIDER_MAX_WIDTH_PX = 12;

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

/**
 * The default split orientation for a canvas: portrait (including
 * 4:5) and square stack top/bottom; landscape goes side by side.
 */
export function defaultSplitOrientation(canvasWidth: number, canvasHeight: number): PairOrientation {
  return canvasHeight >= canvasWidth ? 'stacked' : 'side';
}

/**
 * The two equal tiles of a 50/50 split, in canvas pixels. Stacked:
 * each tile is the full width and half the height (top = main,
 * bottom = second). Side: each is half the width and the full height
 * (left = main, right = second). The seam sits exactly at 50% on
 * both axes for any canvas size (odd sizes give the main tile the
 * extra pixel, so the union is always the full canvas exactly).
 */
export function splitTiles(
  canvasWidth: number,
  canvasHeight: number,
  orientation: PairOrientation,
): { main: RectPx; second: RectPx } {
  if (orientation === 'stacked') {
    const mainH = Math.ceil(canvasHeight / 2);
    return {
      main: { x: 0, y: 0, w: canvasWidth, h: mainH },
      second: { x: 0, y: mainH, w: canvasWidth, h: canvasHeight - mainH },
    };
  }
  const mainW = Math.ceil(canvasWidth / 2);
  return {
    main: { x: 0, y: 0, w: mainW, h: canvasHeight },
    second: { x: mainW, y: 0, w: canvasWidth - mainW, h: canvasHeight },
  };
}

/** A tile rect in canvas pixels → the item's `frameRect` (percentages of canvas). */
export function frameRectForTile(tile: RectPx, canvasWidth: number, canvasHeight: number): FrameRect {
  return {
    x: (tile.x / canvasWidth) * 100,
    y: (tile.y / canvasHeight) * 100,
    w: (tile.w / canvasWidth) * 100,
    h: (tile.h / canvasHeight) * 100,
  };
}

/**
 * The item geometry patch that makes an item fill `tile` exactly:
 * `frameRect` carries the box (the compositor's one extension — see
 * the header for the impossibility proof for position/scale alone),
 * `position` is kept at the tile's centre and `scale` at the tile's
 * width fraction so every other reader of those fields (selection
 * bounds fallbacks, inspector readouts) stays consistent with what
 * is drawn. No source dimensions are needed: the source side of the
 * fit is the compositor's cover-crop (`croppedCoverSourceRect`)
 * into this box, and focal control stays in the item's existing
 * cropZoom/cropOffset fields, which that cover-crop honours.
 */
export function tileFraming(
  tile: RectPx,
  canvasWidth: number,
  canvasHeight: number,
): { position: { x: number; y: number }; scale: number; frameRect: FrameRect } {
  const frameRect = frameRectForTile(tile, canvasWidth, canvasHeight);
  return {
    position: { x: frameRect.x + frameRect.w / 2, y: frameRect.y + frameRect.h / 2 },
    scale: tile.w / canvasWidth,
    frameRect,
  };
}

/**
 * The divider band for a split, in canvas pixels: a strip of
 * `widthPx` centred exactly on the seam, spanning the canvas's long
 * axis. Width 0 (or style 'none', handled by the caller) = an empty
 * band at the seam.
 */
export function dividerBandPx(
  canvasWidth: number,
  canvasHeight: number,
  orientation: PairOrientation,
  widthPx: number,
): RectPx {
  const w = Math.max(0, widthPx);
  if (orientation === 'stacked') {
    return { x: 0, y: canvasHeight / 2 - w / 2, w: canvasWidth, h: w };
  }
  return { x: canvasWidth / 2 - w / 2, y: 0, w, h: canvasHeight };
}

/** The short side (px) of the tile an asset would fill in a split at this canvas size. */
export function tileShortSidePx(
  canvasWidth: number,
  canvasHeight: number,
  orientation: PairOrientation,
): number {
  const { main } = splitTiles(canvasWidth, canvasHeight, orientation);
  return Math.min(main.w, main.h);
}

/**
 * The plain low-resolution warning for an import: when the asset's
 * own short side is below the short side of the tile it will fill, it
 * will be scaled up and read soft. Returns the warning line or null.
 * The size word is the asset's real short side (e.g. "480p").
 */
export function softInTileWarning(
  asset: Pick<MediaAsset, 'width' | 'height'>,
  canvasWidth: number,
  canvasHeight: number,
  orientation: PairOrientation,
): string | null {
  const w = asset.width ?? 0;
  const h = asset.height ?? 0;
  if (!(w > 0 && h > 0)) return null;
  const shortSide = Math.min(w, h);
  if (shortSide >= tileShortSidePx(canvasWidth, canvasHeight, orientation)) return null;
  return `${shortSide}p clip — will look soft in a half-screen tile`;
}

/** One receipt line for an imported asset: real size, plus duration for video. */
export function assetReceiptLine(asset: MediaAsset): string {
  const size = asset.width && asset.height ? `${asset.width}×${asset.height}` : 'size not known';
  if (asset.kind === 'video' && typeof asset.durationSeconds === 'number' && Number.isFinite(asset.durationSeconds)) {
    return `${size} · ${asset.durationSeconds.toFixed(1)}s`;
  }
  return size;
}

// ---------------------------------------------------------------------------
// Pair identification
// ---------------------------------------------------------------------------

export interface PairContext {
  /** Null only for a legacy (pre-Phase-4) pair that has not been adopted yet. */
  pairId: string | null;
  main: PairVisualItem;
  second: PairVisualItem;
  layout: PairLayout;
  orientation: PairOrientation;
  dividerStyle: PairDividerStyle;
  dividerWidthPx: number;
  matchOn: boolean;
  /** True when the pair was recognised by the legacy camera detection (no bookkeeping yet). */
  legacy: boolean;
}

function isVisualItem(item: TimelineItem): item is PairVisualItem {
  return item.type === 'video' || item.type === 'image';
}

/**
 * The pair an item belongs to, or null. Bookkeeping first (either
 * member can be selected); legacy camera pairs (R29–R31, no
 * bookkeeping) are recognised through the Phase 3 detection — a
 * camera PiP plus the main video it sits on.
 */
export function getPairContext(project: Project, item: TimelineItem): PairContext | null {
  if (!isVisualItem(item)) return null;
  const pair = item.pair;
  if (pair) {
    const partner = project.items.find(
      (i): i is PairVisualItem => i.id !== item.id && isVisualItem(i) && i.pair?.pairId === pair.pairId,
    );
    if (!partner) return null;
    const main = pair.role === 'main' ? item : partner;
    const second = pair.role === 'main' ? partner : item;
    const book = main.pair ?? second.pair!;
    return {
      pairId: pair.pairId,
      main,
      second,
      layout: book.layout,
      orientation: book.orientation ?? defaultSplitOrientation(project.canvasWidth, project.canvasHeight),
      dividerStyle: book.dividerStyle,
      dividerWidthPx: book.dividerWidthPx,
      matchOn: book.matchOn === true,
      legacy: false,
    };
  }
  // Legacy camera pair detection (Phase 3 helpers — reused, not duplicated).
  // Two locals for the same item: the type guard below narrows its
  // variable, and the main-clip branch must still be able to see a
  // video item afterwards.
  const pipCandidate: PairVisualItem = item;
  const mainCandidate: PairVisualItem = item;
  if (isCameraPipItem(pipCandidate)) {
    const main = findPairMainVideo(project, pipCandidate);
    if (!main) return null;
    return {
      pairId: null,
      main,
      second: pipCandidate,
      layout: 'pip',
      orientation: defaultSplitOrientation(project.canvasWidth, project.canvasHeight),
      dividerStyle: 'none',
      dividerWidthPx: 0,
      matchOn: false,
      legacy: true,
    };
  }
  if (mainCandidate.type === 'video' && !isPipItem(mainCandidate)) {
    const pip = project.items.find(
      (i): i is VideoTimelineItem => i.type === 'video' && isCameraPipItem(i) && findPairMainVideo(project, i)?.id === mainCandidate.id,
    );
    if (pip) {
      return {
        pairId: null,
        main: mainCandidate,
        second: pip,
        layout: 'pip',
        orientation: defaultSplitOrientation(project.canvasWidth, project.canvasHeight),
        dividerStyle: 'none',
        dividerWidthPx: 0,
        matchOn: false,
        legacy: true,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layout application (placement + panel switches share this one path)
// ---------------------------------------------------------------------------

export interface ApplyPairLayoutOptions {
  layout: PairLayout;
  orientation?: PairOrientation;
  dividerStyle?: PairDividerStyle;
  dividerWidthPx?: number;
}

/** The bookkeeping stamp for one member, preserving its own nudge/match state. */
function pairStamp(
  item: PairVisualItem,
  base: Omit<PairSettings, 'role'>,
  role: PairSettings['role'],
): PairSettings {
  const stamp: PairSettings = { ...base, role };
  const ownNudge = item.pair?.syncNudgeFrames ?? (item.type === 'video' ? item.pip?.syncNudgeFrames : undefined);
  if (ownNudge !== undefined) stamp.syncNudgeFrames = ownNudge;
  if (item.pair?.preMatchGrade !== undefined) stamp.preMatchGrade = item.pair.preMatchGrade;
  return stamp;
}

/**
 * Write a pair's bookkeeping onto both items AND lay them out: one
 * call = the whole arrangement (used at placement time and by the
 * Pair panel's layout switch, so the two can never disagree). Split:
 * both items get their tile's `tileFraming` patch; a video second
 * stops being a PiP (it is a tile now — its nudge bookkeeping lives
 * in `pair`). PiP: the main goes full frame; the second keeps the
 * PiP geometry it already has, or — coming from a split, where it
 * has none — gets the pair PiP default (rounded, source-aspect, the
 * camera pair's framing); an image second goes to the corner overlay
 * placement the overlay import path uses. Timing, trims, grades and
 * each item's own nudge counter are never touched.
 */
export function applyPairLayout(
  project: Project,
  mainId: string,
  secondId: string,
  options: ApplyPairLayoutOptions,
): Project {
  const main = project.items.find((i): i is PairVisualItem => i.id === mainId && isVisualItem(i));
  const second = project.items.find((i): i is PairVisualItem => i.id === secondId && isVisualItem(i));
  if (!main || !second) return project;
  const pairId = main.pair?.pairId ?? second.pair?.pairId ?? generateTimelineId('pair');
  const orientation =
    options.orientation ??
    main.pair?.orientation ??
    second.pair?.orientation ??
    defaultSplitOrientation(project.canvasWidth, project.canvasHeight);
  const base: Omit<PairSettings, 'role'> = {
    pairId,
    layout: options.layout,
    orientation,
    dividerStyle: options.dividerStyle ?? main.pair?.dividerStyle ?? second.pair?.dividerStyle ?? PAIR_DIVIDER_DEFAULT_STYLE,
    dividerWidthPx:
      options.dividerWidthPx ?? main.pair?.dividerWidthPx ?? second.pair?.dividerWidthPx ?? PAIR_DIVIDER_DEFAULT_WIDTH_PX,
    matchOn: main.pair?.matchOn ?? second.pair?.matchOn ?? false,
  };

  let next = project;
  if (options.layout === 'split') {
    const tiles = splitTiles(project.canvasWidth, project.canvasHeight, orientation);
    next = updateItem(next, main.id, {
      ...tileFraming(tiles.main, project.canvasWidth, project.canvasHeight),
      pair: pairStamp(main, base, 'main'),
    });
    const secondPatch: Record<string, unknown> = {
      ...tileFraming(tiles.second, project.canvasWidth, project.canvasHeight),
      pair: pairStamp(second, base, 'second'),
    };
    if (second.type === 'video') secondPatch.pip = undefined;
    next = updateItem(next, second.id, secondPatch);
    return next;
  }

  // Corner PiP.
  next = updateItem(next, main.id, {
    position: { x: 50, y: 50 },
    scale: 1,
    frameRect: undefined,
    pair: pairStamp(main, base, 'main'),
  });
  if (second.type === 'video' && second.pip?.isPip) {
    // Already a PiP (the camera pair's placement, or a previous PiP
    // arrangement): geometry stays exactly as it is.
    next = updateItem(next, second.id, { frameRect: undefined, pair: pairStamp(second, base, 'second') });
  } else if (second.type === 'video') {
    next = updateItem(next, second.id, {
      position: { x: 82, y: 78 },
      scale: 0.32,
      frameRect: undefined,
      pip: {
        shape: 'rounded',
        borderWidth: 4,
        borderColor: '#FFFFFF',
        shadow: true,
        isPip: true,
        fit: 'source',
      },
      pair: pairStamp(second, base, 'second'),
    });
  } else {
    next = updateItem(next, second.id, {
      position: { x: 82, y: 78 },
      scale: 0.32,
      frameRect: undefined,
      pair: pairStamp(second, base, 'second'),
    });
  }
  return next;
}

/** Panel entry: switch a pair's layout (adopting a legacy pair by writing its bookkeeping first). */
export function setPairLayout(
  project: Project,
  context: PairContext,
  layout: PairLayout,
  orientation?: PairOrientation,
): Project {
  return applyPairLayout(project, context.main.id, context.second.id, {
    layout,
    orientation: orientation ?? context.orientation,
    dividerStyle: context.dividerStyle,
    dividerWidthPx: context.dividerWidthPx,
  });
}

/** Panel entry: set the pair's divider (style + width), adopting a legacy pair if needed. */
export function setPairDivider(
  project: Project,
  context: PairContext,
  style: PairDividerStyle,
  widthPx: number,
): Project {
  let next = project;
  if (context.legacy) next = setPairLayout(next, context, context.layout);
  const width = Math.max(0, Math.min(PAIR_DIVIDER_MAX_WIDTH_PX, Math.round(widthPx)));
  for (const member of [context.main, context.second]) {
    const current = next.items.find((i) => i.id === member.id);
    if (current && isVisualItem(current) && current.pair) {
      next = updateItem(next, current.id, {
        pair: { ...current.pair, dividerStyle: style, dividerWidthPx: width },
      });
    }
  }
  return next;
}

/**
 * Panel entry: swap the two tiles/roles. Each clip keeps its own
 * timing, trim and sound — only the arrangement trades places (the
 * `swapMainAndPip` precedent). For a PiP pair of two videos the swap
 * itself is `swapMainAndPip`; the pair roles are then re-stamped.
 * Every other combination re-runs the layout with the roles
 * exchanged (split), or exchanges the two items' placement fields
 * directly (PiP with an image member).
 */
export function swapPairTiles(project: Project, context: PairContext): Project {
  const { main, second } = context;
  if (context.layout === 'split') {
    let next = applyPairLayout(project, second.id, main.id, {
      layout: 'split',
      orientation: context.orientation,
      dividerStyle: context.dividerStyle,
      dividerWidthPx: context.dividerWidthPx,
    });
    // Stacking follows the role: the new main tile takes the old
    // main's zIndex and vice versa.
    next = updateItem(next, second.id, { zIndex: main.zIndex });
    next = updateItem(next, main.id, { zIndex: second.zIndex });
    return next;
  }
  if (main.type === 'video' && second.type === 'video' && isPipItem(second)) {
    let next = swapMainAndPip(project, second.id);
    // swapMainAndPip traded pip/position/scale/zIndex; re-stamp roles.
    const newMain = next.items.find((i) => i.id === second.id);
    const newSecond = next.items.find((i) => i.id === main.id);
    if (newMain && newSecond && isVisualItem(newMain) && isVisualItem(newSecond)) {
      next = applyPairLayout(next, newMain.id, newSecond.id, {
        layout: 'pip',
        orientation: context.orientation,
        dividerStyle: context.dividerStyle,
        dividerWidthPx: context.dividerWidthPx,
      });
    }
    return next;
  }
  // PiP with an image member: exchange placement fields, then roles.
  let next = updateItem(project, main.id, {
    position: { ...second.position },
    scale: second.scale,
    frameRect: second.frameRect,
    zIndex: second.zIndex,
  });
  next = updateItem(next, second.id, {
    position: { ...main.position },
    scale: main.scale,
    frameRect: main.frameRect,
    zIndex: main.zIndex,
  });
  const base: Omit<PairSettings, 'role'> = {
    pairId: context.pairId ?? generateTimelineId('pair'),
    layout: 'pip',
    orientation: context.orientation,
    dividerStyle: context.dividerStyle,
    dividerWidthPx: context.dividerWidthPx,
    matchOn: context.matchOn,
  };
  // Trading places also trades PiP-ness: a video that becomes the
  // main stops being a PiP; a video that becomes the second gains
  // the pair PiP default (an image member simply trades placement).
  const tradedMain = next.items.find((i): i is PairVisualItem => i.id === second.id && isVisualItem(i));
  if (tradedMain && tradedMain.type === 'video' && tradedMain.pip) {
    next = updateItem(next, tradedMain.id, { pip: undefined });
  }
  const tradedSecond = next.items.find((i): i is PairVisualItem => i.id === main.id && isVisualItem(i));
  if (tradedSecond && tradedSecond.type === 'video' && !tradedSecond.pip) {
    next = updateItem(next, tradedSecond.id, {
      pip: { shape: 'rounded', borderWidth: 4, borderColor: '#FFFFFF', shadow: true, isPip: true, fit: 'source' },
    });
  }
  const swappedMain = next.items.find((i): i is PairVisualItem => i.id === second.id && isVisualItem(i));
  const swappedSecond = next.items.find((i): i is PairVisualItem => i.id === main.id && isVisualItem(i));
  if (swappedMain) next = updateItem(next, swappedMain.id, { pair: pairStamp(swappedMain, base, 'main') });
  if (swappedSecond) next = updateItem(next, swappedSecond.id, { pair: pairStamp(swappedSecond, base, 'second') });
  return next;
}

// ---------------------------------------------------------------------------
// Audio balance presets
// ---------------------------------------------------------------------------

/** Pair audio balance presets: the two clips' volumes (mute flags untouched). */
export const PAIR_BALANCE_PRESETS = {
  scene: { label: 'Scene', main: 1.0, second: 0.25 },
  equal: { label: 'Equal', main: 0.8, second: 0.8 },
  you: { label: 'You', main: 0.25, second: 1.0 },
} as const;

export type PairBalancePresetId = keyof typeof PAIR_BALANCE_PRESETS;

/** Apply a balance preset to a pair's video members (images carry no volume). */
export function applyPairBalance(
  project: Project,
  context: PairContext,
  presetId: PairBalancePresetId,
): Project {
  const preset = PAIR_BALANCE_PRESETS[presetId];
  let next = project;
  if (context.main.type === 'video') next = updateItem(next, context.main.id, { volume: preset.main });
  if (context.second.type === 'video') next = updateItem(next, context.second.id, { volume: preset.second });
  return next;
}

// ---------------------------------------------------------------------------
// Sync nudge (pair bookkeeping) + the placement-time suggestion
// ---------------------------------------------------------------------------

/**
 * The pair version of `pipSyncNudgePatch`: the SAME translation (the
 * second item's start/end shift together, source window untouched),
 * the SAME cumulative clamp (±PIP_SYNC_NUDGE_MAX_FRAMES) and the SAME
 * never-before-zero rule — but the counter lives in the pair
 * bookkeeping, so it works for a split tile, which is not a PiP. When
 * the item IS also a PiP, its `pip.syncNudgeFrames` is kept equal.
 */
export function pairSyncNudgePatch(
  item: PairVisualItem,
  deltaFrames: number,
  frameRate: number,
): Partial<VideoTimelineItem> & Partial<ImageTimelineItem> {
  const fps = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : 30;
  const frameSeconds = 1 / fps;
  const current = item.pair?.syncNudgeFrames ?? (item.type === 'video' ? item.pip?.syncNudgeFrames : undefined) ?? 0;
  const wanted = Math.max(
    -PIP_SYNC_NUDGE_MAX_FRAMES,
    Math.min(PIP_SYNC_NUDGE_MAX_FRAMES, current + Math.trunc(deltaFrames)),
  );
  let shiftSeconds = (wanted - current) * frameSeconds;
  if (item.startTime + shiftSeconds < 0) shiftSeconds = -item.startTime;
  const appliedFrames = Math.round(shiftSeconds / frameSeconds);
  const total = current + appliedFrames;
  const patch: Partial<VideoTimelineItem> & Partial<ImageTimelineItem> = {
    startTime: item.startTime + shiftSeconds,
    endTime: item.endTime + shiftSeconds,
  };
  if (item.pair) patch.pair = { ...item.pair, syncNudgeFrames: total };
  if (item.type === 'video' && item.pip) {
    (patch as Partial<VideoTimelineItem>).pip = { ...item.pip, syncNudgeFrames: total };
  }
  return patch;
}

/**
 * The placement-time sync suggestion for a CAMERA pair. The head
 * trims (`dualAlignmentTrims`) already consumed the measured start
 * delta, so a residual signal exists only when the two FILES'
 * durations differ measurably — equal-length files carry none and
 * suggest 0 (which is also what keeps the R29–R31 placement
 * byte-identical for the common case). When they do differ, the
 * estimate anchors on the pair's common stop: a second file longer
 * than the delta explains must have started earlier than the trims
 * assumed, so its content lags and the suggestion shifts it EARLIER
 * (negative frames); a shorter second suggests later (positive).
 * Sign convention: exactly `pipSyncNudgePatch`'s — positive frames
 * shift the second item later on the timeline, negative earlier.
 * Clamped to the same ±15-frame cap the panel enforces; an implied
 * offset under one frame is 0.
 */
export function suggestedNudgeFrames(
  mainDuration: number,
  secondDuration: number,
  startDeltaMs: number,
  fps: number,
): number {
  const rate = Number.isFinite(fps) && fps > 0 ? fps : 30;
  if (!Number.isFinite(mainDuration) || !Number.isFinite(secondDuration)) return 0;
  const durationDiff = mainDuration - secondDuration;
  // No measurable duration difference → the trims left no residual.
  if (Math.abs(durationDiff) * rate < 1) return 0;
  const nudgeSeconds = durationDiff - startDeltaMs / 1000;
  const frames = nudgeSeconds * rate;
  if (Math.abs(frames) < 1) return 0;
  return Math.max(-PIP_SYNC_NUDGE_MAX_FRAMES, Math.min(PIP_SYNC_NUDGE_MAX_FRAMES, Math.round(frames)));
}
