import { describe, it, expect } from 'vitest';
import {
  createEmptyProject,
  createTrack,
  addTrack,
  addItem,
  generateTimelineId,
  trimItemEnd,
  setItemDuration,
  getProjectDuration,
  projectDurationExceedsLimit,
  applyTransition,
  getBoundaryTransition,
  updateItem,
  updateItemMotion,
} from './utils';
import { MAX_MEDIA_SECONDS } from '../media/constants';
import type { ImageTimelineItem, Project } from '../../types/timeline';

/**
 * v1 cap tests — MAX_MEDIA_SECONDS (600s / 10 min) replaces the old
 * 30-second standard. `image` items are used as fixtures because their
 * duration is freely adjustable (no source-media trim window), which
 * isolates exactly the per-item cap being tested.
 */

function makeItem(overrides: Partial<ImageTimelineItem> & { trackId: string }): ImageTimelineItem {
  return {
    id: generateTimelineId('item'),
    type: 'image',
    startTime: 0,
    endTime: 5,
    zIndex: 0,
    visible: true,
    mediaAssetId: 'asset1',
    role: 'photo',
    position: { x: 50, y: 50 },
    scale: 1,
    rotation: 0,
    opacity: 1,
    ...overrides,
  };
}

function projectWithImageItem(durationSeconds: number): { project: Project; itemId: string } {
  let project = createEmptyProject({ ownerUid: 'test-uid' });
  const track = createTrack('image', 'Image', 0);
  project = addTrack(project, track);
  const item = makeItem({ trackId: track.id, startTime: 0, endTime: durationSeconds });
  project = addItem(project, item);
  return { project, itemId: item.id };
}

describe('per-item cap (trimItemEnd / setItemDuration)', () => {
  it('trimItemEnd never lets an item exceed MAX_MEDIA_SECONDS, however far the new end time is dragged', () => {
    const { project, itemId } = projectWithImageItem(5);
    const next = trimItemEnd(project, itemId, MAX_MEDIA_SECONDS + 500);
    const updated = next.items.find((i) => i.id === itemId)!;
    expect(updated.endTime - updated.startTime).toBeCloseTo(MAX_MEDIA_SECONDS, 5);
  });

  it('setItemDuration clamps a requested duration above the limit (e.g. the inspector Duration field)', () => {
    const { project, itemId } = projectWithImageItem(5);
    const next = setItemDuration(project, itemId, 9999);
    const updated = next.items.find((i) => i.id === itemId)!;
    expect(updated.endTime - updated.startTime).toBeCloseTo(MAX_MEDIA_SECONDS, 5);
  });

  it('still allows shortening a clip within the limit — the cap must never block normal editing', () => {
    const { project, itemId } = projectWithImageItem(20);
    const next = setItemDuration(project, itemId, 10);
    const updated = next.items.find((i) => i.id === itemId)!;
    expect(updated.endTime - updated.startTime).toBeCloseTo(10, 5);
  });

  it('an item starting mid-timeline is capped relative to its own start, not to absolute time zero', () => {
    const { project, itemId } = projectWithImageItem(5);
    let withOffset = project;
    withOffset = { ...withOffset, items: withOffset.items.map((i) => (i.id === itemId ? { ...i, startTime: 100, endTime: 105 } : i)) };
    const next = trimItemEnd(withOffset, itemId, 1000);
    const updated = next.items.find((i) => i.id === itemId)!;
    expect(updated.startTime).toBe(100);
    expect(updated.endTime - updated.startTime).toBeCloseTo(MAX_MEDIA_SECONDS, 5);
  });
});

describe('project-level guard (projectDurationExceedsLimit)', () => {
  it('flags a project whose total duration exceeds the limit', () => {
    const { project } = projectWithImageItem(MAX_MEDIA_SECONDS + 1);
    expect(projectDurationExceedsLimit(project)).toBe(true);
  });

  it('does not flag a project within the limit', () => {
    const { project } = projectWithImageItem(MAX_MEDIA_SECONDS - 1);
    expect(projectDurationExceedsLimit(project)).toBe(false);
  });

  it('does not flag a project exactly at the limit', () => {
    const { project } = projectWithImageItem(MAX_MEDIA_SECONDS);
    expect(projectDurationExceedsLimit(project)).toBe(false);
  });

  it('three 10-second clips placed back to back sum to 30s and are allowed', () => {
    let project = createEmptyProject({ ownerUid: 'test-uid' });
    const track = createTrack('image', 'Image', 0);
    project = addTrack(project, track);
    for (let i = 0; i < 3; i++) {
      project = addItem(project, makeItem({ trackId: track.id, startTime: i * 10, endTime: i * 10 + 10, zIndex: i }));
    }
    expect(getProjectDuration(project)).toBeCloseTo(30, 5);
    expect(projectDurationExceedsLimit(project)).toBe(false);
  });

  it('clips summing past the limit ARE flagged', () => {
    let project = createEmptyProject({ ownerUid: 'test-uid' });
    const track = createTrack('image', 'Image', 0);
    project = addTrack(project, track);
    // Two clips: one MAX_MEDIA_SECONDS, one 10s after it -> total exceeds limit.
    project = addItem(project, makeItem({ trackId: track.id, startTime: 0, endTime: MAX_MEDIA_SECONDS, zIndex: 0 }));
    project = addItem(project, makeItem({ trackId: track.id, startTime: MAX_MEDIA_SECONDS, endTime: MAX_MEDIA_SECONDS + 10, zIndex: 1 }));
    expect(getProjectDuration(project)).toBeCloseTo(MAX_MEDIA_SECONDS + 10, 5);
    expect(projectDurationExceedsLimit(project)).toBe(true);
  });
});

function projectWithTwoAdjacentImageItems(): { project: Project; firstId: string; secondId: string } {
  let project = createEmptyProject({ ownerUid: 'test-uid' });
  const track = createTrack('image', 'Image', 0);
  project = addTrack(project, track);
  const first = makeItem({ trackId: track.id, startTime: 0, endTime: 5, zIndex: 0 });
  const second = makeItem({ trackId: track.id, startTime: 5, endTime: 10, zIndex: 1 });
  project = addItem(project, first);
  project = addItem(project, second);
  return { project, firstId: first.id, secondId: second.id };
}

describe('getBoundaryTransition (Phase 2.1 Transitions panel read-side)', () => {
  it('is undefined for back-to-back clips with no transition applied', () => {
    const { project, firstId } = projectWithTwoAdjacentImageItems();
    expect(getBoundaryTransition(project, firstId)).toBeUndefined();
  });

  it('reports the preset + overlap duration after applyTransition', () => {
    const { project, firstId } = projectWithTwoAdjacentImageItems();
    const next = applyTransition(project, firstId, 'fade');
    const boundary = getBoundaryTransition(next, firstId);
    expect(boundary?.preset).toBe('fade');
    // 'fade' catalog default is 0.45s — the overlap applyTransition created.
    expect(boundary?.durationSeconds).toBeCloseTo(0.45, 5);
  });

  it('is undefined for a lone hand-set entrance with no matching exit/overlap pair', () => {
    const { project, firstId, secondId } = projectWithTwoAdjacentImageItems();
    const next = updateItem(project, secondId, { animation: { entrance: 'fade' } });
    expect(getBoundaryTransition(next, firstId)).toBeUndefined();
  });
});

describe('updateItemMotion (Phase 2.1 shared motion setter)', () => {
  it('sets the effect type on a media item, defaulting the rest of the motion shape', () => {
    const { project, itemId } = projectWithImageItem(5);
    const next = updateItemMotion(project, itemId, { type: 'ken-burns' });
    const updated = next.items.find((i) => i.id === itemId) as ImageTimelineItem;
    expect(updated.motion?.type).toBe('ken-burns');
  });

  it('merges partial patches without wiping the chosen effect', () => {
    const { project, itemId } = projectWithImageItem(5);
    let next = updateItemMotion(project, itemId, { type: 'parallax', direction: 'left' });
    next = updateItemMotion(next, itemId, { intensity: 1.5 });
    const updated = next.items.find((i) => i.id === itemId) as ImageTimelineItem;
    expect(updated.motion).toEqual({ type: 'parallax', direction: 'left', intensity: 1.5 });
  });

  it('is a no-op (same project reference) for a missing item id', () => {
    const { project } = projectWithImageItem(5);
    expect(updateItemMotion(project, 'no-such-item', { type: 'flash' })).toBe(project);
  });
});
