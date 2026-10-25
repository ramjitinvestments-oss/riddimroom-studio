import { describe, it, expect } from 'vitest';
import { createEmptyProject, createTrack, addTrack, getItemsAtTime, removeItem } from './utils';
import { appendMediaToTimeline, addCaptionItems, addManualCaptionCue, addTextItem, addWatermarkItem } from './insert';
import { createDefaultProject } from '../projects/persistence';
import { MAX_MEDIA_SECONDS } from '../media/constants';
import type { MediaAsset } from '../../types/timeline';

/**
 * "Universal 30-second media standard" focused tests — item 9 of the spec
 * ("Add focused tests for: 30-second media acceptance, 30-second media
 * detection"). Covers `appendMediaToTimeline`'s trim-window handling: the
 * pre-import trim/select modal flow (explicit `trimStart`/`trimEnd`), the
 * camera-capture clamp flow (same options, different caller), and the
 * defensive fallback for any asset handed in with no options at all.
 */

function projectWithVideoAndAudioTracks() {
  let project = createEmptyProject({ ownerUid: 'test-uid' });
  project = addTrack(project, createTrack('video', 'Video', 0));
  project = addTrack(project, createTrack('audio', 'Audio', 0));
  return project;
}

function videoAsset(durationSeconds: number): MediaAsset {
  return {
    id: 'asset-video-1',
    kind: 'video',
    storageUrl: 'https://example.com/video.mp4',
    fileName: 'video.mp4',
    sizeBytes: 1_000_000,
    mimeType: 'video/mp4',
    durationSeconds,
    width: 1080,
    height: 1920,
    createdAt: 0,
  };
}

function audioAsset(durationSeconds: number): MediaAsset {
  return {
    id: 'asset-audio-1',
    kind: 'audio',
    storageUrl: 'https://example.com/song.mp3',
    fileName: 'song.mp3',
    sizeBytes: 500_000,
    mimeType: 'audio/mpeg',
    durationSeconds,
    createdAt: 0,
  };
}

describe('appendMediaToTimeline — media acceptance (v1: 600s cap)', () => {
  it('places a within-limit video at its full duration when no trim window is supplied', () => {
    const project = projectWithVideoAndAudioTracks();
    const next = appendMediaToTimeline(project, videoAsset(12));
    const item = next.items[0];
    if (item.type !== 'video') throw new Error('expected a video item');
    expect(item.endTime - item.startTime).toBeCloseTo(12, 5);
    expect(item.trimStart).toBe(0);
    expect(item.trimEnd).toBeCloseTo(12, 5);
  });

  it('places a within-limit audio upload/song segment at its full duration', () => {
    const project = projectWithVideoAndAudioTracks();
    const next = appendMediaToTimeline(project, audioAsset(25));
    const item = next.items[0];
    if (item.type !== 'audio') throw new Error('expected an audio item');
    expect(item.endTime - item.startTime).toBeCloseTo(25, 5);
  });
});

describe('appendMediaToTimeline — media detection / enforcement (v1: 600s cap)', () => {
  it('defensively caps an over-length asset at MAX_MEDIA_SECONDS even with no explicit trim window', () => {
    const project = projectWithVideoAndAudioTracks();
    const next = appendMediaToTimeline(project, videoAsset(900)); // a real-world 15-minute upload, no trim options passed
    const item = next.items[0];
    if (item.type !== 'video') throw new Error('expected a video item');
    expect(item.endTime - item.startTime).toBeCloseTo(MAX_MEDIA_SECONDS, 5);
  });

  it('honors an explicit pre-import trim/select window from the over-length upload flow', () => {
    const project = projectWithVideoAndAudioTracks();
    // A 140s source; the user scrubbed to 01:12 -> 01:36 (24s selection).
    const next = appendMediaToTimeline(project, videoAsset(140), { trimStart: 72, trimEnd: 96 });
    const item = next.items[0];
    if (item.type !== 'video') throw new Error('expected a video item');
    expect(item.trimStart).toBeCloseTo(72, 5);
    expect(item.trimEnd).toBeCloseTo(96, 5);
    expect(item.endTime - item.startTime).toBeCloseTo(24, 5);
  });

  it('clamps a supplied trim window that itself exceeds the cap (defense in depth against a modal bug)', () => {
    const project = projectWithVideoAndAudioTracks();
    const next = appendMediaToTimeline(project, videoAsset(900), { trimStart: 0, trimEnd: 700 });
    const item = next.items[0];
    if (item.type !== 'video') throw new Error('expected a video item');
    expect(item.endTime - item.startTime).toBeCloseTo(MAX_MEDIA_SECONDS, 5);
  });

  it('clamps a camera-capture-style trim window the same way for audio', () => {
    const project = projectWithVideoAndAudioTracks();
    const next = appendMediaToTimeline(project, audioAsset(900), { trimStart: 0, trimEnd: 700 });
    const item = next.items[0];
    if (item.type !== 'audio') throw new Error('expected an audio item');
    expect(item.endTime - item.startTime).toBeLessThanOrEqual(MAX_MEDIA_SECONDS + 0.001);
  });
});

describe('appendMediaToTimeline image placement (Add Overlay upload flow)', () => {
  function imageAsset(): MediaAsset {
    return {
      id: 'asset-image-1',
      kind: 'image',
      storageUrl: 'https://example.com/logo.png',
      fileName: 'logo.png',
      sizeBytes: 100_000,
      mimeType: 'image/png',
      width: 512,
      height: 512,
      createdAt: 0,
    };
  }

  function projectWithImageTrack() {
    let project = createEmptyProject({ ownerUid: 'test-uid' });
    project = addTrack(project, createTrack('image', 'Image', 0));
    return project;
  }

  it('defaults to the centered full-frame placement every image has always gotten', () => {
    const next = appendMediaToTimeline(projectWithImageTrack(), imageAsset());
    const item = next.items[0];
    if (item.type !== 'image') throw new Error('expected an image item');
    expect(item.position).toEqual({ x: 50, y: 50 });
    expect(item.scale).toBe(1);
    expect(item.role).toBe('photo');
  });

  it('honors an explicit overlay placement + role', () => {
    const next = appendMediaToTimeline(projectWithImageTrack(), imageAsset(), {
      role: 'overlay',
      position: { x: 82, y: 78 },
      scale: 0.32,
    });
    const item = next.items[0];
    if (item.type !== 'image') throw new Error('expected an image item');
    expect(item.position).toEqual({ x: 82, y: 78 });
    expect(item.scale).toBeCloseTo(0.32, 5);
    expect(item.role).toBe('overlay');
  });
});

describe('addManualCaptionCue — hand-typed caption creation (five-star audit fix)', () => {
  function projectWithCaptionTrack() {
    let project = createEmptyProject({ ownerUid: 'test-uid' });
    project = addTrack(project, createTrack('caption', 'Captions', 0));
    return project;
  }

  it('creates a manual cue at the playhead: one word spanning the cue, classic style, input unmutated', () => {
    const project = projectWithCaptionTrack();
    const next = addManualCaptionCue(project, { text: 'Small up yuhself', atTime: 3.5 });
    expect(project.items).toHaveLength(0);
    expect(next.items).toHaveLength(1);
    const item = next.items[0];
    if (item.type !== 'caption') throw new Error('expected a caption item');
    expect(item.source).toBe('manual');
    expect(item.editable).toBe(true);
    expect(item.startTime).toBeCloseTo(3.5, 5);
    expect(item.endTime).toBeCloseTo(5.5, 5); // 2s default
    expect(item.words).toEqual([{ text: 'Small up yuhself', start: 0, end: 2 }]);
    expect(item.captionStyleId).toBe('classic');
    expect(item.trackId).toBe(project.tracks[0].id);
  });

  it('inherits the style of the most recent existing cue instead of resetting the look', () => {
    let project = projectWithCaptionTrack();
    project = addCaptionItems(project, {
      words: [
        { text: 'first', start: 0, end: 0.5 },
        { text: 'cue', start: 0.5, end: 1 },
      ],
      atTime: 0,
      captionStyleId: 'bold-yellow',
      source: 'ai',
    });
    const next = addManualCaptionCue(project, { text: 'by hand', atTime: 2 });
    const manual = next.items.find((i) => i.type === 'caption' && i.source === 'manual');
    if (!manual || manual.type !== 'caption') throw new Error('expected a manual caption item');
    expect(manual.captionStyleId).toBe('bold-yellow');
    // An explicit style choice still wins over inheritance.
    const explicit = addManualCaptionCue(project, { text: 'styled', atTime: 4, captionStyleId: 'cinema' });
    const styled = explicit.items.find((i) => i.type === 'caption' && i.source === 'manual');
    if (!styled || styled.type !== 'caption') throw new Error('expected a manual caption item');
    expect(styled.captionStyleId).toBe('cinema');
  });

  it('clamps a negative playhead to 0 and enforces the minimum cue duration', () => {
    const project = projectWithCaptionTrack();
    const next = addManualCaptionCue(project, { text: 'clamped', atTime: -2, durationSeconds: 0.1 });
    const item = next.items[0];
    if (item.type !== 'caption') throw new Error('expected a caption item');
    expect(item.startTime).toBe(0);
    expect(item.endTime).toBeCloseTo(0.5, 5);
    expect(item.words[0].end).toBeCloseTo(0.5, 5);
  });
});

describe('normalizeVisualZOrder (main-clip swap keeps overlays visible)', () => {
  const videoAsset = (id: string): MediaAsset => ({
    id, kind: 'video', storageUrl: `https://x.test/${id}.mp4`, fileName: `${id}.mp4`,
    sizeBytes: 1, mimeType: 'video/mp4', durationSeconds: 6, createdAt: 0,
  });
  const imageAsset = (id: string): MediaAsset => ({
    id, kind: 'image', storageUrl: `https://x.test/${id}.png`, fileName: `${id}.png`,
    sizeBytes: 1, mimeType: 'image/png', width: 400, height: 200, createdAt: 0,
  });

  it('re-adding a main clip after a swap layers it UNDER existing logo + text', () => {
    let p = createDefaultProject('u1');
    p = appendMediaToTimeline(p, videoAsset('mainA'));
    p = addWatermarkItem(p, { asset: imageAsset('logo'), atTime: 0, durationSeconds: 6 });
    p = addTextItem(p, { text: 'HELLO', atTime: 0, durationSeconds: 6 });
    const mainA = p.items.find((i) => i.type === 'video')!;
    // the swap: remove the old main clip, append its replacement
    p = removeItem(p, mainA.id);
    p = appendMediaToTimeline(p, videoAsset('mainB'));
    const at = getItemsAtTime(p, 1);
    const order = at.map((i) => i.type);
    expect(order).toEqual(['video', 'image', 'text']);
    const mainB = p.items.find((i) => i.type === 'video')!;
    expect(mainB.zIndex).toBeLessThan(p.items.find((i) => i.type === 'image')!.zIndex);
  });

  it('keeps sequential main clips in append order among themselves', () => {
    let p = createDefaultProject('u1');
    p = appendMediaToTimeline(p, videoAsset('v1'));
    p = appendMediaToTimeline(p, videoAsset('v2'));
    const vids = p.items.filter((i) => i.type === 'video').sort((a, b) => a.zIndex - b.zIndex);
    expect(vids.map((v) => v.mediaAssetId)).toEqual(['v1', 'v2']);
  });
});
