// Timeline EDITING verification harness — exercises the new move/trim/
// duration/split helpers added during the "live editor repair" pass
// (`wouldOverlapOnTrack`, `moveItem`, `trimItemStart`, `trimItemEnd`,
// `setItemDuration`, `splitItemAtTime` in `src/lib/timeline/utils.ts`), plus
// the compositor's pure animation-math entry point (`computeEntranceExit`).
// Run with `npx tsx test-timeline-editing.mts`. Mirrors the PASS/FAIL style
// of `test-timeline-foundation.mts` for consistency — no mocks, exercises
// the real modules the editor UI (TimelinePanel/ItemInspector) calls.

import {
  createEmptyProject,
  createTrack,
  addTrack,
  addItem,
  addMediaAsset,
  getItemDuration,
  getProjectDuration,
  wouldOverlapOnTrack,
  moveItem,
  trimItemStart,
  trimItemEnd,
  setItemDuration,
  splitItemAtTime,
  validateProject,
  type Project,
  type VideoTimelineItem,
  type CaptionTimelineItem,
} from './src/lib/timeline/index.ts';
import { computeEntranceExit } from './src/lib/render/compositor.ts';

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`PASS: ${name}`);
    passed++;
  } else {
    console.log(`FAIL: ${name}${detail ? ' -- ' + detail : ''}`);
    failed++;
  }
}
function approx(a: number, b: number, eps = 0.001): boolean {
  return Math.abs(a - b) < eps;
}

// ---------------------------------------------------------------------------
// Build a small project: one video track with two sequential video items,
// plus a caption item with three words, for split coverage.
// ---------------------------------------------------------------------------

function buildProject(): Project {
  let project = createEmptyProject({ ownerUid: 'uid_test', name: 'Editing test project', now: 1000 });
  const videoTrack = createTrack('video', 'Main Video', 0);
  const captionTrack = createTrack('caption', 'Captions', 0);
  project = addTrack(project, videoTrack);
  project = addTrack(project, captionTrack);

  project = addMediaAsset(project, {
    id: 'asset_a', kind: 'video', storageUrl: 'gs://bucket/a.mp4',
    fileName: 'a.mp4', sizeBytes: 1_000_000, mimeType: 'video/mp4', durationSeconds: 10, width: 1080, height: 1920, createdAt: 1000,
  });
  project = addMediaAsset(project, {
    id: 'asset_b', kind: 'video', storageUrl: 'gs://bucket/b.mp4',
    fileName: 'b.mp4', sizeBytes: 1_000_000, mimeType: 'video/mp4', durationSeconds: 10, width: 1080, height: 1920, createdAt: 1000,
  });

  const itemA: VideoTimelineItem = {
    type: 'video',
    id: 'item_a', trackId: videoTrack.id, startTime: 0, endTime: 10, zIndex: 0, visible: true,
    mediaAssetId: 'asset_a', speed: 1, reverse: false, volume: 1, muted: false,
    trimStart: 0, trimEnd: 10,
    position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 1,
  };
  const itemB: VideoTimelineItem = {
    type: 'video',
    id: 'item_b', trackId: videoTrack.id, startTime: 10, endTime: 20, zIndex: 0, visible: true,
    mediaAssetId: 'asset_b', speed: 1, reverse: false, volume: 1, muted: false,
    trimStart: 0, trimEnd: 10,
    position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 1,
  };
  const captionItem: CaptionTimelineItem = {
    type: 'caption',
    id: 'item_caption', trackId: captionTrack.id, startTime: 0, endTime: 3, zIndex: 0, visible: true,
    words: [
      { text: 'hello', start: 0, end: 0.9 },
      { text: 'from', start: 1.0, end: 1.5 },
      { text: 'riddimroom', start: 1.6, end: 2.9 },
    ],
    captionStyleId: 'classic', source: 'manual', editable: true,
  };

  project = addItem(project, itemA);
  project = addItem(project, itemB);
  project = addItem(project, captionItem);
  return project;
}

// ---------------------------------------------------------------------------
// wouldOverlapOnTrack
// ---------------------------------------------------------------------------
{
  const project = buildProject();
  check(
    'wouldOverlapOnTrack detects an overlap with a sibling on the same track',
    wouldOverlapOnTrack(project, project.tracks[0].id, 5, 15, 'item_a') === true,
  );
  check(
    'wouldOverlapOnTrack returns false for a genuinely free span',
    wouldOverlapOnTrack(project, project.tracks[0].id, 20, 25, 'item_a') === false,
  );
  check(
    'wouldOverlapOnTrack ignores the item itself via ignoreItemId',
    wouldOverlapOnTrack(project, project.tracks[0].id, 0, 10, 'item_a') === false,
  );
}

// ---------------------------------------------------------------------------
// moveItem
// ---------------------------------------------------------------------------
{
  const project = buildProject();
  const moved = moveItem(project, 'item_b', 12);
  const item = moved.items.find((i) => i.id === 'item_b')!;
  check('moveItem translates startTime to the requested position', approx(item.startTime, 12));
  check('moveItem preserves the item\'s duration', approx(getItemDuration(item), 10));
  check(
    'moveItem preserves trimStart/trimEnd (a move never re-trims)',
    approx((item as VideoTimelineItem).trimStart, 0) && approx((item as VideoTimelineItem).trimEnd, 10),
  );

  // Moving item_b to overlap item_a should clamp against it rather than silently overlapping.
  const clamped = moveItem(project, 'item_b', 2, { preventOverlap: true });
  const clampedItem = clamped.items.find((i) => i.id === 'item_b')!;
  check(
    'moveItem clamps against an overlapping sibling by default',
    !wouldOverlapOnTrack(clamped, project.tracks[0].id, clampedItem.startTime, clampedItem.endTime, 'item_b'),
  );

  const allowedOverlap = moveItem(project, 'item_b', 2, { preventOverlap: false });
  const overlappedItem = allowedOverlap.items.find((i) => i.id === 'item_b')!;
  check('moveItem allows an intentional overlap when preventOverlap is false', approx(overlappedItem.startTime, 2));
}

// ---------------------------------------------------------------------------
// trimItemStart / trimItemEnd — the core "video length" bug fix: the
// trim window must move in lockstep with the timeline slot for video/audio.
// ---------------------------------------------------------------------------
{
  const project = buildProject();

  const trimmedStart = trimItemStart(project, 'item_a', 2);
  const a1 = trimmedStart.items.find((i) => i.id === 'item_a')! as VideoTimelineItem;
  check('trimItemStart moves startTime to the requested value', approx(a1.startTime, 2));
  check('trimItemStart leaves endTime untouched', approx(a1.endTime, 10));
  check(
    'trimItemStart advances trimStart by the same amount (source window shrinks in lockstep)',
    approx(a1.trimStart, 2) && approx(a1.trimEnd, 10),
  );
  check(
    'trimItemStart preserves the (trimEnd - trimStart) === (endTime - startTime) * speed invariant',
    approx((a1.trimEnd - a1.trimStart), (a1.endTime - a1.startTime) * a1.speed),
  );

  const trimmedEnd = trimItemEnd(project, 'item_a', 7);
  const a2 = trimmedEnd.items.find((i) => i.id === 'item_a')! as VideoTimelineItem;
  check('trimItemEnd moves endTime to the requested value', approx(a2.endTime, 7));
  check('trimItemEnd leaves startTime untouched', approx(a2.startTime, 0));
  check('trimItemEnd shrinks trimEnd by the same amount', approx(a2.trimEnd, 7) && approx(a2.trimStart, 0));
  check(
    'trimItemEnd preserves the (trimEnd - trimStart) === (endTime - startTime) * speed invariant',
    approx((a2.trimEnd - a2.trimStart), (a2.endTime - a2.startTime) * a2.speed),
  );
}

// ---------------------------------------------------------------------------
// setItemDuration — the ItemInspector "Duration (s)" field's underlying op.
// ---------------------------------------------------------------------------
{
  const project = buildProject();
  const resized = setItemDuration(project, 'item_a', 4);
  const a = resized.items.find((i) => i.id === 'item_a')! as VideoTimelineItem;
  check('setItemDuration actually changes the item\'s duration', approx(getItemDuration(a), 4));
  check('setItemDuration changes the project\'s overall duration accordingly', approx(getProjectDuration(resized), 20)); // item_b still ends at 20, unaffected
  check(
    'setItemDuration keeps the trim window in sync (video length change is real, not cosmetic)',
    approx(a.trimEnd - a.trimStart, 4),
  );

  // Shrinking the FIRST item's duration must change overall project duration
  // when it is the last item on the timeline.
  const soloProject = { ...project, items: [project.items[0]] };
  const soloResized = setItemDuration(soloProject, 'item_a', 3);
  check(
    'setItemDuration changes getProjectDuration when the resized item is the last one on the timeline',
    approx(getProjectDuration(soloResized), 3),
  );
}

// ---------------------------------------------------------------------------
// splitItemAtTime — video/audio (trim divided at the matching source offset)
// and caption (words divided, none duplicated or dropped).
// ---------------------------------------------------------------------------
{
  const project = buildProject();
  const split = splitItemAtTime(project, 'item_a', 4);
  const pieces = split.items.filter((i) => i.trackId === project.tracks[0].id && i.id !== 'item_b');
  check('splitItemAtTime produces exactly two pieces from the original video item', pieces.length === 2);

  const first = pieces.find((i) => approx(i.startTime, 0))! as VideoTimelineItem;
  const second = pieces.find((i) => approx(i.startTime, 4))! as VideoTimelineItem;
  check('splitItemAtTime: first piece keeps original startTime and ends at the split point', !!first && approx(first.endTime, 4));
  check('splitItemAtTime: second piece starts exactly at the split point and keeps original endTime', !!second && approx(second.endTime, 10));
  check(
    'splitItemAtTime: source trim window is divided at the matching offset (first.trimEnd === second.trimStart)',
    !!first && !!second && approx(first.trimEnd, second.trimStart),
  );
  check(
    'splitItemAtTime: combined trim span across both pieces equals the original trim span',
    !!first && !!second && approx((first.trimEnd - first.trimStart) + (second.trimEnd - second.trimStart), 10),
  );
  check('splitItemAtTime result still validates as a well-formed project', validateProject(split).valid);

  // No-op when the split point isn't meaningfully inside the item.
  const noopEarly = splitItemAtTime(project, 'item_a', 0);
  check('splitItemAtTime is a no-op when atTime is at/before the item start', noopEarly.items.length === project.items.length);
  const noopLate = splitItemAtTime(project, 'item_a', 10);
  check('splitItemAtTime is a no-op when atTime is at/after the item end', noopLate.items.length === project.items.length);

  // Caption split: words must be partitioned, none duplicated or dropped,
  // and re-based to the new item's own startTime=0 origin.
  const captionSplit = splitItemAtTime(project, 'item_caption', 1.2);
  const captionPieces = captionSplit.items.filter((i) => i.type === 'caption') as CaptionTimelineItem[];
  check('splitItemAtTime(caption) produces exactly two caption pieces', captionPieces.length === 2);
  const totalWordsAfter = captionPieces.reduce((sum, c) => sum + c.words.length, 0);
  const totalWordsBefore = (project.items.find((i) => i.id === 'item_caption') as CaptionTimelineItem).words.length;
  check('splitItemAtTime(caption): no word is duplicated or dropped across the split', totalWordsAfter === totalWordsBefore);
  const firstCaption = captionPieces.find((c) => approx(c.startTime, 0))!;
  const secondCaption = captionPieces.find((c) => !approx(c.startTime, 0))!;
  // Split at 1.2s: partitioning is by each word's *start* time (not its
  // span), so "from" (start 1.0, end 1.5) lands in the first piece even
  // though it extends past the split point — only "riddimroom" (start 1.6)
  // starts after 1.2s.
  check(
    'splitItemAtTime(caption): first piece keeps every word whose start is before the split point',
    firstCaption.words.length === 2 && firstCaption.words[0].text === 'hello' && firstCaption.words[1].text === 'from',
  );
  check(
    'splitItemAtTime(caption): second piece keeps the word(s) after the split, re-based so its first word starts at 0',
    secondCaption.words.length === 1 && secondCaption.words[0].text === 'riddimroom' && approx(secondCaption.words[0].start, 0),
  );
}

// ---------------------------------------------------------------------------
// computeEntranceExit — premium transitions must be real per-frame math,
// not a no-op. Every implemented preset must actually deviate from the
// identity adjustment during its entrance/exit window.
// ---------------------------------------------------------------------------
{
  const IDENTITY = { opacityMul: 1, offsetXPx: 0, offsetYPx: 0, scaleMul: 1, blurPx: 0 };
  check(
    "computeEntranceExit('none') is the identity adjustment (no motion)",
    JSON.stringify(computeEntranceExit('none', 0, 5, 5, 1080, 1920)) === JSON.stringify(IDENTITY),
  );
  check(
    'computeEntranceExit(undefined) is the identity adjustment',
    JSON.stringify(computeEntranceExit(undefined, 0, 5, 5, 1080, 1920)) === JSON.stringify(IDENTITY),
  );

  const fadeAtStart = computeEntranceExit('fade', 0, 5, 5, 1080, 1920);
  check('computeEntranceExit("fade") reduces opacity at the very start of the item', fadeAtStart.opacityMul < 1);
  const fadeMidway = computeEntranceExit('fade', 2, 2, 5, 1080, 1920);
  check('computeEntranceExit("fade") is back to full opacity well after the entrance window', approx(fadeMidway.opacityMul, 1));

  const slideUp = computeEntranceExit('slide-up', 0, 5, 5, 1080, 1920);
  check('computeEntranceExit("slide-up") offsets Y at entrance (real position motion, not just opacity)', slideUp.offsetYPx !== 0);

  const slideLeft = computeEntranceExit('slide-left', 0, 5, 5, 1080, 1920);
  check('computeEntranceExit("slide-left") offsets X at entrance', slideLeft.offsetXPx !== 0);

  const zoomIn = computeEntranceExit('zoom', 0, 5, 5, 1080, 1920);
  check('computeEntranceExit("zoom") scales down below 1 at entrance', zoomIn.scaleMul < 1);

  const popIn = computeEntranceExit('pop', 0.05, 5, 5, 1080, 1920);
  check('computeEntranceExit("pop") produces a non-identity scale near the very start (overshoot punch-in)', popIn.scaleMul !== 1);

  const unimplementedPreset = computeEntranceExit('shake' as any, 0, 5, 5, 1080, 1920);
  check(
    'computeEntranceExit falls back to a real fade (not a silent no-op) for a preset without bespoke motion',
    unimplementedPreset.opacityMul < 1,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
