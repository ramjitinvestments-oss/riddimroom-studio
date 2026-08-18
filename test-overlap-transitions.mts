// Regression tests for "final production fix" Phase 2b — real overlap-based
// transitions between two adjacent clips on the same track
// (canApplyTransition/transitionAlreadyApplied/applyTransition in
// lib/timeline/utils.ts), generalizing the existing cross-dissolve
// mechanism to any preset in the transitions catalog. Run with
// `npx tsx test-overlap-transitions.mts`.

import {
  addMediaAsset,
  addItem,
  generateTimelineId,
  canApplyTransition,
  transitionAlreadyApplied,
  applyTransition,
  validateProject,
  type Project,
  type ImageTimelineItem,
  type MediaAsset,
} from './src/lib/timeline/index.ts';
import { createDefaultProject } from './src/lib/projects/persistence.ts';

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

function makeImageAsset(id: string): MediaAsset {
  return { id, kind: 'image', storageUrl: `https://example.com/${id}.png`, fileName: `${id}.png`, sizeBytes: 1000, mimeType: 'image/png', createdAt: 0 };
}

function twoAdjacentImageItems(): { project: Project; aId: string; bId: string } {
  let project = createDefaultProject('u1');
  const imageTrack = project.tracks.find((t) => t.type === 'image')!;
  project = addMediaAsset(project, makeImageAsset('imgA'));
  project = addMediaAsset(project, makeImageAsset('imgB'));
  const a: ImageTimelineItem = {
    id: generateTimelineId('item'),
    type: 'image',
    trackId: imageTrack.id,
    startTime: 0,
    endTime: 3,
    zIndex: 0,
    visible: true,
    mediaAssetId: 'imgA',
    role: 'overlay',
    position: { x: 50, y: 50 },
    scale: 1,
    rotation: 0,
    opacity: 1,
  };
  const b: ImageTimelineItem = { ...a, id: generateTimelineId('item'), startTime: 3, endTime: 6, mediaAssetId: 'imgB' };
  project = addItem(project, a);
  project = addItem(project, b);
  return { project, aId: a.id, bId: b.id };
}

// ---------------------------------------------------------------------------

{
  const { project, aId } = twoAdjacentImageItems();
  check('canApplyTransition is true for two adjacent same-track image items', canApplyTransition(project, aId));
  check('transitionAlreadyApplied is false before anything has been applied', !transitionAlreadyApplied(project, aId));
}

{
  let { project, aId, bId } = twoAdjacentImageItems();
  project = applyTransition(project, aId, 'slide-left', 0.5);
  const a = project.items.find((i) => i.id === aId) as ImageTimelineItem;
  const b = project.items.find((i) => i.id === bId) as ImageTimelineItem;

  check('applyTransition shifts the next clip earlier to create a real time overlap', b.startTime < a.endTime);
  check('the overlap is (approximately) the requested duration', Math.abs(a.endTime - b.startTime - 0.5) < 0.01);
  check('applyTransition sets the SAME preset as the first clip\'s exit', (a as any).animation?.exit === 'slide-left');
  check('applyTransition sets the SAME preset as the second clip\'s entrance', (b as any).animation?.entrance === 'slide-left');
  check('the first clip\'s own startTime is untouched', a.startTime === 0);
  check('applying a transition still produces a well-formed, valid project', validateProject(project).valid === true, JSON.stringify(validateProject(project).errors));

  check('transitionAlreadyApplied is now true at the same duration (guards against cumulative re-shifting)', transitionAlreadyApplied(project, aId, 0.5));
}

{
  // Different preset, different default duration (from the catalog) —
  // proves this isn't hardcoded to cross-dissolve's fixed 0.6s.
  let { project, aId, bId } = twoAdjacentImageItems();
  project = applyTransition(project, aId, 'snap-zoom'); // no explicit duration -> catalog default (0.25s)
  const a = project.items.find((i) => i.id === aId) as ImageTimelineItem;
  const b = project.items.find((i) => i.id === bId) as ImageTimelineItem;
  check('applyTransition with no explicit duration uses the preset\'s own catalog default', Math.abs(a.endTime - b.startTime - 0.25) < 0.01);
  check('a different preset name is reflected on both sides', (a as any).animation?.exit === 'snap-zoom' && (b as any).animation?.entrance === 'snap-zoom');
}

{
  // No adjacent next item — must be a safe, unchanged no-op, not a throw.
  let project = createDefaultProject('u2');
  const imageTrack = project.tracks.find((t) => t.type === 'image')!;
  project = addMediaAsset(project, makeImageAsset('solo'));
  const solo: ImageTimelineItem = {
    id: generateTimelineId('item'),
    type: 'image',
    trackId: imageTrack.id,
    startTime: 0,
    endTime: 3,
    zIndex: 0,
    visible: true,
    mediaAssetId: 'solo',
    role: 'overlay',
    position: { x: 50, y: 50 },
    scale: 1,
    rotation: 0,
    opacity: 1,
  };
  project = addItem(project, solo);
  check('canApplyTransition is false with no adjacent next item', !canApplyTransition(project, solo.id));
  const after = applyTransition(project, solo.id, 'fade');
  check('applyTransition is a same-reference no-op with no adjacent next item', after === project);
}

{
  // Applying a transition twice in a row must not cumulatively shift the
  // boundary further and further left each click — same guard
  // crossDissolveAlreadyApplied already provides for the plain-dissolve
  // control, generalized here.
  let { project, aId, bId } = twoAdjacentImageItems();
  project = applyTransition(project, aId, 'fade', 0.5);
  const firstStart = (project.items.find((i) => i.id === bId) as ImageTimelineItem).startTime;
  project = applyTransition(project, aId, 'fade', 0.5);
  const secondStart = (project.items.find((i) => i.id === bId) as ImageTimelineItem).startTime;
  check('re-applying the same transition/duration does not further shift an already-overlapping boundary', Math.abs(firstStart - secondStart) < 0.01);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
