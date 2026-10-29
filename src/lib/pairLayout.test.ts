import { describe, it, expect } from 'vitest';
import { createDefaultProject } from './projects/persistence';
import { appendDualCaptureToTimeline, appendMediaToTimeline, placeImportPair } from './timeline/insert';
import { updateItem } from './timeline/utils';
import { pipSyncNudgePatch } from './pip';
import { croppedCoverSourceRect, frameRectBoxPx, getItemBoundsPercent } from './render/compositor';
import {
  applyPairBalance,
  applyPairLayout,
  assetReceiptLine,
  defaultSplitOrientation,
  dividerBandPx,
  getPairContext,
  pairSyncNudgePatch,
  setPairDivider,
  setPairLayout,
  softInTileWarning,
  splitTiles,
  suggestedNudgeFrames,
  swapPairTiles,
  tileFraming,
} from './pairLayout';
import type { MediaAsset, Project, VideoTimelineItem } from '../types/timeline';

function videoAsset(id: string, durationSeconds = 12, width = 1920, height = 1080): MediaAsset {
  return {
    id, kind: 'video', storageUrl: `https://x.test/${id}.mp4`, fileName: `${id}.mp4`,
    sizeBytes: 1, mimeType: 'video/mp4', durationSeconds, width, height, createdAt: 0,
  };
}
function imageAsset(id: string, width = 1920, height = 1080): MediaAsset {
  return {
    id, kind: 'image', storageUrl: `https://x.test/${id}.png`, fileName: `${id}.png`,
    sizeBytes: 1, mimeType: 'image/png', width, height, createdAt: 0,
  };
}
function project(w = 1080, h = 1920): Project {
  return createDefaultProject('u1', 'test', w, h);
}
function videoItem(p: Project, assetId: string): VideoTimelineItem {
  const item = p.items.find((i) => i.type === 'video' && i.mediaAssetId === assetId);
  if (!item || item.type !== 'video') throw new Error(`no video item for ${assetId}`);
  return item;
}

describe('splitTiles + defaultSplitOrientation', () => {
  it('portrait stacks: two 1080x960 tiles on 1080x1920', () => {
    const { main, second } = splitTiles(1080, 1920, 'stacked');
    expect(main).toEqual({ x: 0, y: 0, w: 1080, h: 960 });
    expect(second).toEqual({ x: 0, y: 960, w: 1080, h: 960 });
  });
  it('landscape goes side by side: two 960x1080 tiles on 1920x1080', () => {
    const { main, second } = splitTiles(1920, 1080, 'side');
    expect(main).toEqual({ x: 0, y: 0, w: 960, h: 1080 });
    expect(second).toEqual({ x: 960, y: 0, w: 960, h: 1080 });
  });
  it('odd canvas sizes still tile the canvas exactly (main takes the extra pixel)', () => {
    const { main, second } = splitTiles(1080, 1921, 'stacked');
    expect(main.h + second.h).toBe(1921);
    expect(main.y + main.h).toBe(second.y);
  });
  it('defaults: portrait and square stack, landscape sides, 4:5 stacks', () => {
    expect(defaultSplitOrientation(1080, 1920)).toBe('stacked');
    expect(defaultSplitOrientation(1080, 1080)).toBe('stacked');
    expect(defaultSplitOrientation(1080, 1350)).toBe('stacked'); // 4:5
    expect(defaultSplitOrientation(1920, 1080)).toBe('side');
  });
});

describe('tileFraming + dividerBandPx', () => {
  it('tileFraming expresses the tile as frameRect % + centre position', () => {
    const patch = tileFraming({ x: 0, y: 960, w: 1080, h: 960 }, 1080, 1920);
    expect(patch.frameRect).toEqual({ x: 0, y: 50, w: 100, h: 50 });
    expect(patch.position).toEqual({ x: 50, y: 75 });
    expect(patch.scale).toBe(1);
  });
  it('divider band is centred on the seam at the configured width', () => {
    expect(dividerBandPx(1080, 1920, 'stacked', 4)).toEqual({ x: 0, y: 958, w: 1080, h: 4 });
    expect(dividerBandPx(1920, 1080, 'side', 8)).toEqual({ x: 956, y: 0, w: 8, h: 1080 });
    expect(dividerBandPx(1080, 1920, 'stacked', 0).h).toBe(0);
  });
});

describe('suggestedNudgeFrames — sign convention vs pipSyncNudgePatch', () => {
  it('equal-length files suggest 0 whatever the start delta (trims already consumed it)', () => {
    expect(suggestedNudgeFrames(12, 12, 200, 30)).toBe(0);
    expect(suggestedNudgeFrames(12, 12, -150, 30)).toBe(0);
    expect(suggestedNudgeFrames(12, 12, 0, 30)).toBe(0);
  });
  it('a sub-frame duration difference suggests 0', () => {
    expect(suggestedNudgeFrames(10, 10.01, 0, 30)).toBe(0);
  });
  it('a longer second file suggests EARLIER (negative); a shorter one suggests LATER (positive)', () => {
    expect(suggestedNudgeFrames(10, 10.2, 0, 30)).toBe(-6);
    expect(suggestedNudgeFrames(10.2, 10, 0, 30)).toBe(6);
  });
  it('clamps to the same ±15 frames the panel enforces', () => {
    expect(suggestedNudgeFrames(10, 12, 0, 30)).toBe(-15);
    expect(suggestedNudgeFrames(12, 10, 0, 30)).toBe(15);
  });
  it('the suggestion, applied through pipSyncNudgePatch, moves the overlay in the signed direction', () => {
    // Build a real PiP item, then apply suggestions as patches.
    const p = appendDualCaptureToTimeline(project(), videoAsset('m'), videoAsset('f'), { startDeltaMs: 0 });
    const pip = videoItem(p, 'f');
    const later = pipSyncNudgePatch(pip, suggestedNudgeFrames(10.2, 10, 0, 30), 30);
    expect(later.startTime! - pip.startTime).toBeCloseTo(6 / 30, 5);
    expect(later.pip?.syncNudgeFrames).toBe(6);
    const earlierBase = { ...pip, startTime: 5, endTime: 17 };
    const earlier = pipSyncNudgePatch(earlierBase, suggestedNudgeFrames(10, 10.2, 0, 30), 30);
    expect(earlier.startTime! - 5).toBeCloseTo(-6 / 30, 5);
    expect(earlier.pip?.syncNudgeFrames).toBe(-6);
  });
});

describe('pairSyncNudgePatch', () => {
  it('mirrors the PiP patch: cumulative clamp, never before zero, counters kept equal', () => {
    const p = placeImportPair(project(), videoAsset('a'), videoAsset('b'), { layout: 'split' });
    const second = videoItem(p, 'b');
    const patch = pairSyncNudgePatch({ ...second, startTime: 5, endTime: 17 }, 20, 30);
    expect(patch.pair?.syncNudgeFrames).toBe(15);
    expect(patch.startTime).toBeCloseTo(5.5, 5);
    const clamped = pairSyncNudgePatch({ ...second, startTime: 0.1, endTime: 12.1 }, -15, 30);
    expect(clamped.startTime).toBe(0);
    expect(clamped.pair?.syncNudgeFrames).toBe(-3); // only the frames that fit are counted
  });
});

describe('appendDualCaptureToTimeline — Phase 4 layouts', () => {
  it('default (no layout) is byte-identical to layout pip in geometry, plus bookkeeping', () => {
    const strip = (p: Project) =>
      p.items.map((i) => {
        const { pair: _pair, id: _id, trackId: _trackId, ...rest } = i as VideoTimelineItem;
        return rest;
      });
    const a = appendDualCaptureToTimeline(project(), videoAsset('m'), videoAsset('f'), { startDeltaMs: 200 });
    const b = appendDualCaptureToTimeline(project(), videoAsset('m'), videoAsset('f'), {
      startDeltaMs: 200,
      layout: 'pip',
    });
    expect(strip(a)).toEqual(strip(b));
    const main = videoItem(b, 'm');
    const pip = videoItem(b, 'f');
    expect(main.pair?.role).toBe('main');
    expect(pip.pair?.role).toBe('second');
    expect(main.pair?.pairId).toBe(pip.pair?.pairId);
    expect(pip.pair?.layout).toBe('pip');
    expect(pip.startTime).toBe(main.startTime);
  });

  it('split: both clips become equal tiles with shared bookkeeping, white 4px divider', () => {
    const p = appendDualCaptureToTimeline(project(), videoAsset('m'), videoAsset('f'), {
      startDeltaMs: 0,
      layout: 'split',
    });
    const main = videoItem(p, 'm');
    const second = videoItem(p, 'f');
    expect(main.frameRect).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(second.frameRect).toEqual({ x: 0, y: 50, w: 100, h: 50 });
    expect(second.pip).toBeUndefined();
    expect(second.startTime).toBe(main.startTime);
    expect(second.muted).toBe(false);
    expect(main.pair?.layout).toBe('split');
    expect(main.pair?.dividerStyle).toBe('white');
    expect(main.pair?.dividerWidthPx).toBe(4);
    expect(main.pair?.pairId).toBe(second.pair?.pairId);
  });

  it('split: the suggested nudge is applied as the initial pair nudge when durations differ', () => {
    let p = project();
    p = appendMediaToTimeline(p, videoAsset('intro', 5));
    p = appendDualCaptureToTimeline(p, videoAsset('m', 10), videoAsset('f', 11), {
      startDeltaMs: 0,
      layout: 'split',
    });
    const main = videoItem(p, 'm');
    const second = videoItem(p, 'f');
    // Second file 1s longer → suggestion −15 frames → second starts half a second earlier.
    expect(main.startTime).toBeCloseTo(5, 5);
    expect(second.startTime).toBeCloseTo(4.5, 5);
    expect(second.pair?.syncNudgeFrames).toBe(-15);
  });
});

describe('placeImportPair', () => {
  it('video + image split: the image holds for the video duration; both tiled at the same start', () => {
    const p = placeImportPair(project(), videoAsset('v', 8), imageAsset('img'), { layout: 'split' });
    const v = videoItem(p, 'v');
    const img = p.items.find((i) => i.type === 'image');
    if (!img || img.type !== 'image') throw new Error('expected image item');
    expect(img.startTime).toBe(v.startTime);
    expect(img.endTime - img.startTime).toBeCloseTo(8, 5);
    expect(v.frameRect).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(img.frameRect).toEqual({ x: 0, y: 50, w: 100, h: 50 });
    expect(img.pair?.pairId).toBe(v.pair?.pairId);
  });
  it('two images use the 5s image default; two videos keep their own durations but start together', () => {
    const p1 = placeImportPair(project(), imageAsset('i1'), imageAsset('i2'), { layout: 'split' });
    for (const item of p1.items) expect(item.endTime - item.startTime).toBeCloseTo(5, 5);
    const p2 = placeImportPair(project(), videoAsset('v1', 6), videoAsset('v2', 9), { layout: 'split' });
    const v1 = videoItem(p2, 'v1');
    const v2 = videoItem(p2, 'v2');
    expect(v1.startTime).toBe(v2.startTime);
    expect(v1.endTime - v1.startTime).toBeCloseTo(6, 5);
    expect(v2.endTime - v2.startTime).toBeCloseTo(9, 5);
  });
  it('pip layout: the second video becomes a muted PiP; a balance preset applies only when passed', () => {
    const plain = placeImportPair(project(), videoAsset('v1'), videoAsset('v2'), { layout: 'pip' });
    const second = videoItem(plain, 'v2');
    expect(second.pip?.isPip).toBe(true);
    expect(second.muted).toBe(true);
    expect(videoItem(plain, 'v1').volume).toBe(1);
    expect(second.volume).toBe(1);
    const balanced = placeImportPair(project(), videoAsset('v1'), videoAsset('v2'), {
      layout: 'pip',
      balancePreset: 'you',
    });
    expect(videoItem(balanced, 'v1').volume).toBe(0.25);
    expect(videoItem(balanced, 'v2').volume).toBe(1);
    expect(videoItem(balanced, 'v2').muted).toBe(true); // preset never touches mute flags
  });
  it('rejects audio assets', () => {
    const audio: MediaAsset = {
      id: 'au', kind: 'audio', storageUrl: 'https://x.test/a.mp3', fileName: 'a.mp3',
      sizeBytes: 1, mimeType: 'audio/mpeg', durationSeconds: 5, createdAt: 0,
    };
    expect(() => placeImportPair(project(), audio, videoAsset('v'), { layout: 'split' })).toThrow();
  });
});

describe('pair panel transforms (layout switch, swap, divider, balance)', () => {
  it('layout switch pip → split → pip round-trips geometry through the bookkeeping', () => {
    let p = placeImportPair(project(), videoAsset('v1'), videoAsset('v2'), { layout: 'pip' });
    const ctx = getPairContext(p, videoItem(p, 'v1'))!;
    p = setPairLayout(p, ctx, 'split');
    expect(videoItem(p, 'v2').frameRect).toEqual({ x: 0, y: 50, w: 100, h: 50 });
    expect(videoItem(p, 'v2').pip).toBeUndefined();
    const ctx2 = getPairContext(p, videoItem(p, 'v2'))!;
    expect(ctx2.layout).toBe('split');
    p = setPairLayout(p, ctx2, 'pip');
    const back = videoItem(p, 'v2');
    expect(back.pip?.isPip).toBe(true);
    expect(back.frameRect).toBeUndefined();
    expect(videoItem(p, 'v1').scale).toBe(1);
  });
  it('swap in split exchanges the tiles (roles + frameRects trade, timing stays)', () => {
    let p = placeImportPair(project(), videoAsset('v1', 6), videoAsset('v2', 9), { layout: 'split' });
    const ctx = getPairContext(p, videoItem(p, 'v1'))!;
    p = swapPairTiles(p, ctx);
    const v1 = videoItem(p, 'v1');
    const v2 = videoItem(p, 'v2');
    expect(v1.frameRect).toEqual({ x: 0, y: 50, w: 100, h: 50 });
    expect(v2.frameRect).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(v1.pair?.role).toBe('second');
    expect(v2.pair?.role).toBe('main');
    expect(v1.endTime - v1.startTime).toBeCloseTo(6, 5);
  });
  it('swap in a video PiP pair trades roles via the main/PiP swap', () => {
    let p = appendDualCaptureToTimeline(project(), videoAsset('m'), videoAsset('f'), { startDeltaMs: 0 });
    const ctx = getPairContext(p, videoItem(p, 'f'))!;
    p = swapPairTiles(p, ctx);
    const m = videoItem(p, 'm');
    const f = videoItem(p, 'f');
    expect(f.pip).toBeUndefined();
    expect(f.pair?.role).toBe('main');
    expect(m.pip?.isPip).toBe(true);
    expect(m.pair?.role).toBe('second');
  });
  it('swap in a PiP pair with an image main trades PiP-ness with the place', () => {
    let p = placeImportPair(project(), imageAsset('img'), videoAsset('v'), { layout: 'pip' });
    const ctx = getPairContext(p, videoItem(p, 'v'))!;
    p = swapPairTiles(p, ctx);
    const v = videoItem(p, 'v');
    const img = p.items.find((i) => i.type === 'image');
    if (!img || img.type !== 'image') throw new Error('expected image item');
    expect(v.pip).toBeUndefined();
    expect(v.pair?.role).toBe('main');
    expect(v.position).toEqual({ x: 50, y: 50 });
    expect(img.pair?.role).toBe('second');
    expect(img.position).toEqual({ x: 82, y: 78 }); // traded into the corner the video held
  });
  it('divider + balance write both members; mute flags untouched', () => {
    let p = placeImportPair(project(), videoAsset('v1'), videoAsset('v2'), { layout: 'split' });
    const ctx = getPairContext(p, videoItem(p, 'v1'))!;
    p = setPairDivider(p, ctx, 'gold', 8);
    expect(videoItem(p, 'v1').pair?.dividerStyle).toBe('gold');
    expect(videoItem(p, 'v2').pair?.dividerWidthPx).toBe(8);
    p = applyPairBalance(p, getPairContext(p, videoItem(p, 'v1'))!, 'scene');
    expect(videoItem(p, 'v1').volume).toBe(1);
    expect(videoItem(p, 'v2').volume).toBe(0.25);
    expect(videoItem(p, 'v2').muted).toBe(false);
    p = applyPairBalance(p, getPairContext(p, videoItem(p, 'v1'))!, 'equal');
    expect(videoItem(p, 'v1').volume).toBe(0.8);
    expect(videoItem(p, 'v2').volume).toBe(0.8);
  });
  it('a legacy camera pair (bookkeeping stripped) is detected and adopted on first switch', () => {
    let p = appendDualCaptureToTimeline(project(), videoAsset('m'), videoAsset('f'), { startDeltaMs: 0 });
    // Simulate an R29–R31 project: no pair bookkeeping anywhere.
    for (const item of [...p.items]) {
      p = updateItem(p, item.id, { pair: undefined });
    }
    const ctx = getPairContext(p, videoItem(p, 'f'));
    expect(ctx?.legacy).toBe(true);
    expect(ctx?.layout).toBe('pip');
    p = setPairLayout(p, ctx!, 'split');
    expect(videoItem(p, 'f').pair?.layout).toBe('split');
    expect(videoItem(p, 'f').frameRect).toEqual({ x: 0, y: 50, w: 100, h: 50 });
  });
  it('applyPairLayout preserves an existing camera PiP geometry exactly (stamp only)', () => {
    const before = appendDualCaptureToTimeline(project(), videoAsset('m'), videoAsset('f'), { startDeltaMs: 0 });
    const pipBefore = videoItem(before, 'f');
    const after = applyPairLayout(before, videoItem(before, 'm').id, pipBefore.id, { layout: 'pip' });
    const pipAfter = videoItem(after, 'f');
    expect(pipAfter.position).toEqual(pipBefore.position);
    expect(pipAfter.scale).toBe(pipBefore.scale);
    expect(pipAfter.pip).toEqual(pipBefore.pip);
  });
});

describe('import receipt + soft-tile warning', () => {
  it('warns with the real short side when the asset is smaller than its tile', () => {
    // Stacked tile on 1080x1920 is 1080x960 (short side 960).
    expect(softInTileWarning({ width: 854, height: 480 }, 1080, 1920, 'stacked')).toBe(
      '480p clip — will look soft in a half-screen tile',
    );
    expect(softInTileWarning({ width: 1920, height: 1080 }, 1080, 1920, 'stacked')).toBeNull();
    expect(softInTileWarning({ width: undefined, height: undefined }, 1080, 1920, 'stacked')).toBeNull();
  });
  it('receipt line carries real size + duration', () => {
    expect(assetReceiptLine(videoAsset('v', 8.25))).toBe('1920×1080 · 8.3s');
    expect(assetReceiptLine(imageAsset('i'))).toBe('1920×1080');
  });
});

// ---------------------------------------------------------------------------
// PIXEL PROOF — the R22 occupancy approach, extended: geometry asserted
// through the compositor's own shared functions (getItemBoundsPercent /
// frameRectBoxPx for boxes, croppedCoverSourceRect for the source fit),
// on projects built by the REAL placement functions.
// ---------------------------------------------------------------------------
describe('PIXEL PROOF — split placements fill the canvas exactly', () => {
  const formats: Array<[number, number]> = [
    [1080, 1920],
    [1920, 1080],
    [1080, 1080],
  ];
  for (const [w, h] of formats) {
    it(`${w}x${h}: tiles union = full canvas, intersection = empty, divider band = configured width at the seam`, () => {
      const p = placeImportPair(project(w, h), videoAsset('a'), videoAsset('b'), { layout: 'split' });
      const items = [videoItem(p, 'a'), videoItem(p, 'b')];
      const rects = items.map((item) => {
        const bounds = getItemBoundsPercent(item, 'video', w, h);
        return {
          x: (bounds.leftPercent / 100) * w,
          y: (bounds.topPercent / 100) * h,
          w: (bounds.widthPercent / 100) * w,
          h: (bounds.heightPercent / 100) * h,
        };
      });
      // The compositor's frameRect box agrees with the bounds helper.
      const boxA = frameRectBoxPx(items[0].frameRect!, w, h);
      expect(boxA.w).toBeCloseTo(rects[0].w, 5);
      expect(boxA.h).toBeCloseTo(rects[0].h, 5);
      const [r1, r2] = rects;
      const unionArea = r1.w * r1.h + r2.w * r2.h;
      const overlapW = Math.max(0, Math.min(r1.x + r1.w, r2.x + r2.w) - Math.max(r1.x, r2.x));
      const overlapH = Math.max(0, Math.min(r1.y + r1.h, r2.y + r2.h) - Math.max(r1.y, r2.y));
      expect(overlapW * overlapH).toBe(0); // tiles never overlap
      expect(unionArea).toBe(w * h); // and together cover the canvas exactly
      // Divider: the only double-painted band — configured width,
      // centred on the seam, inside the union.
      const orientation = items[0].pair!.orientation!;
      const band = dividerBandPx(w, h, orientation, items[0].pair!.dividerWidthPx);
      if (orientation === 'stacked') {
        expect(band.h).toBe(4);
        expect(band.y + band.h / 2).toBe(h / 2);
        expect(band.x).toBe(0);
        expect(band.w).toBe(w);
      } else {
        expect(band.w).toBe(4);
        expect(band.x + band.w / 2).toBe(w / 2);
      }
      // Divider none → zero-width band.
      const none = dividerBandPx(w, h, orientation, 0);
      expect(none.w * none.h).toBe(0);
    });

    it(`${w}x${h}: a 16:9 and a 9:16 source each cover-fill their tile (no letterbox gap)`, () => {
      const orientation = defaultSplitOrientation(w, h);
      const tiles = splitTiles(w, h, orientation);
      for (const [srcW, srcH] of [[1920, 1080], [1080, 1920]] as const) {
        for (const tile of [tiles.main, tiles.second]) {
          const s = croppedCoverSourceRect(srcW, srcH, tile.w, tile.h, undefined, undefined);
          // The drawn source rect has the TILE's aspect — drawImage
          // stretches it over the full tile, so the tile is filled
          // exactly, with no gap and no distortion.
          expect(s.sw / s.sh).toBeCloseTo(tile.w / tile.h, 4);
          expect(s.sx).toBeGreaterThanOrEqual(0);
          expect(s.sy).toBeGreaterThanOrEqual(0);
          expect(s.sx + s.sw).toBeLessThanOrEqual(srcW + 0.01);
          expect(s.sy + s.sh).toBeLessThanOrEqual(srcH + 0.01);
          // Focal zoom keeps the fill (smaller window, same aspect).
          const zoomed = croppedCoverSourceRect(srcW, srcH, tile.w, tile.h, undefined, {
            cropZoom: 2,
            cropOffsetX: 0.5,
            cropOffsetY: -0.5,
          });
          expect(zoomed.sw / zoomed.sh).toBeCloseTo(tile.w / tile.h, 4);
          expect(zoomed.sw).toBeLessThan(s.sw);
        }
      }
    });
  }
});
