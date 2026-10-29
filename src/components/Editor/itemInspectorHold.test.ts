/**
 * R36 — ItemInspector hold note: the plain line appears ONLY for the
 * item that will actually hold (the latest-ending main visual item in
 * a project that continues past the main layer's end), with the video
 * wording for a video and the picture wording for an image.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  addItem,
  addTrack,
  createEmptyProject,
  createTrack,
  generateTimelineId,
} from '../../lib/timeline/utils';
import type { ImageTimelineItem, Project, TimelineItem, VideoTimelineItem } from '../../types/timeline';

const holder = globalThis as unknown as { __inspectorProject?: Project };

vi.mock('../../context/ProjectContext', () => ({
  useProject: () => ({ mutate: () => undefined, project: holder.__inspectorProject }),
}));

import { ItemInspector } from './ItemInspector';

function makeVideo(overrides: Partial<VideoTimelineItem> & { trackId: string }): VideoTimelineItem {
  return {
    id: generateTimelineId('item'),
    type: 'video',
    startTime: 0,
    endTime: 12,
    zIndex: 0,
    visible: true,
    mediaAssetId: 'video-asset',
    position: { x: 50, y: 50 },
    scale: 1,
    rotation: 0,
    opacity: 1,
    trimStart: 0,
    trimEnd: 12,
    speed: 1,
    reverse: false,
    volume: 1,
    muted: false,
    ...overrides,
  };
}

function makeImage(overrides: Partial<ImageTimelineItem> & { trackId: string }): ImageTimelineItem {
  return {
    id: generateTimelineId('item'),
    type: 'image',
    startTime: 0,
    endTime: 12,
    zIndex: 0,
    visible: true,
    mediaAssetId: 'image-asset',
    role: 'photo',
    position: { x: 50, y: 50 },
    scale: 1,
    rotation: 0,
    opacity: 1,
    ...overrides,
  };
}

const PIP = { isPip: true, shape: 'circle', borderWidth: 0, borderColor: '#000000', shadow: false } as const;

function build(main: TimelineItem, pipEnd: number): { project: Project; mainId: string; pipId: string } {
  let project = createEmptyProject({ ownerUid: 'test-uid' });
  const videoTrack = createTrack('video', 'Main Video', 0);
  const imageTrack = createTrack('image', 'Images', 1);
  project = addTrack(project, videoTrack);
  project = addTrack(project, imageTrack);
  const mainItem = { ...main, trackId: main.type === 'video' ? videoTrack.id : imageTrack.id } as TimelineItem;
  const pipItem = makeVideo({
    trackId: videoTrack.id,
    startTime: 0,
    endTime: pipEnd,
    trimEnd: pipEnd,
    pip: { ...PIP },
    zIndex: 2,
  });
  project = addItem(project, mainItem);
  project = addItem(project, pipItem);
  return { project, mainId: mainItem.id, pipId: pipItem.id };
}

function renderInspector(project: Project, itemId: string): string {
  holder.__inspectorProject = project;
  const item = project.items.find((i) => i.id === itemId)!;
  return renderToStaticMarkup(React.createElement(ItemInspector, { item }));
}

describe('R36 ItemInspector — hold note', () => {
  it('a 12s main video that will hold under a 40s PiP shows the last-frame line', () => {
    const { project, mainId } = build(makeVideo({ trackId: 'x', startTime: 0, endTime: 12 }), 40);
    const markup = renderInspector(project, mainId);
    expect(markup).toContain("This clip&#x27;s last frame stays on screen until the project ends.");
    expect(markup).not.toContain('This picture stays on screen');
  });

  it('a 12s main picture that will hold under a 40s PiP shows the picture line', () => {
    const { project, mainId } = build(makeImage({ trackId: 'x', startTime: 0, endTime: 12 }), 40);
    const markup = renderInspector(project, mainId);
    expect(markup).toContain('This picture stays on screen until the project ends.');
    expect(markup).not.toContain('last frame stays on screen');
  });

  it('a 40s main video with a 12s PiP shows no hold line (it never holds)', () => {
    const { project, mainId } = build(makeVideo({ trackId: 'x', startTime: 0, endTime: 40, trimEnd: 40 }), 12);
    const markup = renderInspector(project, mainId);
    expect(markup).not.toContain('stays on screen until the project ends');
  });

  it('the PiP itself shows no hold line (overlays never hold)', () => {
    const { project, pipId } = build(makeVideo({ trackId: 'x', startTime: 0, endTime: 12 }), 40);
    const markup = renderInspector(project, pipId);
    expect(markup).not.toContain('stays on screen until the project ends');
  });
});
