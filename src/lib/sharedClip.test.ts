import { describe, it, expect } from 'vitest';
import { hasDifferingSharedUse, itemsSharingAsset, SHARED_CLIP_NOTE } from './sharedClip';
import type { Project, VideoTimelineItem } from '../types/timeline';

function video(id: string, patch: Partial<VideoTimelineItem> = {}): VideoTimelineItem {
  return {
    id, type: 'video', trackId: 't1', startTime: 0, endTime: 5, zIndex: 0, visible: true,
    mediaAssetId: 'asset-1',
    position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 1,
    trimStart: 0, trimEnd: 5, speed: 1, reverse: false, volume: 1, muted: false,
    ...patch,
  };
}

function project(items: Project['items']): Project {
  return {
    id: 'p1', ownerUid: 'u1', name: 'P', schemaVersion: 1,
    tracks: [], items, mediaAssets: {},
    canvasWidth: 1080, canvasHeight: 1920, frameRate: 30, createdAt: 0, updatedAt: 0,
  };
}

describe('R40 P-11 — shared-clip disclosure decision', () => {
  it('a single use never triggers it', () => {
    const item = video('a');
    expect(hasDifferingSharedUse(project([item]), item)).toBe(false);
  });

  it('different assets never trigger it', () => {
    const a = video('a');
    const b = video('b', { mediaAssetId: 'asset-2', trimStart: 3 });
    expect(hasDifferingSharedUse(project([a, b]), a)).toBe(false);
  });

  it('identical copies stacked exactly alike stay quiet', () => {
    const a = video('a');
    const b = video('b');
    expect(itemsSharingAsset(project([a, b]), a)).toHaveLength(2);
    expect(hasDifferingSharedUse(project([a, b]), a)).toBe(false);
  });

  it('a differing trim triggers it (main + overlay use)', () => {
    const a = video('a');
    const b = video('b', { trimStart: 2, trimEnd: 4, position: { x: 80, y: 80 } });
    expect(hasDifferingSharedUse(project([a, b]), a)).toBe(true);
    expect(hasDifferingSharedUse(project([a, b]), b)).toBe(true);
  });

  it('a differing speed alone triggers it', () => {
    const a = video('a');
    const b = video('b', { speed: 2 });
    expect(hasDifferingSharedUse(project([a, b]), a)).toBe(true);
  });

  it('a differing position alone triggers it', () => {
    const a = video('a');
    const b = video('b', { position: { x: 20, y: 20 } });
    expect(hasDifferingSharedUse(project([a, b]), a)).toBe(true);
  });

  it('the note is one plain line with no engine or element wording', () => {
    expect(SHARED_CLIP_NOTE).toContain('also used somewhere else');
    expect(SHARED_CLIP_NOTE).toContain('share one playback position');
    expect(SHARED_CLIP_NOTE).not.toMatch(/element|pool|asset id/i);
  });
});
