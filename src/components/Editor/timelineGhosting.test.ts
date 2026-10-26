/**
 * R26 WS-A2 — timeline ghosting / extent coverage.
 * Pure-helper unit tests plus server-render markup assertions: a 180s
 * song under a 12s main must stay fully scrollable (extent 180), show
 * the project end line at 12s, and render only 0–12s of the song solid.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildGhostProject, buildReferenceProject } from './timelineFixture';
import { getGhostSplit, getProjectEndSeconds, getTimelineExtent } from './timelinePanelLogic';
import { getMaxItemEnd, getProjectDuration } from '../../lib/timeline/utils';

vi.mock('../../context/ProjectContext', () => ({
  useProject: () => ({ mutate: () => undefined }),
}));

import { TimelinePanel } from './TimelinePanel';

function renderPanel(project: Parameters<typeof TimelinePanel>[0]['project']): string {
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

describe('WS-A2 extent helpers', () => {
  it('extent = max(project duration, max item end): 180 for the ghost project, 60 for the reference', () => {
    const ghost = buildGhostProject();
    expect(getProjectDuration(ghost)).toBe(12);
    expect(getMaxItemEnd(ghost)).toBe(180);
    expect(getProjectEndSeconds(ghost)).toBe(12);
    expect(getTimelineExtent(ghost)).toBe(180);

    const ref = buildReferenceProject();
    expect(getProjectEndSeconds(ref)).toBe(60);
    expect(getTimelineExtent(ref)).toBe(60);
  });
});

describe('WS-A2 ghost split', () => {
  it('song 0–180 under a 12s end: ghost starts at 12 (6.7% into the item), not fully ghosted', () => {
    const ghost = buildGhostProject();
    const song = ghost.items.find((i) => i.id === 'item-song')!;
    const split = getGhostSplit(song, 12);
    expect(split).not.toBeNull();
    expect(split!.ghostStartTime).toBe(12);
    expect(split!.ghostOffsetFraction).toBeCloseTo(12 / 180, 6);
    expect(split!.fullyGhosted).toBe(false);
  });

  it('an audio item starting past the end is fully ghosted; one ending before it is not ghosted', () => {
    const ghost = buildGhostProject();
    const song = ghost.items.find((i) => i.id === 'item-song')!;
    const late = { ...song, id: 'late', startTime: 20, endTime: 50 };
    expect(getGhostSplit(late, 12)!.fullyGhosted).toBe(true);
    expect(getGhostSplit(late, 12)!.ghostOffsetFraction).toBe(0);
    const early = { ...song, id: 'early', startTime: 0, endTime: 10 };
    expect(getGhostSplit(early, 12)).toBeNull();
  });

  it('non-audio items never ghost, and a 0 project end ghosts nothing', () => {
    const ghost = buildGhostProject();
    const main = ghost.items.find((i) => i.id === 'item-main')!;
    expect(getGhostSplit({ ...main, endTime: 180 }, 12)).toBeNull();
    const song = ghost.items.find((i) => i.id === 'item-song')!;
    expect(getGhostSplit(song, 0)).toBeNull();
  });
});

describe('WS-A2 TimelinePanel rendering', () => {
  it('180s song under a 12s main: end line at 12s, song fully wide, ghost overlay from 12s, stored item unchanged', () => {
    const project = buildGhostProject();
    const markup = renderPanel(project);

    // Project end line present, positioned at 12/180 of the extent.
    expect(markup).toContain('data-testid="project-end-line"');
    expect(markup).toContain('data-end-seconds="12"');
    expect(markup).toContain(`left:${(12 / 180) * 100}%`); // left:6.666666666666667%

    // Ghost overlay present, anchored at the 12s split inside the song clip.
    expect(markup).toContain('data-testid="clip-ghost"');
    expect(markup).toContain('data-ghost-start="12"');

    // The song clip spans the FULL extent (scrollable/editable to 180s):
    // width 100% of the extent-relative row; the main clip is 12/180 wide.
    expect(markup).toContain('width:100%');
    expect(markup).toContain(`width:${(12 / 180) * 100}%`); // width:6.666666666666667%

    // Non-destructive: the stored item still ends at 180.
    expect(project.items.find((i) => i.id === 'item-song')!.endTime).toBe(180);
  });

  it('reference project (no overhang): no end line, no ghost', () => {
    const markup = renderPanel(buildReferenceProject());
    expect(markup).not.toContain('project-end-line');
    expect(markup).not.toContain('clip-ghost');
  });
});
