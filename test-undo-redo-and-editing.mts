// "Final editor completion" pass verification harness — exercises the new
// pure undo/redo history module (`src/lib/history`), the cross-dissolve
// helpers, and the caption "Add Word" helper (all added in
// `src/lib/timeline/utils.ts`). Run with
// `npx tsx test-undo-redo-and-editing.mts`. Mirrors the PASS/FAIL style of
// the other test-*.mts harnesses — no mocks, exercises the real modules
// ProjectContext/ItemInspector call.

import {
  emptyHistory,
  pushHistory,
  undoHistory,
  redoHistory,
  shouldCoalesce,
  DEFAULT_MAX_HISTORY_LENGTH,
} from './src/lib/history/index.ts';
import {
  createEmptyProject,
  createTrack,
  addTrack,
  addItem,
  addMediaAsset,
  findAdjacentNextItem,
  canCrossDissolve,
  crossDissolveAlreadyApplied,
  applyCrossDissolve,
  addCaptionWord,
  validateProject,
  type Project,
  type VideoTimelineItem,
  type CaptionTimelineItem,
} from './src/lib/timeline/index.ts';

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
// Undo/redo history — pure, framework-free (see lib/history/index.ts)
// ---------------------------------------------------------------------------
{
  // Basic push/undo/redo round trip.
  let h = emptyHistory<number>();
  h = pushHistory(h, 0, { coalesce: false }); // state was 0 before this edit -> now "1"
  const afterUndo = undoHistory(h, 1);
  check('undoHistory returns the previous snapshot', afterUndo.value === 0);
  check('undoHistory moves the undone state onto the future stack', afterUndo.history.future.length === 1 && afterUndo.history.future[0] === 1);
  check('undoHistory empties past after undoing the only edit', afterUndo.history.past.length === 0);

  const afterRedo = redoHistory(afterUndo.history, afterUndo.value as number);
  check('redoHistory returns the value that was undone', afterRedo.value === 1);
  check('redoHistory moves it back onto the past stack', afterRedo.history.past.length === 1 && afterRedo.history.past[0] === 0);
  check('redoHistory empties future after redoing the only step', afterRedo.history.future.length === 0);

  // Undo/redo with nothing to do.
  const emptyUndo = undoHistory(emptyHistory<number>(), 5);
  check('undoHistory on empty history returns null value and unchanged history', emptyUndo.value === null && emptyUndo.history.past.length === 0);
  const emptyRedo = redoHistory(emptyHistory<number>(), 5);
  check('redoHistory on empty history returns null value and unchanged history', emptyRedo.value === null);

  // A new edit after an undo clears the redo branch.
  let h2 = emptyHistory<string>();
  h2 = pushHistory(h2, 'a', { coalesce: false }); // -> 'b'
  const undone = undoHistory(h2, 'b'); // back to 'a', future=['b']
  check('sanity: redo branch has the undone edit before a new edit happens', undone.history.future.length === 1);
  const afterNewEdit = pushHistory(undone.history, 'a', { coalesce: false }); // user makes a fresh edit from 'a' -> 'c'
  check('a new edit after undo clears the redo branch', afterNewEdit.future.length === 0);

  // Coalescing: rapid edits fold into one undo step.
  let h3 = emptyHistory<number>();
  h3 = pushHistory(h3, 0, { coalesce: false }); // first edit of a burst: real checkpoint at 0
  h3 = pushHistory(h3, 1, { coalesce: true }); // second edit of the same burst: should NOT add another checkpoint
  h3 = pushHistory(h3, 2, { coalesce: true }); // third edit of the same burst: same
  check('coalesced edits do not grow the past stack beyond the burst\'s first checkpoint', h3.past.length === 1 && h3.past[0] === 0);
  const undoneBurst = undoHistory(h3, 3);
  check('undoing a coalesced burst returns all the way to the state before the burst started (one drag = one undo step)', undoneBurst.value === 0);

  // History length is capped.
  let h4 = emptyHistory<number>();
  for (let i = 0; i < DEFAULT_MAX_HISTORY_LENGTH + 10; i++) {
    h4 = pushHistory(h4, i, { coalesce: false, maxLength: 5 });
  }
  check('pushHistory caps past length at maxLength (no unbounded history growth)', h4.past.length === 5);
  check('pushHistory keeps the MOST RECENT snapshots when capping, not the oldest', h4.past[h4.past.length - 1] === DEFAULT_MAX_HISTORY_LENGTH + 9);

  // shouldCoalesce.
  check('shouldCoalesce is true for a rapid follow-up edit', shouldCoalesce(50, 700) === true);
  check('shouldCoalesce is false once the coalesce window has elapsed', shouldCoalesce(1000, 700) === false);
  check('shouldCoalesce treats exactly-at-the-boundary as NOT coalescing (half-open window)', shouldCoalesce(700, 700) === false);
}

// ---------------------------------------------------------------------------
// Cross Dissolve
// ---------------------------------------------------------------------------

function buildTwoClipProject(): Project {
  let project = createEmptyProject({ ownerUid: 'uid_test', name: 'Cross-dissolve test', now: 1000 });
  const videoTrack = createTrack('video', 'Main Video', 0);
  const captionTrack = createTrack('caption', 'Captions', 0);
  project = addTrack(project, videoTrack);
  project = addTrack(project, captionTrack);
  project = addMediaAsset(project, {
    id: 'asset_a', kind: 'video', storageUrl: 'gs://bucket/a.mp4',
    fileName: 'a.mp4', sizeBytes: 1, mimeType: 'video/mp4', durationSeconds: 10, width: 1080, height: 1920, createdAt: 1000,
  });
  project = addMediaAsset(project, {
    id: 'asset_b', kind: 'video', storageUrl: 'gs://bucket/b.mp4',
    fileName: 'b.mp4', sizeBytes: 1, mimeType: 'video/mp4', durationSeconds: 10, width: 1080, height: 1920, createdAt: 1000,
  });
  const itemA: VideoTimelineItem = {
    type: 'video', id: 'item_a', trackId: videoTrack.id, startTime: 0, endTime: 5, zIndex: 0, visible: true,
    mediaAssetId: 'asset_a', speed: 1, reverse: false, volume: 1, muted: false, trimStart: 0, trimEnd: 5,
    position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 1,
  };
  const itemB: VideoTimelineItem = {
    type: 'video', id: 'item_b', trackId: videoTrack.id, startTime: 5, endTime: 10, zIndex: 0, visible: true,
    mediaAssetId: 'asset_b', speed: 1, reverse: false, volume: 1, muted: false, trimStart: 0, trimEnd: 5,
    position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 1,
  };
  const captionItem: CaptionTimelineItem = {
    type: 'caption', id: 'item_caption', trackId: captionTrack.id, startTime: 0, endTime: 3, zIndex: 0, visible: true,
    words: [{ text: 'hi', start: 0, end: 0.5 }], captionStyleId: 'classic', source: 'manual', editable: true,
  };
  project = addItem(project, itemA);
  project = addItem(project, itemB);
  project = addItem(project, captionItem);
  return project;
}

{
  const project = buildTwoClipProject();

  const next = findAdjacentNextItem(project, 'item_a');
  check('findAdjacentNextItem finds the back-to-back next clip on the same track', next?.id === 'item_b');
  check('findAdjacentNextItem returns undefined for a clip with nothing after it', findAdjacentNextItem(project, 'item_b') === undefined);
  check('findAdjacentNextItem returns undefined for a caption item with no sibling on its track', findAdjacentNextItem(project, 'item_caption') === undefined);

  check('canCrossDissolve is true for two adjacent video items', canCrossDissolve(project, 'item_a') === true);
  check('canCrossDissolve is false for a caption item (no fade field / no sibling)', canCrossDissolve(project, 'item_caption') === false);
  check('crossDissolveAlreadyApplied is false before any dissolve is applied', crossDissolveAlreadyApplied(project, 'item_a') === false);

  const dissolved = applyCrossDissolve(project, 'item_a', 0.6);
  const a = dissolved.items.find((i) => i.id === 'item_a') as VideoTimelineItem;
  const b = dissolved.items.find((i) => i.id === 'item_b') as VideoTimelineItem;
  check('applyCrossDissolve pulls the next clip earlier so it overlaps the first by the dissolve duration', approx(b.startTime, a.endTime - 0.6));
  check('applyCrossDissolve sets a real fadeOutDuration on the first clip', approx(a.fade?.fadeOutDuration ?? 0, 0.6));
  check('applyCrossDissolve sets a real fadeInDuration on the second clip', approx(b.fade?.fadeInDuration ?? 0, 0.6));
  check('applyCrossDissolve preserves the second clip\'s own duration (it moved, not shrank)', approx(b.endTime - b.startTime, 5));
  check('applyCrossDissolve result still validates as a well-formed project', validateProject(dissolved).valid);
  check('crossDissolveAlreadyApplied is now true (guards the UI from re-applying and cascading the shift)', crossDissolveAlreadyApplied(dissolved, 'item_a', 0.6) === true);

  // No-op when there's no adjacent item.
  const noopResult = applyCrossDissolve(project, 'item_b', 0.6);
  check('applyCrossDissolve is a no-op when there is no adjacent next item', noopResult.items.length === project.items.length && noopResult === project);

  // No-op for an item type without a fade field paired against nothing (caption has no sibling anyway).
  const captionResult = applyCrossDissolve(project, 'item_caption', 0.6);
  check('applyCrossDissolve is a no-op for an item with no adjacent clip to dissolve into', captionResult === project);
}

// ---------------------------------------------------------------------------
// Caption "Add Word"
// ---------------------------------------------------------------------------
{
  const project = buildTwoClipProject();

  // buildTwoClipProject's caption item starts with one pre-existing word
  // ("hi", 0-0.5s) — validateProject requires captions to have at least
  // one word, so an empty-words fixture isn't a valid starting point.
  // addCaptionWord's own "start=0 for an empty caption" branch is
  // exercised separately below via a dedicated empty-caption project.
  const withFirstWord = addCaptionWord(project, 'item_caption', 'hello');
  const captionAfterFirst = withFirstWord.items.find((i) => i.id === 'item_caption') as CaptionTimelineItem;
  check(
    'addCaptionWord appends a word with the requested text, after the pre-existing word',
    captionAfterFirst.words.length === 2 && captionAfterFirst.words[1].text === 'hello',
  );
  check(
    'addCaptionWord starts the new word at/after the previous last word\'s end (chronological placement)',
    captionAfterFirst.words[1].start >= captionAfterFirst.words[0].end,
  );
  check('addCaptionWord never produces reversed timing (end > start)', captionAfterFirst.words[1].end > captionAfterFirst.words[1].start);

  const withSecondWord = addCaptionWord(withFirstWord, 'item_caption', 'world');
  const captionAfterSecond = withSecondWord.items.find((i) => i.id === 'item_caption') as CaptionTimelineItem;
  check('addCaptionWord appends a third word, not replacing the earlier ones', captionAfterSecond.words.length === 3);
  check(
    'addCaptionWord maintains chronological ordering — each new word starts at/after the previous word\'s end',
    captionAfterSecond.words[2].start >= captionAfterSecond.words[1].end && captionAfterSecond.words[1].start >= captionAfterSecond.words[0].end,
  );
  check('addCaptionWord never produces a negative start time', captionAfterSecond.words.every((w) => w.start >= 0));
  check('addCaptionWord result still validates as a well-formed project', validateProject(withSecondWord).valid);

  // Dedicated empty-caption case: the very first word added should start at t=0.
  let emptyCaptionProject = createEmptyProject({ ownerUid: 'uid_test', name: 'Empty caption test', now: 1000 });
  const soloCaptionTrack = createTrack('caption', 'Captions', 0);
  emptyCaptionProject = addTrack(emptyCaptionProject, soloCaptionTrack);
  const emptyCaption: CaptionTimelineItem = {
    type: 'caption', id: 'empty_caption', trackId: soloCaptionTrack.id, startTime: 0, endTime: 3, zIndex: 0, visible: true,
    words: [{ text: 'placeholder', start: 0, end: 0.3 }], captionStyleId: 'classic', source: 'manual', editable: true,
  };
  emptyCaptionProject = addItem(emptyCaptionProject, emptyCaption);
  // Remove the placeholder word via a direct patch to genuinely test the "empty caption" branch of addCaptionWord in isolation.
  emptyCaptionProject = {
    ...emptyCaptionProject,
    items: emptyCaptionProject.items.map((i) => (i.id === 'empty_caption' ? { ...(i as CaptionTimelineItem), words: [] } : i)),
  };
  const firstWordEver = addCaptionWord(emptyCaptionProject, 'empty_caption', 'first');
  const firstWordItem = firstWordEver.items.find((i) => i.id === 'empty_caption') as CaptionTimelineItem;
  check('addCaptionWord on a genuinely empty caption places the first word at start=0', approx(firstWordItem.words[0].start, 0) && firstWordItem.words[0].text === 'first');

  // No-op for a non-caption item.
  const noopResult = addCaptionWord(project, 'item_a', 'nope');
  check('addCaptionWord is a no-op when the target item is not a caption', noopResult === project);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
