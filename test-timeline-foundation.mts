// Timeline foundation verification harness — exercises the real types,
// utils, validation, and serialization modules (no mocks). Run with
// `npx tsx test-timeline-foundation.mts`. Mirrors the PASS/FAIL style of
// test-auth-integration.mjs (Step 2's harness) for consistency.

import {
  createEmptyProject,
  createTrack,
  addTrack,
  addItem,
  addMediaAsset,
  getItemDuration,
  getProjectDuration,
  itemsOverlapInTime,
  getItemsAtTime,
  getItemsByTrackType,
  expectedTrackTypeFor,
  validateProject,
  assertValidProject,
  serializeProject,
  deserializeProject,
  parseProject,
  type Project,
  type VideoTimelineItem,
  type ImageTimelineItem,
  type TextTimelineItem,
  type CaptionTimelineItem,
  type AudioTimelineItem,
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

// ---------------------------------------------------------------------------
// Build a realistic multi-track project: main video + overlay video + logo
// watermark + title text + AI captions + music + voiceover. Deliberately
// exercises every track type and every "independent timeline item, not a
// property of the main clip" requirement from the approved architecture.
// ---------------------------------------------------------------------------

function buildSampleProject(): Project {
  let project = createEmptyProject({ ownerUid: 'uid_test123', name: 'Sample multi-track project', now: 1000 });

  const videoTrack = createTrack('video', 'Main Video', 0);
  const overlayVideoTrack = createTrack('video', 'Overlay Video', 1);
  const imageTrack = createTrack('image', 'Watermark', 0);
  const textTrack = createTrack('text', 'Titles', 0);
  const captionTrack = createTrack('caption', 'AI Captions', 0);
  const audioTrack = createTrack('audio', 'Original Audio', 0);
  const musicTrack = createTrack('audio', 'Music', 1);
  const voiceoverTrack = createTrack('audio', 'Voiceover', 2);

  for (const t of [videoTrack, overlayVideoTrack, imageTrack, textTrack, captionTrack, audioTrack, musicTrack, voiceoverTrack]) {
    project = addTrack(project, t);
  }

  project = addMediaAsset(project, {
    id: 'asset_main_video', kind: 'video', storageUrl: 'gs://bucket/main.mp4',
    fileName: 'main.mp4', sizeBytes: 5_000_000, mimeType: 'video/mp4', durationSeconds: 20, width: 1080, height: 1920, createdAt: 1000,
  });
  project = addMediaAsset(project, {
    id: 'asset_overlay_video', kind: 'video', storageUrl: 'gs://bucket/overlay.mp4',
    fileName: 'overlay.mp4', sizeBytes: 1_200_000, mimeType: 'video/mp4', durationSeconds: 5, width: 720, height: 720, createdAt: 1000,
  });
  project = addMediaAsset(project, {
    id: 'asset_logo', kind: 'image', storageUrl: 'gs://bucket/logo.png',
    fileName: 'logo.png', sizeBytes: 40_000, mimeType: 'image/png', width: 512, height: 512, createdAt: 1000,
  });
  project = addMediaAsset(project, {
    id: 'asset_music', kind: 'audio', storageUrl: 'gs://bucket/music.mp3',
    fileName: 'music.mp3', sizeBytes: 3_000_000, mimeType: 'audio/mpeg', durationSeconds: 20, createdAt: 1000,
  });
  project = addMediaAsset(project, {
    id: 'asset_voiceover', kind: 'audio', storageUrl: 'gs://bucket/vo.mp3',
    fileName: 'vo.mp3', sizeBytes: 1_500_000, mimeType: 'audio/mpeg', durationSeconds: 10, createdAt: 1000,
  });

  const mainVideo: VideoTimelineItem = {
    id: 'item_main_video', type: 'video', trackId: videoTrack.id, startTime: 0, endTime: 20, zIndex: 0, visible: true,
    mediaAssetId: 'asset_main_video', trimStart: 0, trimEnd: 20, speed: 1, reverse: false, volume: 1, muted: false,
    position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 1,
  };
  // The overlay video is its OWN independent item, on its OWN track, with its
  // own timing/position — never a property bag on mainVideo. This is the
  // specific architectural requirement being verified here.
  const overlayVideo: VideoTimelineItem = {
    id: 'item_overlay_video', type: 'video', trackId: overlayVideoTrack.id, startTime: 5, endTime: 10, zIndex: 1, visible: true,
    mediaAssetId: 'asset_overlay_video', trimStart: 0, trimEnd: 5, speed: 1, reverse: false, volume: 0.5, muted: false,
    position: { x: 75, y: 25 }, scale: 0.4, rotation: 0, opacity: 1,
  };
  const watermark: ImageTimelineItem = {
    id: 'item_watermark', type: 'image', trackId: imageTrack.id, startTime: 0, endTime: 20, zIndex: 10, visible: true,
    mediaAssetId: 'asset_logo', role: 'watermark',
    position: { x: 90, y: 90 }, scale: 0.15, rotation: 0, opacity: 0.8,
  };
  const title: TextTimelineItem = {
    id: 'item_title', type: 'text', trackId: textTrack.id, startTime: 0, endTime: 3, zIndex: 20, visible: true,
    text: 'RiddimRoom Studio', role: 'title', font: 'Inter', fontSize: 64, color: '#ffffff',
    position: { x: 50, y: 15 }, scale: 1, rotation: 0, opacity: 1,
    fade: { fadeInDuration: 0.3, fadeOutDuration: 0.3 },
  };
  const captions: CaptionTimelineItem = {
    id: 'item_captions', type: 'caption', trackId: captionTrack.id, startTime: 0, endTime: 4, zIndex: 30, visible: true,
    words: [
      { text: 'Welcome', start: 0, end: 0.6 },
      { text: 'to', start: 0.6, end: 0.8 },
      { text: 'RiddimRoom', start: 0.8, end: 1.6 },
    ],
    captionStyleId: 'style_hype', source: 'ai', editable: true,
  };
  const originalAudio: AudioTimelineItem = {
    id: 'item_original_audio', type: 'audio', trackId: audioTrack.id, startTime: 0, endTime: 20, zIndex: 0, visible: true,
    mediaAssetId: 'asset_main_video', role: 'original', volume: 1, muted: false, trimStart: 0, trimEnd: 20,
    fade: { fadeInDuration: 0, fadeOutDuration: 0.5 },
  };
  const music: AudioTimelineItem = {
    id: 'item_music', type: 'audio', trackId: musicTrack.id, startTime: 0, endTime: 20, zIndex: 0, visible: true,
    mediaAssetId: 'asset_music', role: 'music', volume: 0.3, muted: false, trimStart: 0, trimEnd: 20,
    fade: { fadeInDuration: 1, fadeOutDuration: 2 },
  };
  const voiceover: AudioTimelineItem = {
    id: 'item_voiceover', type: 'audio', trackId: voiceoverTrack.id, startTime: 2, endTime: 12, zIndex: 0, visible: true,
    mediaAssetId: 'asset_voiceover', role: 'voiceover', volume: 1, muted: false, trimStart: 0, trimEnd: 10,
    fade: { fadeInDuration: 0.2, fadeOutDuration: 0.2 },
  };

  for (const item of [mainVideo, overlayVideo, watermark, title, captions, originalAudio, music, voiceover]) {
    project = addItem(project, item);
  }
  return project;
}

async function main() {
  console.log('=== Timeline foundation verification ===\n');

  // --- Construction & queries ---
  const project = buildSampleProject();
  check('sample project has 8 tracks', project.tracks.length === 8, `got ${project.tracks.length}`);
  check('sample project has 8 items', project.items.length === 8, `got ${project.items.length}`);
  check('sample project has 5 media assets', Object.keys(project.mediaAssets).length === 5, `got ${Object.keys(project.mediaAssets).length}`);

  check('getItemDuration computes endTime - startTime', getItemDuration({ startTime: 5, endTime: 10 }) === 5);
  check('getProjectDuration finds the latest endTime across items', getProjectDuration(project) === 20, `got ${getProjectDuration(project)}`);

  const mainVideoItem = project.items.find((i) => i.id === 'item_main_video')!;
  const overlayVideoItem = project.items.find((i) => i.id === 'item_overlay_video')!;
  check('overlay video is a distinct item object from main video (independent timeline item, not a property)', mainVideoItem !== overlayVideoItem);
  check('overlay video sits on its own trackId, different from main video track', overlayVideoItem.trackId !== mainVideoItem.trackId);
  check('itemsOverlapInTime detects the main video / overlay video overlap (0-20 vs 5-10)', itemsOverlapInTime(mainVideoItem, overlayVideoItem));

  const itemsAtT7 = getItemsAtTime(project, 7);
  // At t=7s: main video, overlay video, watermark, original audio, music, voiceover are all active (title/captions ended by t=4).
  check('getItemsAtTime(7) returns 6 concurrently-active items', itemsAtT7.length === 6, `got ${itemsAtT7.length}: ${itemsAtT7.map((i) => i.id).join(', ')}`);

  const videoLayerItems = getItemsByTrackType(project, 'video');
  check('getItemsByTrackType("video") returns exactly the 2 video items, sorted by zIndex', videoLayerItems.length === 2 && videoLayerItems[0].id === 'item_main_video' && videoLayerItems[1].id === 'item_overlay_video');

  check('expectedTrackTypeFor(caption item) is "caption"', expectedTrackTypeFor(project.items.find((i) => i.id === 'item_captions')!) === 'caption');

  // --- Validation: valid project passes ---
  const validResult = validateProject(project);
  check('validateProject accepts the well-formed sample project', validResult.valid, JSON.stringify(validResult.errors));
  try {
    assertValidProject(project);
    check('assertValidProject does not throw on valid project', true);
  } catch (err) {
    check('assertValidProject does not throw on valid project', false, String(err));
  }

  // --- Validation: invalid data is rejected, not silently accepted ---
  const badEndTime: Project = { ...project, items: project.items.map((i) => (i.id === 'item_main_video' ? { ...i, endTime: -5 } : i)) };
  const badEndTimeResult = validateProject(badEndTime);
  check('validateProject rejects endTime <= startTime', !badEndTimeResult.valid && badEndTimeResult.errors.some((e) => e.path.includes('endTime')));

  const wrongTrackType: Project = {
    ...project,
    items: project.items.map((i) => (i.id === 'item_title' ? { ...i, trackId: project.tracks.find((t) => t.type === 'audio')!.id } : i)),
  };
  const wrongTrackTypeResult = validateProject(wrongTrackType);
  check('validateProject rejects a text item placed on an audio track', !wrongTrackTypeResult.valid && wrongTrackTypeResult.errors.some((e) => e.message.includes('must sit on a')));

  const danglingTrackRef: Project = { ...project, items: project.items.map((i) => (i.id === 'item_main_video' ? { ...i, trackId: 'track_does_not_exist' } : i)) };
  const danglingTrackResult = validateProject(danglingTrackRef);
  check('validateProject rejects an item referencing a non-existent track', !danglingTrackResult.valid && danglingTrackResult.errors.some((e) => e.message.includes('does not exist')));

  const danglingMediaRef: Project = { ...project, items: project.items.map((i) => (i.id === 'item_main_video' ? { ...i, mediaAssetId: 'asset_does_not_exist' } : i)) };
  const danglingMediaResult = validateProject(danglingMediaRef);
  check('validateProject rejects an item referencing a non-existent media asset', !danglingMediaResult.valid && danglingMediaResult.errors.some((e) => e.message.includes('does not exist in this project')));

  const badOpacity: Project = { ...project, items: project.items.map((i) => (i.id === 'item_watermark' ? { ...i, opacity: 5 } : i)) };
  const badOpacityResult = validateProject(badOpacity);
  check('validateProject rejects opacity outside 0-1', !badOpacityResult.valid && badOpacityResult.errors.some((e) => e.path.includes('opacity')));

  const wordOutOfRange: Project = {
    ...project,
    items: project.items.map((i) => (i.id === 'item_captions' && i.type === 'caption' ? { ...i, words: [...i.words, { text: 'late', start: 3, end: 999 }] } : i)),
  };
  const wordOutOfRangeResult = validateProject(wordOutOfRange);
  check('validateProject rejects a caption word timing beyond the item\'s own duration', !wordOutOfRangeResult.valid && wordOutOfRangeResult.errors.some((e) => e.message.includes("item's own duration")));

  const duplicateItemIds: Project = { ...project, items: [...project.items, { ...project.items[0] }] };
  const duplicateResult = validateProject(duplicateItemIds);
  check('validateProject rejects duplicate item ids', !duplicateResult.valid && duplicateResult.errors.some((e) => e.message.includes('Duplicate item id')));

  let threwOnInvalid = false;
  try {
    assertValidProject(badEndTime);
  } catch {
    threwOnInvalid = true;
  }
  check('assertValidProject throws on invalid project', threwOnInvalid);

  // --- Serialization round-trip ---
  const serialized = serializeProject(project, 12345);
  check('serializeProject stamps updatedAt with the provided timestamp', serialized.updatedAt === 12345);
  check('serializeProject output is plain-JSON-safe (round-trips through JSON.stringify/parse unchanged)', JSON.stringify(JSON.parse(JSON.stringify(serialized))) === JSON.stringify(serialized));

  const { project: deserialized, errors: deserializeErrors } = deserializeProject(serialized);
  check('deserializeProject accepts a project that was just serialized', deserialized !== null, deserializeErrors.join('; '));
  check('deserializeProject round-trip preserves item count', deserialized?.items.length === project.items.length);
  check('deserializeProject round-trip preserves track count', deserialized?.tracks.length === project.tracks.length);
  check('deserializeProject round-trip preserves a specific nested value (watermark opacity)', deserialized?.items.find((i) => i.id === 'item_watermark')?.opacity === 0.8);

  const parsed = parseProject(serialized);
  check('parseProject succeeds end-to-end on a valid serialized project', parsed.project !== null, JSON.stringify(parsed.validation?.errors));

  // --- Serialization rejects garbage ---
  const garbageResult = deserializeProject({ foo: 'bar' });
  check('deserializeProject rejects an object missing required fields', garbageResult.project === null && garbageResult.errors.length > 0);

  const nullResult = deserializeProject(null);
  check('deserializeProject rejects null', nullResult.project === null);

  const stringResult = deserializeProject('not an object');
  check('deserializeProject rejects a non-object', stringResult.project === null);

  const structurallyOkButInvalid = parseProject(badEndTime as unknown);
  check('parseProject returns null project but surfaces validation errors for structurally-ok-but-business-rule-invalid data', structurallyOkButInvalid.project === null && (structurallyOkButInvalid.validation?.errors.length ?? 0) > 0);

  // --- Firestore-safety: undefined fields are stripped, never written as literal undefined ---
  const withUndefined = { ...mainVideoItem, crop: undefined } as VideoTimelineItem;
  const projectWithUndefined: Project = { ...project, items: project.items.map((i) => (i.id === 'item_main_video' ? withUndefined : i)) };
  const serializedWithUndefined = serializeProject(projectWithUndefined, 1);
  const serializedMainVideo = serializedWithUndefined.items.find((i) => i.id === 'item_main_video') as VideoTimelineItem;
  check('serializeProject strips explicit undefined fields rather than keeping them', !('crop' in serializedMainVideo));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
