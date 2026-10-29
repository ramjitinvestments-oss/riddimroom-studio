/**
 * R36 WS-2 — Overlay lane derivation + rendering coverage, and the
 * WS-1 empty-lane entry.
 *
 * The lane is a pure derivation (timelinePanelLogic.deriveTimelineRows)
 * over the unchanged model — a PiP is a video item with pip.isPip on
 * the single video track; a pair second carries pair.role 'second'.
 * These tests build projects through the REAL placement helpers
 * (appendDualCaptureToTimeline, placeImportPair, addPipOverlay) and
 * assert which row each item lands in, that lane packing stacks
 * overlaps and shares sequential items, and that a move/trim never
 * changes an item's lane, track or pip status.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDefaultProject } from '../../lib/projects/persistence';
import { appendDualCaptureToTimeline, appendMediaToTimeline, placeImportPair } from '../../lib/timeline/insert';
import { addPipOverlay, isPipItem } from '../../lib/pip';
import { moveItem, trimItemEnd } from '../../lib/timeline/utils';
import type { MediaAsset, Project, TimelineItem } from '../../types/timeline';
import {
  deriveTimelineRows,
  isOverlayLaneItem,
  packOverlaySubLanes,
  type TimelineLaneRow,
} from './timelinePanelLogic';

vi.mock('../../context/ProjectContext', () => ({
  useProject: () => ({ mutate: () => undefined }),
}));

import { TimelinePanel } from './TimelinePanel';

function videoAsset(id: string, durationSeconds = 12): MediaAsset {
  return {
    id,
    kind: 'video',
    storageUrl: `https://example.com/${id}.mp4`,
    fileName: `${id}.mp4`,
    sizeBytes: 1_000_000,
    mimeType: 'video/mp4',
    durationSeconds,
    width: 1920,
    height: 1080,
    createdAt: 0,
  };
}

function imageAsset(id: string): MediaAsset {
  return {
    id,
    kind: 'image',
    storageUrl: `https://example.com/${id}.png`,
    fileName: `${id}.png`,
    sizeBytes: 100_000,
    mimeType: 'image/png',
    width: 800,
    height: 800,
    createdAt: 0,
  };
}

function overlayRows(rows: TimelineLaneRow[]): TimelineLaneRow[] {
  return rows.filter((r) => r.kind === 'overlay');
}

function trackRowFor(rows: TimelineLaneRow[], trackType: string): TimelineLaneRow | undefined {
  return rows.find((r) => r.kind === 'track' && r.track.type === trackType);
}

function itemByAsset(project: Project, assetId: string) {
  const item = project.items.find((i) => 'mediaAssetId' in i && i.mediaAssetId === assetId);
  if (!item) throw new Error(`no item for asset ${assetId}`);
  return item;
}

function rowIds(row: TimelineLaneRow | undefined): string[] {
  return (row?.items ?? []).map((i) => i.id);
}

/** Every project item appears in exactly one derived row. */
function expectEveryItemExactlyOnce(project: Project, rows: TimelineLaneRow[]) {
  const placed = rows.flatMap((r) => r.items.map((i) => i.id)).sort();
  expect(placed).toEqual(project.items.map((i) => i.id).sort());
}

describe('WS-2 lane derivation — real pair placements', () => {
  it('dual capture (Corner PiP): the front PiP is in the Overlay lane, the main clip stays in the video row, Overlay sits above it', () => {
    let project = createDefaultProject('u1');
    project = appendDualCaptureToTimeline(project, videoAsset('asset-main'), videoAsset('asset-front'), {
      startDeltaMs: 0,
      layout: 'pip',
    });
    const main = itemByAsset(project, 'asset-main');
    const pip = itemByAsset(project, 'asset-front');
    expect(isPipItem(pip)).toBe(true);

    const rows = deriveTimelineRows(project);
    expect(rowIds(overlayRows(rows)[0])).toEqual([pip.id]);
    expect(rowIds(trackRowFor(rows, 'video'))).toEqual([main.id]);
    const overlayIndex = rows.findIndex((r) => r.kind === 'overlay');
    const videoIndex = rows.findIndex((r) => r.kind === 'track' && r.track.type === 'video');
    expect(overlayIndex).toBeGreaterThanOrEqual(0);
    expect(overlayIndex).toBeLessThan(videoIndex);
    expectEveryItemExactlyOnce(project, rows);
  });

  it('dual capture (Split 50/50): the pair second is NOT a PiP but still lands in the Overlay lane; the main tile stays in the video row', () => {
    let project = createDefaultProject('u1');
    project = appendDualCaptureToTimeline(project, videoAsset('asset-main'), videoAsset('asset-front'), {
      startDeltaMs: 0,
      layout: 'split',
    });
    const main = itemByAsset(project, 'asset-main');
    const second = itemByAsset(project, 'asset-front');
    if (second.type !== 'video') throw new Error('expected a video second');
    expect(isPipItem(second)).toBe(false);
    expect(second.pair?.role).toBe('second');
    expect(isOverlayLaneItem(second)).toBe(true);
    expect(isOverlayLaneItem(main)).toBe(false);

    const rows = deriveTimelineRows(project);
    expect(rowIds(overlayRows(rows)[0])).toEqual([second.id]);
    expect(rowIds(trackRowFor(rows, 'video'))).toEqual([main.id]);
    expectEveryItemExactlyOnce(project, rows);
  });

  it('imported pair (Split, image second): the image second leaves its image row for the Overlay lane', () => {
    let project = createDefaultProject('u1');
    project = placeImportPair(project, videoAsset('asset-a', 8), imageAsset('asset-b'), { layout: 'split' });
    const main = itemByAsset(project, 'asset-a');
    const second = itemByAsset(project, 'asset-b');
    expect(second.type).toBe('image');
    if (second.type === 'image') expect(second.pair?.role).toBe('second');

    const rows = deriveTimelineRows(project);
    expect(rowIds(overlayRows(rows)[0])).toEqual([second.id]);
    expect(rowIds(trackRowFor(rows, 'video'))).toEqual([main.id]);
    expect(rowIds(trackRowFor(rows, 'image'))).toEqual([]);
    expectEveryItemExactlyOnce(project, rows);
  });

  it('a plain project has one empty Overlay row above the video row — and no overlay sub-lanes', () => {
    let project = createDefaultProject('u1');
    project = appendMediaToTimeline(project, videoAsset('asset-main'));
    const rows = deriveTimelineRows(project);
    expect(overlayRows(rows)).toEqual([]);
    const empty = rows.find((r) => r.kind === 'overlay-empty');
    expect(empty).toBeDefined();
    const videoIndex = rows.findIndex((r) => r.kind === 'track' && r.track.type === 'video');
    expect(rows.indexOf(empty!)).toBeLessThan(videoIndex);
    expectEveryItemExactlyOnce(project, rows);
  });
});

describe('WS-2 lane packing', () => {
  it('overlapping PiPs stack in separate sub-lanes; sequential PiPs share one', () => {
    let base = createDefaultProject('u1');
    base = addPipOverlay(base, videoAsset('pip-a', 10), { atTime: 0 });
    const overlapping = addPipOverlay(base, videoAsset('pip-b', 10), { atTime: 5 });
    const packedOverlap = packOverlaySubLanes(overlapping.items.filter(isOverlayLaneItem));
    expect(packedOverlap.length).toBe(2);

    const sequential = addPipOverlay(base, videoAsset('pip-c', 5), { atTime: 10 });
    const packedSequential = packOverlaySubLanes(sequential.items.filter(isOverlayLaneItem));
    expect(packedSequential.length).toBe(1);
    expect(packedSequential[0].items.length).toBe(2);
    // Ordered by start time within the shared lane.
    expect(packedSequential[0].items.map((i) => i.startTime)).toEqual([0, 10]);
  });

  it('packing is deterministic regardless of input order', () => {
    const items: TimelineItem[] = [
      { id: 'b', startTime: 5, endTime: 9, zIndex: 1 } as TimelineItem,
      { id: 'a', startTime: 0, endTime: 4, zIndex: 1 } as TimelineItem,
      { id: 'c', startTime: 4, endTime: 8, zIndex: 2 } as TimelineItem,
    ];
    const lanes = packOverlaySubLanes(items);
    // a(0-4) + c(4-8) share (touching ends share); b(5-9) overlaps c → its own lane.
    expect(lanes.map((l) => l.items.map((i) => i.id))).toEqual([['a', 'c'], ['b']]);
  });
});

describe('WS-2 lane assignment survives edits', () => {
  it('a PiP stays in the Overlay lane after a move and a trim, with its track and pip status unchanged', () => {
    let project = createDefaultProject('u1');
    project = appendDualCaptureToTimeline(project, videoAsset('asset-main'), videoAsset('asset-front'), {
      startDeltaMs: 0,
      layout: 'pip',
    });
    const pipBefore = itemByAsset(project, 'asset-front');
    const moved = moveItem(project, pipBefore.id, 3);
    const pipMoved = moved.items.find((i) => i.id === pipBefore.id)!;
    if (pipMoved.type !== 'video' || pipBefore.type !== 'video') throw new Error('expected video items');
    expect(pipMoved.trackId).toBe(pipBefore.trackId);
    expect(isPipItem(pipMoved)).toBe(true);
    expect(rowIds(overlayRows(deriveTimelineRows(moved))[0])).toContain(pipBefore.id);
    expect(rowIds(trackRowFor(deriveTimelineRows(moved), 'video'))).not.toContain(pipBefore.id);

    const trimmed = trimItemEnd(moved, pipBefore.id, pipMoved.startTime + 4);
    const pipTrimmed = trimmed.items.find((i) => i.id === pipBefore.id)!;
    expect(isOverlayLaneItem(pipTrimmed)).toBe(true);
    expect(rowIds(overlayRows(deriveTimelineRows(trimmed))[0])).toContain(pipBefore.id);
  });
});

describe('WS-2 / WS-1 TimelinePanel rendering', () => {
  function renderPanel(project: Project): string {
    return renderToStaticMarkup(
      React.createElement(TimelinePanel, {
        project,
        currentTime: 0,
        onSeek: () => undefined,
        selectedItemId: null,
        onSelectItem: () => undefined,
      }),
    );
  }

  it('renders the labelled Overlay lane above the video row, holding the PiP clip', () => {
    let project = createDefaultProject('u1');
    project = appendDualCaptureToTimeline(project, videoAsset('asset-main'), videoAsset('asset-front'), {
      startDeltaMs: 0,
      layout: 'pip',
    });
    const markup = renderPanel(project);
    expect(markup).toContain('data-overlay-lane="overlay-0"');
    expect(markup).toContain('Overlay');
    // The PiP clip renders inside the overlay lane, before the video track row in markup order.
    const pip = itemByAsset(project, 'asset-front');
    const laneAt = markup.indexOf('data-overlay-lane="overlay-0"');
    const pipAt = markup.indexOf(`data-item-id="${pip.id}"`);
    const videoRowAt = markup.indexOf('data-track-row');
    expect(laneAt).toBeGreaterThanOrEqual(0);
    expect(pipAt).toBeGreaterThan(laneAt);
    expect(pipAt).toBeLessThan(videoRowAt);
    // No empty-state actions when a PiP exists in the lane.
    expect(markup).not.toContain('overlay-empty');
  });

  it('empty project state: the slim Overlay lane renders inline with Record PiP / Upload PiP', () => {
    const project = createDefaultProject('u1');
    const markup = renderPanel(project);
    expect(markup).toContain('data-overlay-lane="overlay-empty"');
    expect(markup).toContain('Record PiP');
    expect(markup).toContain('Upload PiP');
    expect(markup).toContain('Overlay');
  });
});
