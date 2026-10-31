import { describe, expect, it } from 'vitest';
import { mainSyncNudgeAtCap, mainSyncNudgePatch, MAIN_SYNC_NUDGE_MAX_FRAMES, PIP_SYNC_NUDGE_MAX_FRAMES } from './pip';
import type { VideoTimelineItem } from '../types/timeline';

/**
 * R40 P-22 — "Line up the sound" for a MAIN clip: the same frame-step
 * model as the PiP/pair nudges (pure start/end translation, cumulative
 * bookkeeping, ±15-frame cap, never before time 0).
 */

function makeMainItem(overrides: { startTime?: number; mainSyncNudgeFrames?: number } = {}): VideoTimelineItem {
  return {
    id: 'main-1',
    type: 'video',
    trackId: 'track-video',
    startTime: overrides.startTime ?? 2,
    endTime: (overrides.startTime ?? 2) + 10,
    zIndex: 0,
    visible: true,
    mediaAssetId: 'asset-1',
    position: { x: 50, y: 50 },
    scale: 1,
    rotation: 0,
    opacity: 1,
    trimStart: 0,
    trimEnd: 10,
    speed: 1,
    reverse: false,
    volume: 1,
    muted: false,
    ...(overrides.mainSyncNudgeFrames !== undefined ? { mainSyncNudgeFrames: overrides.mainSyncNudgeFrames } : {}),
  };
}

describe('mainSyncNudgePatch (R40 P-22)', () => {
  it('the main cap matches the pair cap (±15 frames)', () => {
    expect(MAIN_SYNC_NUDGE_MAX_FRAMES).toBe(15);
    expect(MAIN_SYNC_NUDGE_MAX_FRAMES).toBe(PIP_SYNC_NUDGE_MAX_FRAMES);
  });

  it('+1 frame at 30fps shifts start/end by 1/30 and counts 1 frame; the trim window is untouched', () => {
    const item = makeMainItem();
    const patch = mainSyncNudgePatch(item, 1, 30);
    expect(patch.startTime).toBeCloseTo(2 + 1 / 30, 6);
    expect(patch.endTime).toBeCloseTo(12 + 1 / 30, 6);
    expect(patch.mainSyncNudgeFrames).toBe(1);
    expect(patch.trimStart).toBeUndefined();
    expect(patch.trimEnd).toBeUndefined();
  });

  it('nudging back returns to the original position and a 0 count', () => {
    const item = makeMainItem();
    const p1 = mainSyncNudgePatch(item, 1, 30);
    const shifted = { ...item, ...p1 } as VideoTimelineItem;
    const p2 = mainSyncNudgePatch(shifted, -1, 30);
    expect(p2.startTime).toBeCloseTo(2, 6);
    expect(p2.mainSyncNudgeFrames).toBe(0);
  });

  it('the cumulative nudge clamps at +15 and −15 — no silent drift past the cap', () => {
    const at14 = makeMainItem({ mainSyncNudgeFrames: 14 });
    const patch = mainSyncNudgePatch(at14, 5, 30);
    expect(patch.mainSyncNudgeFrames).toBe(15);
    expect(patch.startTime).toBeCloseTo(2 + 1 / 30, 6);

    const atMinus14 = makeMainItem({ startTime: 5, mainSyncNudgeFrames: -14 });
    const patchNeg = mainSyncNudgePatch(atMinus14, -5, 30);
    expect(patchNeg.mainSyncNudgeFrames).toBe(-15);
  });

  it('at the cap, a further nudge in the same direction changes nothing', () => {
    const atCap = makeMainItem({ mainSyncNudgeFrames: 15 });
    const patch = mainSyncNudgePatch(atCap, 1, 30);
    expect(patch.mainSyncNudgeFrames).toBe(15);
    expect(patch.startTime).toBeCloseTo(2, 6);
    expect(mainSyncNudgeAtCap(atCap)).toBe(true);
    expect(mainSyncNudgeAtCap(makeMainItem({ mainSyncNudgeFrames: 14 }))).toBe(false);
    expect(mainSyncNudgeAtCap(makeMainItem())).toBe(false);
  });

  it('the shift never pushes the clip before time 0 — only the frames that fit are counted', () => {
    const item = makeMainItem({ startTime: 0.02 });
    const patch = mainSyncNudgePatch(item, -5, 30);
    expect(patch.startTime).toBeCloseTo(0, 6);
    expect(patch.mainSyncNudgeFrames).toBe(-1);
  });

  it('a non-positive frame rate falls back to 30fps', () => {
    const patch = mainSyncNudgePatch(makeMainItem(), 1, 0);
    expect(patch.startTime).toBeCloseTo(2 + 1 / 30, 6);
    expect(patch.mainSyncNudgeFrames).toBe(1);
  });
});
