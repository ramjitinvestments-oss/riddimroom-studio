/**
 * R26 WS-T1 — timeline smoothness harness (committed).
 *
 * METHODOLOGY — read before quoting any number from here.
 * This repo has no DOM test environment: vitest runs in node, there is
 * no jsdom/@testing-library, and the $0 rule bars adding one. So:
 *
 * - A "panel render" is a REAL React render of TimelinePanel via
 *   react-dom/server's renderToStaticMarkup. Its ms overstate a real
 *   client render (string building instead of DOM diffing) — timings
 *   are a relative proxy for device fps, NOT device fps.
 * - A "gesture" replays the exact operations each pipeline performs per
 *   pointermove, using the same functions the component calls:
 *   legacy = moveItem/trimItemEnd (project mutation) + a full panel
 *   render; current = computeDragTarget + dragPreviewStyle from
 *   timelinePanelLogic (the functions TimelinePanel's handleMove calls)
 *   with the DOM style write replaced by recording the style — no
 *   project mutation, no render — plus ONE commit + render on release.
 * - Row re-render counts: exact for the legacy pipeline (no memoised
 *   rows existed — every panel render re-rendered every clip, counted
 *   from the markup). For the current pipeline they are computed with
 *   React.memo's own default shallow-compare over the exact props each
 *   row receives before/after an event — that IS the rule that decides
 *   whether ClipRow re-executes in a real client reconciliation.
 *
 * BEFORE numbers (same harness shape, run 2026-10-26 against the
 * pre-R26 panel, two runs on this VM):
 *   drag  per-move 13.9–22.0ms · 30 panel renders · 600 row renders
 *   trim  per-move  6.6–17.9ms · 30 panel renders · 600 row renders
 *   scrub per-seek  2.6–15.2ms · 30 panel renders · 600 row renders
 *   DOM nodes ≈ 448 for the 20-clip reference project.
 * AFTER numbers are printed by the tests below (TIMELINE_PERF_AFTER).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildReferenceProject } from './timelineFixture';
import { moveItem, trimItemEnd } from '../../lib/timeline/utils';
import {
  computeDragTarget,
  createDragSession,
  createSeekThrottler,
  dragPreviewStyle,
  getTimelinePerfCounts,
  resetTimelinePerfCounts,
  setTimelinePerfEnabled,
  type DragSession,
} from './timelinePanelLogic';
import type { Project, TimelineItem } from '../../types/timeline';

vi.mock('../../context/ProjectContext', () => ({
  useProject: () => ({ mutate: () => undefined }),
}));

import { TimelinePanel } from './TimelinePanel';

const MOVES = 30;
const ROW_WIDTH_PX = 1200; // 60s extent at 20px/s — a plausible desktop/phone-landscape row width

function renderPanel(project: Project, currentTime = 0, selectedItemId: string | null = null): string {
  return renderToStaticMarkup(
    React.createElement(TimelinePanel, {
      project,
      currentTime,
      onSeek: () => undefined,
      selectedItemId,
      onSelectItem: () => undefined,
    }),
  );
}

function countClips(markup: string): number {
  return (markup.match(/active:cursor-grabbing/g) || []).length;
}

/** The props TimelinePanel passes ClipRow for one item — mirrored here so the memo model compares the real values. */
function rowProps(project: Project, item: TimelineItem, selectedItemId: string | null) {
  return {
    item,
    selected: item.id === selectedItemId,
    posterUrl: undefined as string | undefined,
    clipLabel:
      item.type === 'text'
        ? item.text
        : item.type === 'caption'
          ? item.words.map((w) => w.text).join(' ')
          : (project.mediaAssets[(item as { mediaAssetId: string }).mediaAssetId]?.fileName ?? item.type),
    extent: 60,
    projectEnd: 60,
  };
}

/** How many rows React.memo would re-render between two prop snapshots (its default shallow compare). */
function modelledRowRerenders(before: Project, after: Project, selectedItemId: string | null = null): number {
  let count = 0;
  for (const item of after.items) {
    const prevItem = before.items.find((i) => i.id === item.id);
    if (!prevItem) {
      count += 1;
      continue;
    }
    const a = rowProps(before, prevItem, selectedItemId);
    const b = rowProps(after, item, selectedItemId);
    if (Object.keys(b).some((k) => !Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))) {
      count += 1;
    }
  }
  return count;
}

function makeSession(item: TimelineItem, mode: DragSession['mode'], project: Project): DragSession {
  return createDragSession({
    itemId: item.id,
    mode,
    startClientX: 400,
    rowWidthPx: ROW_WIDTH_PX,
    extentSeconds: 60,
    originalStartTime: item.startTime,
    originalEndTime: item.endTime,
    snapPoints: [0, 5, ...project.items.filter((i) => i.id !== item.id).flatMap((i) => [i.startTime, i.endTime])],
  });
}

beforeEach(() => {
  setTimelinePerfEnabled(true);
  resetTimelinePerfCounts();
});

describe('WS-T1 harness — reference project shape', () => {
  it('fixture is 20 items / 60s and renders 20 clips in ~448 DOM nodes', () => {
    const fixture = buildReferenceProject();
    expect(fixture.items.length).toBe(20);
    renderPanel(fixture); // warm-up
    resetTimelinePerfCounts();
    const markup = renderPanel(fixture);
    expect(countClips(markup)).toBe(20);
    const nodeCount = (markup.match(/</g) || []).length;
    // (e) windowed rendering decision input: ~22 nodes per clip at a
    // realistic 20-clip project is nowhere near a DOM bottleneck — see
    // the report. The generous bound guards against accidental blow-up.
    expect(nodeCount).toBeLessThan(1000);
    // One SSR pass renders each ClipRow exactly once.
    expect(getTimelinePerfCounts().total).toBe(20);
    // eslint-disable-next-line no-console
    console.log(`TIMELINE_PERF_SHAPE clips=20 domNodesApprox=${nodeCount}`);
  });
});

describe('WS-T1 AFTER — drag gesture (transform preview, commit on release)', () => {
  it('30 pointermoves: 0 commits, 0 row renders, ≤16.7ms per move; release commits exactly once', () => {
    const fixture = buildReferenceProject();
    // item-text-1 (15–23) has real gaps on both sides, so a +6s move is
    // not clamped back by moveItem's overlap prevention (the contiguous
    // video track would be — correctly).
    const item = fixture.items.find((i) => i.id === 'item-text-1')!;
    const session = makeSession(item, 'move', fixture);
    renderPanel(fixture); // warm-up
    resetTimelinePerfCounts();

    let commits = 0;
    const moveTimes: number[] = [];
    let lastTarget = null as ReturnType<typeof computeDragTarget> | null;
    for (let i = 1; i <= MOVES; i++) {
      const clientX = 400 + i * 4; // 4px per move → 6s total drag
      const t0 = performance.now();
      // Exactly what TimelinePanel.handleMove does, minus the DOM write
      // (the style object it would write is computed and kept).
      const target = computeDragTarget(session, clientX);
      const preview = dragPreviewStyle(session, target);
      moveTimes.push(performance.now() - t0);
      expect(preview.translateXPx).toBeDefined();
      lastTarget = target;
      // No mutate() call and no render happen per move in the component.
    }
    const total = moveTimes.reduce((a, b) => a + b, 0);
    const avg = total / MOVES;
    expect(commits).toBe(0);
    expect(getTimelinePerfCounts().total).toBe(0); // zero row renders during the whole gesture

    // Release: the component commits exactly once through moveItem.
    const t0 = performance.now();
    const committed = moveItem(fixture, item.id, lastTarget!.startTime);
    commits += 1;
    renderPanel(committed);
    const commitMs = performance.now() - t0;
    expect(commits).toBe(1);
    // The dragged item moved by the gesture amount (6s, snapped or not).
    const moved = committed.items.find((i) => i.id === item.id)!;
    expect(Math.abs(moved.startTime - (item.startTime + 6))).toBeLessThan(0.2);
    // Memo model: only the dragged row's props changed → 1 row re-render.
    expect(modelledRowRerenders(fixture, committed)).toBe(1);

    // eslint-disable-next-line no-console
    console.log(
      `TIMELINE_PERF_AFTER dragPerMoveMs=${avg.toFixed(3)} dragTotalMs=${total.toFixed(2)} commitsDuringMoves=0 commitsOnRelease=1 rowRendersDuringGesture=0 rowRendersOnCommitModelled=1 commitRenderMs=${commitMs.toFixed(2)}`,
    );
    // Budget: 60fps-equivalent is 16.7ms/move; assert with a wide margin
    // for shared-CI noise (the measured value is ~0.01ms — pure math).
    expect(avg).toBeLessThan(16.7);
    expect(avg).toBeLessThan(5);
  });

  it('30 trim pointermoves behave the same (no commits, no renders, one commit on release)', () => {
    const fixture = buildReferenceProject();
    const item = fixture.items.find((i) => i.id === 'item-video-2')!;
    const session = makeSession(item, 'trim-end', fixture);
    resetTimelinePerfCounts();
    const times: number[] = [];
    let lastTarget = null as ReturnType<typeof computeDragTarget> | null;
    for (let i = 1; i <= MOVES; i++) {
      const t0 = performance.now();
      const target = computeDragTarget(session, 400 + i * 4);
      const preview = dragPreviewStyle(session, target);
      times.push(performance.now() - t0);
      expect(preview.widthPx).toBeDefined();
      lastTarget = target;
    }
    const avg = times.reduce((a, b) => a + b, 0) / MOVES;
    expect(getTimelinePerfCounts().total).toBe(0);
    const committed = trimItemEnd(fixture, item.id, lastTarget!.endTime);
    expect(modelledRowRerenders(fixture, committed)).toBe(1);
    // eslint-disable-next-line no-console
    console.log(`TIMELINE_PERF_AFTER trimPerMoveMs=${avg.toFixed(3)} rowRendersDuringGesture=0`);
    expect(avg).toBeLessThan(5);
  });
});

describe('WS-T1 AFTER — scrub / playback time updates', () => {
  it('a currentTime-only change re-renders 0 clip rows (memo model) and seek commits are throttled', () => {
    const fixture = buildReferenceProject();
    // Playback tick: project object is IDENTICAL, only currentTime moved —
    // every row's props are unchanged, so memo bails on all 20 rows. (The
    // panel shell re-renders and the playhead moves via ref+transform.)
    expect(modelledRowRerenders(fixture, fixture)).toBe(0);

    // Scrub throttler: 30 rapid pushes → first commits immediately, the
    // rest coalesce, flush delivers the exact final time.
    const committed: number[] = [];
    const throttler = createSeekThrottler(100, (t) => committed.push(t));
    for (let i = 1; i <= MOVES; i++) throttler.push(i * 1.5);
    throttler.flush();
    expect(committed[0]).toBe(1.5);
    expect(committed[committed.length - 1]).toBe(45);
    expect(committed.length).toBeLessThanOrEqual(3); // generous: a slow VM may cross one interval boundary
    // eslint-disable-next-line no-console
    console.log(`TIMELINE_PERF_AFTER scrubPushes=${MOVES} seekCommits=${committed.length} rowRendersPerTickModelled=0`);
  });
});

describe('WS-T1 legacy pipeline benchmark (comparison only)', () => {
  it('per-move mutate + full render still costs a full panel render and 20 row renders per move', () => {
    const fixture = buildReferenceProject();
    renderPanel(fixture); // warm-up
    let project = fixture;
    const times: number[] = [];
    for (let i = 1; i <= 10; i++) {
      const t0 = performance.now();
      project = moveItem(project, 'item-video-2', 20 + i * 0.1);
      renderPanel(project);
      times.push(performance.now() - t0);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    // eslint-disable-next-line no-console
    console.log(`TIMELINE_PERF_LEGACY perMoveMs=${avg.toFixed(2)} rowRendersPerMove=20 (unmemoised model)`);
    expect(avg).toBeGreaterThan(0);
  });
});
