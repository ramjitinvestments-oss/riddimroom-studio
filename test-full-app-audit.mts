// Full-app audit verification harness — exercises the fixes/additions made
// during the "full application audit + repair" pass:
//   - layer ordering (bringForward/sendBackward/bringToFront/sendToBack),
//     wired into ItemInspector's new "Layer" buttons but previously
//     unreachable from any UI even though `zIndex` always existed;
//   - the on-canvas selection/resize geometry helper `getItemBoundsPercent`,
//     which PreviewPane now uses to draw real drag/resize handles;
//   - `computeFadeOpacity` being exported and applied to standalone
//     AudioTimelineItem gain (both live preview and export), fixing a fade
//     in/out that previously had zero audible effect.
// Run with `npx tsx test-full-app-audit.mts`. No mocks — exercises the real
// modules the editor UI calls, same PASS/FAIL style as the other harnesses.

import {
  createEmptyProject,
  createTrack,
  addTrack,
  addItem,
  type Project,
  type VideoTimelineItem,
  type ImageTimelineItem,
  type TextTimelineItem,
  type CaptionTimelineItem,
  type MediaAsset,
} from './src/lib/timeline/index.ts';
import { bringForward, sendBackward, bringToFront, sendToBack, isVisualItem } from './src/lib/timeline/utils.ts';
import { getItemBoundsPercent, computeFadeOpacity } from './src/lib/render/compositor.ts';
import { appendMediaToTimeline } from './src/lib/timeline/insert.ts';
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
function approx(a: number, b: number, eps = 0.01): boolean {
  return Math.abs(a - b) < eps;
}

// ---------------------------------------------------------------------------
// Layer ordering
// ---------------------------------------------------------------------------

function buildLayeredProject(): Project {
  let p = createEmptyProject({ ownerUid: 'u1' });
  p = addTrack(p, createTrack('video', 'Main Video', 0));
  p = addTrack(p, createTrack('image', 'Overlay', 1));
  p = addTrack(p, createTrack('text', 'Text', 2));
  p = addTrack(p, createTrack('audio', 'Audio', 3));
  const videoTrack = p.tracks[0];
  const imageTrack = p.tracks[1];
  const textTrack = p.tracks[2];

  const video: VideoTimelineItem = {
    id: 'video1', type: 'video', trackId: videoTrack.id, startTime: 0, endTime: 5, zIndex: 0, visible: true,
    mediaAssetId: 'asset-video', position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 1,
    trimStart: 0, trimEnd: 5, speed: 1, reverse: false, volume: 1, muted: false,
  };
  const image: ImageTimelineItem = {
    id: 'image1', type: 'image', trackId: imageTrack.id, startTime: 0, endTime: 5, zIndex: 1, visible: true,
    mediaAssetId: 'asset-image', role: 'overlay', position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 1,
  };
  const text: TextTimelineItem = {
    id: 'text1', type: 'text', trackId: textTrack.id, startTime: 0, endTime: 5, zIndex: 2, visible: true,
    text: 'hello', role: 'overlay', font: 'Arial', fontSize: 48, color: '#fff', position: { x: 50, y: 20 }, scale: 1, rotation: 0, opacity: 1,
  };
  p = addItem(p, video);
  p = addItem(p, image);
  p = addItem(p, text);
  return p;
}

{
  const p = buildLayeredProject();
  const zOf = (proj: Project, id: string) => proj.items.find((i) => i.id === id)!.zIndex;

  check('isVisualItem is true for video/image/text/caption', isVisualItem({ type: 'video' } as any) && isVisualItem({ type: 'caption' } as any));
  check('isVisualItem is false for audio', !isVisualItem({ type: 'audio' } as any));

  const afterForward = bringForward(p, 'video1'); // video1 (z=0) should swap with image1 (z=1)
  check('bringForward swaps with the next-higher item', zOf(afterForward, 'video1') === 1 && zOf(afterForward, 'image1') === 0);

  const afterFront = bringToFront(p, 'video1');
  check('bringToFront puts the item above every other visual item', zOf(afterFront, 'video1') > zOf(afterFront, 'image1') && zOf(afterFront, 'video1') > zOf(afterFront, 'text1'));

  const afterBack = sendToBack(p, 'text1');
  check('sendToBack puts the item below every other visual item', zOf(afterBack, 'text1') < zOf(afterBack, 'video1') && zOf(afterBack, 'text1') < zOf(afterBack, 'image1'));

  const afterBackward = sendBackward(p, 'text1'); // text1 (z=2) should swap with image1 (z=1)
  check('sendBackward swaps with the next-lower item', zOf(afterBackward, 'text1') === 1 && zOf(afterBackward, 'image1') === 2);

  const frontmost = bringForward(afterFront, 'video1'); // already frontmost after afterFront
  check('bringForward is a no-op on the already-frontmost item', zOf(frontmost, 'video1') === zOf(afterFront, 'video1'));

  const audioNoop = bringForward(p, 'nonexistent-audio-item-id');
  check('bringForward on a non-existent item id is a safe no-op', audioNoop === p);
}

// ---------------------------------------------------------------------------
// On-canvas selection geometry (getItemBoundsPercent) — must match the
// exact sizing rules drawVideoItem/drawImageItem use, per its own doc
// comment, so the selection box a user drags is never out of sync with
// what's actually rendered.
// ---------------------------------------------------------------------------

{
  const canvasWidth = 1080;
  const canvasHeight = 1920;

  const videoBounds = getItemBoundsPercent({ position: { x: 50, y: 50 }, scale: 1 }, 'video', canvasWidth, canvasHeight);
  check(
    'video item at scale 1 fills the full canvas (0-100% in both axes)',
    approx(videoBounds.leftPercent, 0) && approx(videoBounds.topPercent, 0) && approx(videoBounds.widthPercent, 100) && approx(videoBounds.heightPercent, 100),
    JSON.stringify(videoBounds),
  );

  const videoHalfScale = getItemBoundsPercent({ position: { x: 50, y: 50 }, scale: 0.5 }, 'video', canvasWidth, canvasHeight);
  check(
    'video item at scale 0.5 is centered and half-size',
    approx(videoHalfScale.widthPercent, 50) && approx(videoHalfScale.leftPercent, 25),
    JSON.stringify(videoHalfScale),
  );

  // Square source image (aspect 1), scale 1 -> 25% of canvas width per drawImageItem's own convention.
  const imageBounds = getItemBoundsPercent({ position: { x: 50, y: 50 }, scale: 1 }, 'image', canvasWidth, canvasHeight, { naturalImageAspect: 1 });
  check('image item at scale 1 is 25% of canvas width, centered', approx(imageBounds.widthPercent, 25) && approx(imageBounds.leftPercent, 37.5), JSON.stringify(imageBounds));

  // A wide (2:1) source image should be proportionally shorter, not stretched to square.
  const wideImageBounds = getItemBoundsPercent({ position: { x: 50, y: 50 }, scale: 1 }, 'image', canvasWidth, canvasHeight, { naturalImageAspect: 0.5 });
  check(
    'image item aspect ratio is preserved (not stretched) — a 2:1 source is proportionally shorter than a 1:1 source',
    wideImageBounds.heightPercent < imageBounds.heightPercent,
    JSON.stringify({ wideImageBounds, imageBounds }),
  );

  const textBounds = getItemBoundsPercent({ position: { x: 50, y: 80 }, scale: 1 }, 'text', canvasWidth, canvasHeight, { textWidthPx: 200, textHeightPx: 60 });
  check(
    'text item bounding box is centered on its measured width/height, converted to canvas percentages',
    approx(textBounds.widthPercent, (200 / canvasWidth) * 100) && approx(textBounds.heightPercent, (60 / canvasHeight) * 100),
    JSON.stringify(textBounds),
  );
}

// ---------------------------------------------------------------------------
// Audio fade gain — AudioTimelineItem.fade previously had no effect
// anywhere (not in live preview, not in export); computeFadeOpacity is now
// applied to the Web Audio gain in both PreviewPane.tsx and
// canvas2dRenderer.ts using this exact function.
// ---------------------------------------------------------------------------

{
  const fade = { fadeInDuration: 1, fadeOutDuration: 2 };
  check('computeFadeOpacity is silent (0) at the very start of a fade-in', computeFadeOpacity(fade, 0, 100) === 0);
  check('computeFadeOpacity is at half volume halfway through a 1s fade-in', approx(computeFadeOpacity(fade, 0.5, 100), 0.5));
  check('computeFadeOpacity is at full volume once past the fade-in window', computeFadeOpacity(fade, 1.5, 100) === 1);
  check('computeFadeOpacity ramps down during the fade-out window', approx(computeFadeOpacity(fade, 100, 1), 0.5));
  check('computeFadeOpacity is silent (0) at the very end of a fade-out', computeFadeOpacity(fade, 100, 0) === 0);
  check('computeFadeOpacity is full volume (1) with no fade configured at all', computeFadeOpacity(undefined, 0, 100) === 1);
}

// ---------------------------------------------------------------------------
// Regression test for the "NaNs total" bug found via live browser testing
// (full-app audit): `lib/media/probe.ts` was reading a probed <video>/
// <audio> element's `.duration`/`.videoWidth`/`.videoHeight` AFTER its own
// `cleanup()` had already reset the element (`removeAttribute('src')` +
// `.load()`), so every real upload produced a genuine `NaN` `durationSeconds`
// on the resulting `MediaAsset` — not intermittently, but on every single
// upload. That bug lived inside a browser-only DOM code path (probe.ts
// itself can't run in this Node/tsx harness — no jsdom in this project, and
// jsdom wouldn't simulate real video decode timing anyway), so it isn't
// re-tested directly here. What IS fully unit-testable, and is the second,
// defensive layer added alongside the probe.ts fix, is `insert.ts`'s
// `appendMediaToTimeline`: even if some future probing path (or a
// genuinely malformed asset record) hands it a `NaN`/`Infinity`/negative
// `durationSeconds` again, the resulting TimelineItem's `endTime` must
// never inherit it — `?? fallback` alone does NOT catch `NaN` (nullish
// coalescing only substitutes for `null`/`undefined`), which is exactly
// how the corruption slipped through undetected before.
// ---------------------------------------------------------------------------

{
  const badDurations: Array<number | undefined> = [NaN, Infinity, -Infinity, -5, 0, undefined];
  for (const bad of badDurations) {
    let p = createDefaultProject('u2');
    const asset: MediaAsset = {
      id: 'asset-bad-video',
      kind: 'video',
      storageUrl: 'https://example.com/fake.mp4',
      fileName: 'fake.mp4',
      sizeBytes: 1000,
      mimeType: 'video/mp4',
      durationSeconds: bad,
      width: undefined,
      height: undefined,
      createdAt: 0,
    };
    p = appendMediaToTimeline(p, asset);
    const item = p.items.find((i) => i.mediaAssetId === asset.id)!;
    check(
      `appendMediaToTimeline never produces a non-finite endTime for a video asset with durationSeconds=${bad}`,
      Number.isFinite(item.endTime) && item.endTime > item.startTime,
      `endTime=${item.endTime}`,
    );
  }

  // Same defensive layer applies to the audio branch.
  let p = createDefaultProject('u3');
  const audioAsset: MediaAsset = {
    id: 'asset-bad-audio',
    kind: 'audio',
    storageUrl: 'https://example.com/fake.mp3',
    fileName: 'fake.mp3',
    sizeBytes: 1000,
    mimeType: 'audio/mpeg',
    durationSeconds: NaN,
    createdAt: 0,
  };
  p = appendMediaToTimeline(p, audioAsset);
  const audioItem = p.items.find((i) => i.mediaAssetId === audioAsset.id)!;
  check(
    'appendMediaToTimeline never produces a non-finite endTime for an audio asset with durationSeconds=NaN',
    Number.isFinite(audioItem.endTime) && audioItem.endTime > audioItem.startTime,
    `endTime=${audioItem.endTime}`,
  );

  // A genuinely valid duration must still be used as-is (the fallback must
  // not swallow legitimate values).
  let p2 = createDefaultProject('u4');
  const goodAsset: MediaAsset = {
    id: 'asset-good-video',
    kind: 'video',
    storageUrl: 'https://example.com/real.mp4',
    fileName: 'real.mp4',
    sizeBytes: 1000,
    mimeType: 'video/mp4',
    durationSeconds: 12.5,
    createdAt: 0,
  };
  p2 = appendMediaToTimeline(p2, goodAsset);
  const goodItem = p2.items.find((i) => i.mediaAssetId === goodAsset.id)!;
  check(
    'appendMediaToTimeline uses a legitimate finite durationSeconds as-is (fallback does not swallow real values)',
    approx(goodItem.endTime - goodItem.startTime, 12.5),
    `duration=${goodItem.endTime - goodItem.startTime}`,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
