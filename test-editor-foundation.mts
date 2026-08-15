// Phase 1 Steps 6/8/9/11/12 verification — pure-logic tests for the new
// editor-facing timeline helpers (insert.ts, utils.updateItem) and the
// export output validator. No DOM, no Firebase, no server — everything
// exercised here is plain TypeScript.
import { createEmptyProject, createTrack, addTrack, updateItem, getItemsForTrack } from './src/lib/timeline/utils';
import { appendMediaToTimeline, addTextItem, addWatermarkItem, addCaptionItems } from './src/lib/timeline/insert';
import { validateProject } from './src/lib/timeline/validation';
import { validateRenderResult } from './src/lib/export/validate';
import { validateMediaFile } from './src/lib/media/validate';
import { mediaKindForMimeType } from './src/lib/media/probe';
import type { MediaAsset } from './src/types/timeline';

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

function defaultProject() {
  let project = createEmptyProject({ ownerUid: 'test-uid', now: 1000 });
  const specs: Array<[import('./src/types/timeline').TrackType, string]> = [
    ['video', 'Main Video'],
    ['image', 'Watermark'],
    ['text', 'Text'],
    ['caption', 'Captions'],
    ['audio', 'Original Audio'],
  ];
  specs.forEach(([type, name], i) => {
    project = addTrack(project, createTrack(type, name, i));
  });
  return project;
}

function videoAsset(id: string, durationSeconds = 10): MediaAsset {
  return {
    id,
    kind: 'video',
    storageUrl: `https://example.com/${id}.mp4`,
    fileName: `${id}.mp4`,
    sizeBytes: 1_000_000,
    mimeType: 'video/mp4',
    durationSeconds,
    width: 1080,
    height: 1920,
    createdAt: 0,
  };
}

function imageAsset(id: string): MediaAsset {
  return {
    id,
    kind: 'image',
    storageUrl: `https://example.com/${id}.png`,
    fileName: `${id}.png`,
    sizeBytes: 10_000,
    mimeType: 'image/png',
    width: 512,
    height: 512,
    createdAt: 0,
  };
}

async function main() {
  // --- appendMediaToTimeline -------------------------------------------
  let project = defaultProject();
  const asset1 = videoAsset('asset1', 8);
  project = appendMediaToTimeline(project, asset1);
  check('appendMediaToTimeline registers the media asset', !!project.mediaAssets['asset1']);
  const videoTrack = project.tracks.find((t) => t.type === 'video')!;
  const videoItems = getItemsForTrack(project, videoTrack.id);
  check('appendMediaToTimeline places exactly one item on the video track', videoItems.length === 1);
  check('appendMediaToTimeline uses the asset duration for endTime', videoItems[0].endTime === 8);

  const asset2 = videoAsset('asset2', 5);
  project = appendMediaToTimeline(project, asset2);
  const videoItems2 = getItemsForTrack(project, videoTrack.id);
  check('Second video item is placed sequentially after the first (no overlap)', videoItems2[1].startTime === 8 && videoItems2[1].endTime === 13);

  let validation = validateProject(project);
  check('Project with two sequential video items validates cleanly', validation.valid, JSON.stringify(validation.errors));

  // --- addTextItem --------------------------------------------------------
  project = addTextItem(project, { text: 'Hello world', atTime: 1, durationSeconds: 2 });
  const textTrack = project.tracks.find((t) => t.type === 'text')!;
  const textItems = getItemsForTrack(project, textTrack.id);
  check('addTextItem places a text item on the text track', textItems.length === 1 && textItems[0].type === 'text');
  check('addTextItem respects atTime/duration', textItems[0].startTime === 1 && textItems[0].endTime === 3);

  // --- addWatermarkItem -----------------------------------------------
  const wmAsset = imageAsset('logo1');
  project = addWatermarkItem(project, { asset: wmAsset, atTime: 0, durationSeconds: 13 });
  const imageTrack = project.tracks.find((t) => t.type === 'image')!;
  const imageItems = getItemsForTrack(project, imageTrack.id);
  check('addWatermarkItem places an image item with role watermark', imageItems.length === 1 && imageItems[0].type === 'image' && (imageItems[0] as any).role === 'watermark');
  check('addWatermarkItem registers the watermark asset in mediaAssets', !!project.mediaAssets['logo1']);

  // --- addCaptionItems (chunking) --------------------------------------
  const words = [
    { text: 'hello', start: 0, end: 0.4 },
    { text: 'world', start: 0.5, end: 0.9 },
    { text: 'this', start: 1.0, end: 1.3 },
    { text: 'is', start: 1.35, end: 1.5 },
    { text: 'a', start: 1.55, end: 1.6 },
    { text: 'long', start: 1.65, end: 2.0 },
    { text: 'sentence', start: 2.1, end: 2.6 },
    { text: 'spanning', start: 6.0, end: 6.5 }, // big gap -> forces a new cue at maxCue boundary too
    { text: 'far', start: 6.6, end: 6.9 },
  ];
  project = addCaptionItems(project, { words, atTime: 0, captionStyleId: 'classic', source: 'ai', maxCueDurationSeconds: 4 });
  const captionTrack = project.tracks.find((t) => t.type === 'caption')!;
  const captionItems = getItemsForTrack(project, captionTrack.id);
  check('addCaptionItems produces at least one caption cue', captionItems.length >= 1);
  check('addCaptionItems chunks a long transcript into multiple cues rather than one giant item', captionItems.length >= 2, `got ${captionItems.length}`);
  const allWordsFlat = captionItems.flatMap((c: any) => c.words.length);
  check('Every caption cue has a non-empty words array', allWordsFlat.every((n: number) => n > 0));

  validation = validateProject(project);
  check('Full project (video + text + watermark + captions) still validates cleanly', validation.valid, JSON.stringify(validation.errors));

  // --- updateItem -----------------------------------------------------
  const firstTextId = textItems[0].id;
  project = updateItem(project, firstTextId, { text: 'Updated text', fontSize: 60 });
  const updatedText = project.items.find((i) => i.id === firstTextId) as any;
  check('updateItem patches the requested fields', updatedText.text === 'Updated text' && updatedText.fontSize === 60);
  check('updateItem leaves other fields untouched', updatedText.color === '#ffffff');

  // --- validateMediaFile ------------------------------------------------
  const fakeGoodFile = new File([new Uint8Array(1000)], 'clip.mp4', { type: 'video/mp4' });
  check('validateMediaFile accepts a normal video file', validateMediaFile(fakeGoodFile).valid);
  const fakeEmptyFile = new File([], 'empty.mp4', { type: 'video/mp4' });
  check('validateMediaFile rejects a 0-byte file', !validateMediaFile(fakeEmptyFile).valid);
  const fakeBadType = new File([new Uint8Array(10)], 'doc.pdf', { type: 'application/pdf' });
  check('validateMediaFile rejects an unsupported mime type', !validateMediaFile(fakeBadType).valid);
  const fakeHuge = new File([new Uint8Array(10)], 'huge.mp4', { type: 'video/mp4' });
  Object.defineProperty(fakeHuge, 'size', { value: 600 * 1024 * 1024 });
  check('validateMediaFile rejects a file over the size ceiling', !validateMediaFile(fakeHuge).valid);

  check('mediaKindForMimeType maps video/image/audio correctly', mediaKindForMimeType('video/mp4') === 'video' && mediaKindForMimeType('image/png') === 'image' && mediaKindForMimeType('audio/mpeg') === 'audio');
  check('mediaKindForMimeType returns null for unsupported types', mediaKindForMimeType('application/pdf') === null);

  // --- validateRenderResult ---------------------------------------------
  const goodBlob = new Blob([new Uint8Array(50_000)], { type: 'video/webm' });
  check('validateRenderResult accepts a reasonably-sized webm blob', validateRenderResult(goodBlob, 5).valid);
  const emptyBlob = new Blob([], { type: 'video/webm' });
  check('validateRenderResult rejects a 0-byte export', !validateRenderResult(emptyBlob, 5).valid);
  const tinyBlob = new Blob([new Uint8Array(10)], { type: 'video/webm' });
  check('validateRenderResult rejects a suspiciously small export (likely CORS-tainted canvas)', !validateRenderResult(tinyBlob, 30).valid);
  const wrongTypeBlob = new Blob([new Uint8Array(50_000)], { type: 'text/plain' });
  check('validateRenderResult rejects a non-video mime type', !validateRenderResult(wrongTypeBlob, 5).valid);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exitCode = 1;
});
