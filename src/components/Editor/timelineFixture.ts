/**
 * R26 WS-T1 — reference project fixture for the timeline perf harness.
 *
 * 20 items, ~60s, mixed video/image/text/caption/audio across 5 tracks.
 * Main track (video + photo images) ends at exactly 60s, so
 * getProjectDuration(project) === getMaxItemEnd(project) === 60.
 * Deterministic ids/timestamps so harness numbers are reproducible.
 */
import type { Project, TimelineItem, MediaAsset, Track } from '../../types/timeline';
import { TIMELINE_SCHEMA_VERSION } from '../../types/timeline';

const T = { x: 50, y: 50 };

function asset(id: string, kind: MediaAsset['kind'], fileName: string, durationSeconds?: number): MediaAsset {
  return {
    id,
    kind,
    storageUrl: `https://example.invalid/${fileName}`,
    fileName,
    sizeBytes: 1024,
    mimeType: kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : 'image/jpeg',
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(kind !== 'audio' ? { width: 1080, height: 1920 } : {}),
    createdAt: 1_700_000_000_000,
  };
}

export function buildReferenceProject(): Project {
  const tracks: Track[] = [
    { id: 'track-video', type: 'video', name: 'Main Video', order: 0, visible: true, locked: false },
    { id: 'track-image', type: 'image', name: 'Images', order: 1, visible: true, locked: false },
    { id: 'track-text', type: 'text', name: 'Text', order: 2, visible: true, locked: false },
    { id: 'track-caption', type: 'caption', name: 'Captions', order: 3, visible: true, locked: false },
    { id: 'track-audio', type: 'audio', name: 'Music', order: 4, visible: true, locked: false, muted: false },
  ];
  const mediaAssets: Record<string, MediaAsset> = {};
  const items: TimelineItem[] = [];
  const base = { zIndex: 0, visible: true };

  for (let i = 0; i < 6; i++) {
    const aid = `asset-vid-${i}`;
    mediaAssets[aid] = asset(aid, 'video', `clip-${i}.mp4`, 10);
    items.push({
      ...base, id: `item-video-${i}`, type: 'video', trackId: 'track-video',
      startTime: i * 10, endTime: i * 10 + 10, mediaAssetId: aid,
      position: { ...T }, scale: 1, rotation: 0, opacity: 1,
      trimStart: 0, trimEnd: 10, speed: 1, reverse: false, volume: 1, muted: false,
    });
  }
  for (let i = 0; i < 3; i++) {
    const aid = `asset-img-${i}`;
    mediaAssets[aid] = asset(aid, 'image', `photo-${i}.jpg`);
    items.push({
      ...base, id: `item-image-${i}`, type: 'image', trackId: 'track-image',
      startTime: i * 20, endTime: i * 20 + 20, mediaAssetId: aid, role: 'photo',
      position: { ...T }, scale: 1, rotation: 0, opacity: 1,
    });
  }
  const texts = ['Intro title', 'Middle beat', 'Offer callout', 'Final card'];
  texts.forEach((text, i) => {
    const start = [0, 15, 30, 45][i];
    items.push({
      ...base, id: `item-text-${i}`, type: 'text', trackId: 'track-text',
      startTime: start, endTime: start + 8, text, role: 'title',
      font: 'Anton', fontSize: 64, color: '#ffffff',
      position: { ...T }, scale: 1, rotation: 0, opacity: 1,
    });
  });
  [2, 22, 42].forEach((start, i) => {
    items.push({
      ...base, id: `item-caption-${i}`, type: 'caption', trackId: 'track-caption',
      startTime: start, endTime: start + 8, captionStyleId: 'bold', source: 'manual', editable: true,
      words: [
        { text: 'hello', start: 0, end: 0.4 },
        { text: 'world', start: 0.5, end: 0.9 },
      ],
    });
  });
  for (let i = 0; i < 4; i++) {
    const aid = `asset-aud-${i}`;
    mediaAssets[aid] = asset(aid, 'audio', `song-${i}.mp3`, 15);
    items.push({
      ...base, id: `item-audio-${i}`, type: 'audio', trackId: 'track-audio',
      startTime: i * 15, endTime: i * 15 + 15, mediaAssetId: aid, role: 'music',
      trimStart: 0, trimEnd: 15, volume: 0.8, muted: false,
      fade: { fadeInDuration: 0, fadeOutDuration: 0 },
    });
  }

  return {
    id: 'project-reference',
    ownerUid: 'test-uid',
    name: 'R26 Reference Project',
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    tracks,
    items,
    mediaAssets,
    canvasWidth: 1080,
    canvasHeight: 1920,
    frameRate: 30,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

/**
 * R36 ghosting fixture: 12s main video + a 40s PiP video (the longest
 * video, so the project ends at 40 under the longest-video law) under
 * a 180s song. The end line must sit at 40 and only audio past 40
 * ghosts.
 */
export function buildPipLongestProject(): Project {
  const project = buildReferenceProject();
  const vidAsset = asset('asset-main', 'video', 'main.mp4', 12);
  const pipAsset = asset('asset-pip', 'video', 'pip.mp4', 40);
  const songAsset = asset('asset-song', 'audio', 'song.mp3', 180);
  return {
    ...project,
    id: 'project-pip-longest',
    tracks: [
      { id: 'track-video', type: 'video', name: 'Main Video', order: 0, visible: true, locked: false },
      { id: 'track-audio', type: 'audio', name: 'Music', order: 1, visible: true, locked: false, muted: false },
    ],
    mediaAssets: { [vidAsset.id]: vidAsset, [pipAsset.id]: pipAsset, [songAsset.id]: songAsset },
    items: [
      {
        id: 'item-main', type: 'video', trackId: 'track-video', startTime: 0, endTime: 12,
        zIndex: 0, visible: true, mediaAssetId: vidAsset.id,
        position: { ...T }, scale: 1, rotation: 0, opacity: 1,
        trimStart: 0, trimEnd: 12, speed: 1, reverse: false, volume: 1, muted: false,
      },
      {
        id: 'item-pip', type: 'video', trackId: 'track-video', startTime: 0, endTime: 40,
        zIndex: 1, visible: true, mediaAssetId: pipAsset.id,
        position: { x: 80, y: 80 }, scale: 0.3, rotation: 0, opacity: 1,
        trimStart: 0, trimEnd: 40, speed: 1, reverse: false, volume: 1, muted: true,
        pip: { isPip: true, shape: 'rounded', borderWidth: 0, borderColor: '#000000', shadow: false },
      },
      {
        id: 'item-song', type: 'audio', trackId: 'track-audio', startTime: 0, endTime: 180,
        zIndex: 0, visible: true, mediaAssetId: songAsset.id, role: 'music',
        trimStart: 0, trimEnd: 180, volume: 0.8, muted: false,
        fade: { fadeInDuration: 0, fadeOutDuration: 0 },
      },
    ],
  };
}

/** WS-A2 ghosting fixture: 12s main video under a 180s song. */
export function buildGhostProject(): Project {
  const project = buildReferenceProject();
  const vidAsset = asset('asset-main', 'video', 'main.mp4', 12);
  const songAsset = asset('asset-song', 'audio', 'song.mp3', 180);
  return {
    ...project,
    id: 'project-ghost',
    tracks: [
      { id: 'track-video', type: 'video', name: 'Main Video', order: 0, visible: true, locked: false },
      { id: 'track-audio', type: 'audio', name: 'Music', order: 1, visible: true, locked: false, muted: false },
    ],
    mediaAssets: { [vidAsset.id]: vidAsset, [songAsset.id]: songAsset },
    items: [
      {
        id: 'item-main', type: 'video', trackId: 'track-video', startTime: 0, endTime: 12,
        zIndex: 0, visible: true, mediaAssetId: vidAsset.id,
        position: { ...T }, scale: 1, rotation: 0, opacity: 1,
        trimStart: 0, trimEnd: 12, speed: 1, reverse: false, volume: 1, muted: false,
      },
      {
        id: 'item-song', type: 'audio', trackId: 'track-audio', startTime: 0, endTime: 180,
        zIndex: 0, visible: true, mediaAssetId: songAsset.id, role: 'music',
        trimStart: 0, trimEnd: 180, volume: 0.8, muted: false,
        fade: { fadeInDuration: 0, fadeOutDuration: 0 },
      },
    ],
  };
}
