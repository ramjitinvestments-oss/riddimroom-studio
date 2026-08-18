// Regression tests for "final production fix" Phase 1 — aspect ratio
// picker (single source of truth in lib/aspectRatios.ts, threaded through
// createDefaultProject/createProject) and the background-removal
// Original/Background-Removed toggle's pairing + in-place retargeting
// logic (linkBackgroundRemovedAsset, retargetItemsToAsset).
// Run with `npx tsx test-final-production-fix.mts`.

import { createDefaultProject } from './src/lib/projects/persistence.ts';
import { ASPECT_RATIO_OPTIONS, DEFAULT_ASPECT_RATIO, findAspectRatioOption } from './src/lib/aspectRatios.ts';
import { addMediaAsset, addItem, linkBackgroundRemovedAsset, retargetItemsToAsset, generateTimelineId } from './src/lib/timeline/utils.ts';
import type { ImageTimelineItem, MediaAsset } from './src/types/timeline';

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

// ---------------------------------------------------------------------------
// Aspect ratio
// ---------------------------------------------------------------------------

check('exactly 4 aspect ratio options are exposed', ASPECT_RATIO_OPTIONS.length === 4);
check('the 4 options are exactly 16:9, 9:16, 1:1, 4:5', ASPECT_RATIO_OPTIONS.map((o) => o.id).join(',') === '16:9,9:16,1:1,4:5');

for (const ratio of ASPECT_RATIO_OPTIONS) {
  const project = createDefaultProject('u1', 'Test', ratio.canvasWidth, ratio.canvasHeight);
  check(
    `createDefaultProject with ${ratio.id} produces canvasWidth=${ratio.canvasWidth}/canvasHeight=${ratio.canvasHeight}`,
    project.canvasWidth === ratio.canvasWidth && project.canvasHeight === ratio.canvasHeight,
  );
  check(
    `findAspectRatioOption round-trips ${ratio.id} back to the same option`,
    findAspectRatioOption(ratio.canvasWidth, ratio.canvasHeight)?.id === ratio.id,
  );
  // Every default track type must still exist regardless of chosen ratio —
  // the picker must not accidentally skip default-track setup.
  const trackTypes = project.tracks.map((t) => t.type).sort().join(',');
  check(`createDefaultProject with ${ratio.id} still creates all 5 default tracks`, trackTypes === 'audio,caption,image,text,video');
}

{
  const project = createDefaultProject('u2', 'No ratio specified');
  check(
    'createDefaultProject with no explicit ratio falls back to the historical 1080x1920 default',
    project.canvasWidth === DEFAULT_ASPECT_RATIO.canvasWidth && project.canvasHeight === DEFAULT_ASPECT_RATIO.canvasHeight,
  );
}

check('findAspectRatioOption returns null for dimensions matching no preset (e.g. a pre-feature project)', findAspectRatioOption(640, 480) === null);

// ---------------------------------------------------------------------------
// Background-removal pairing + in-place retargeting
// ---------------------------------------------------------------------------

function makeImageAsset(id: string, overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    kind: 'image',
    storageUrl: `https://example.com/${id}.png`,
    fileName: `${id}.png`,
    sizeBytes: 1000,
    mimeType: 'image/png',
    createdAt: 0,
    ...overrides,
  };
}

{
  let project = createDefaultProject('u3');
  project = addMediaAsset(project, makeImageAsset('orig1'));
  project = addMediaAsset(project, makeImageAsset('removed1'));
  project = linkBackgroundRemovedAsset(project, 'orig1', 'removed1');

  check('linkBackgroundRemovedAsset sets backgroundRemovedAssetId on the original', project.mediaAssets['orig1'].backgroundRemovedAssetId === 'removed1');
  check('linkBackgroundRemovedAsset sets originalAssetId on the removed-bg asset (reverse pointer)', project.mediaAssets['removed1'].originalAssetId === 'orig1');

  const beforeLink = createDefaultProject('u4');
  const afterNoOp = linkBackgroundRemovedAsset(beforeLink, 'does-not-exist', 'also-missing');
  check('linkBackgroundRemovedAsset is a safe no-op when either asset id does not exist', afterNoOp === beforeLink);
}

{
  // A watermark placed using the original asset must retarget to the
  // removed-background asset when toggled, and back again — without
  // touching any of its own position/scale/rotation/opacity fields.
  let project = createDefaultProject('u5');
  project = addMediaAsset(project, makeImageAsset('orig2'));
  project = addMediaAsset(project, makeImageAsset('removed2'));
  const imageTrack = project.tracks.find((t) => t.type === 'image')!;
  const watermark: ImageTimelineItem = {
    id: generateTimelineId('item'),
    type: 'image',
    trackId: imageTrack.id,
    startTime: 0,
    endTime: 5,
    zIndex: 0,
    visible: true,
    mediaAssetId: 'orig2',
    role: 'watermark',
    position: { x: 88, y: 92 },
    scale: 0.4,
    rotation: 12,
    opacity: 0.85,
  };
  project = addItem(project, watermark);

  const toggled = retargetItemsToAsset(project, 'orig2', 'removed2');
  const toggledItem = toggled.items.find((i) => i.id === watermark.id) as ImageTimelineItem;
  check('retargetItemsToAsset swaps a placed watermark item to the new asset id', toggledItem.mediaAssetId === 'removed2');
  check('retargetItemsToAsset preserves position/scale/rotation/opacity untouched', toggledItem.position.x === 88 && toggledItem.scale === 0.4 && toggledItem.rotation === 12 && toggledItem.opacity === 0.85);

  const toggledBack = retargetItemsToAsset(toggled, 'removed2', 'orig2');
  const backItem = toggledBack.items.find((i) => i.id === watermark.id) as ImageTimelineItem;
  check('retargetItemsToAsset can toggle back to the original', backItem.mediaAssetId === 'orig2');

  const untouched = retargetItemsToAsset(project, 'some-other-asset', 'removed2');
  const untouchedItem = untouched.items.find((i) => i.id === watermark.id) as ImageTimelineItem;
  check('retargetItemsToAsset ignores items that do not reference fromAssetId', untouchedItem.mediaAssetId === 'orig2');

  check('retargetItemsToAsset is a same-reference no-op when fromAssetId === toAssetId', retargetItemsToAsset(project, 'orig2', 'orig2') === project);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
