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
} from './utils';
import { MAX_MEDIA_SECONDS } from '../media/constants';
import type { ImageTimelineItem, Project } from '../../types/timeline';

/**
 * "Universal 30-second media standard" focused tests — item 9 of the
 * September 2026 spec ("Add focused tests for: ... project duration
 * limit"). `image` items are used as the fixture type throughout because
 * their duration is freely adjustable (no source-media trim window to also
 * account for), which isolates exactly the per-item cap being tested.
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

describe('per-item 30-second cap (trimItemEnd / setItemDuration)', () => {
  it('trimItemEnd never lets an item exceed MAX_MEDIA_SECONDS, however far the new end time is dragged', () => {
    const { project, itemId } = projectWithImageItem(5);
    const next = trimItemEnd(project, itemId, 500);
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

describe('project-level 30-second guard (projectDurationExceedsLimit)', () => {
  it('flags a project whose total duration exceeds the limit', () => {
    const { project } = projectWithImageItem(31);
    expect(projectDurationExceedsLimit(project)).toBe(true);
  });

  it('does not flag a project within the limit', () => {
    const { project } = projectWithImageItem(29);
    expect(projectDurationExceedsLimit(project)).toBe(false);
  });

  it('does not flag a project exactly at the limit', () => {
    const { project } = projectWithImageItem(30);
    expect(projectDurationExceedsLimit(project)).toBe(false);
  });

  it('three 10-second clips placed back to back sum to exactly 30s and are allowed (spec example)', () => {
    let project = createEmptyProject({ ownerUid: 'test-uid' });
    const track = createTrack('image', 'Image', 0);
    project = addTrack(project, track);
    for (let i = 0; i < 3; i++) {
      project = addItem(project, makeItem({ trackId: track.id, startTime: i * 10, endTime: i * 10 + 10, zIndex: i }));
    }
    expect(getProjectDuration(project)).toBeCloseTo(30, 5);
    expect(projectDurationExceedsLimit(project)).toBe(false);
  });

  it('four 10-second clips placed back to back sum to 40s and ARE flagged', () => {
    let project = createEmptyProject({ ownerUid: 'test-uid' });
    const track = createTrack('image', 'Image', 0);
    project = addTrack(project, track);
    for (let i = 0; i < 4; i++) {
      project = addItem(project, makeItem({ trackId: track.id, startTime: i * 10, endTime: i * 10 + 10, zIndex: i }));
    }
    expect(getProjectDuration(project)).toBeCloseTo(40, 5);
    expect(projectDurationExceedsLimit(project)).toBe(true);
  });
});
