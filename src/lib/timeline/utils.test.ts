import { describe, it, expect } from 'vitest';
import {
  createEmptyProject,
  createTrack,
  addTrack,
  addItem,
  addMediaAsset,
  generateTimelineId,
  trimItemEnd,
  setItemDuration,
  getProjectDuration,
  getMainTrackEnd,
  getMaxItemEnd,
  projectDurationExceedsLimit,
  applyTransition,
  getBoundaryTransition,
  updateItem,
  updateItemMotion,
  setItemSpeed,
  SPEED_MIN,
  SPEED_MAX,
  getContentEndTime,
  trimAudioToProjectEnd,
  loopAudioToProjectEnd,
  FIT_FADE_OUT_SECONDS,
} from './utils';
import { serializeProject, parseProject } from './serialization';
import { MAX_MEDIA_SECONDS } from '../media/constants';
import type { AudioTimelineItem, ImageTimelineItem, MediaAsset, Project, TextTimelineItem, VideoTimelineItem } from '../../types/timeline';

/**
 * v1 cap tests — MAX_MEDIA_SECONDS (600s / 10 min) replaces the old
 * 30-second standard. `image` items are used as fixtures because their
 * duration is freely adjustable (no source-media trim window), which
 * isolates exactly the per-item cap being tested.
 */

function makeItem(overrides: Partial<ImageTimelineItem> & { trackId: string }): ImageTimelineItem {
  return {
    id: generateTimelineId('item'),
    type: 'image',
    startTime: 0,
    endTime: 5,
    zIndex: 0,
    visible: true,
    mediaAssetId: 'asset1',
    role: 'photo',
    position: { x: 50, y: 50 },
    scale: 1,
    rotation: 0,
    opacity: 1,
    ...overrides,
  };
}

function projectWithImageItem(durationSeconds: number): { project: Project; itemId: string } {
  let project = createEmptyProject({ ownerUid: 'test-uid' });
  const track = createTrack('image', 'Image', 0);
  project = addTrack(project, track);
  const item = makeItem({ trackId: track.id, startTime: 0, endTime: durationSeconds });
  project = addItem(project, item);
  return { project, itemId: item.id };
}

describe('per-item cap (trimItemEnd / setItemDuration)', () => {
  it('trimItemEnd never lets an item exceed MAX_MEDIA_SECONDS, however far the new end time is dragged', () => {
    const { project, itemId } = projectWithImageItem(5);
    const next = trimItemEnd(project, itemId, MAX_MEDIA_SECONDS + 500);
    const updated = next.items.find((i) => i.id === itemId)!;
    expect(updated.endTime - updated.startTime).toBeCloseTo(MAX_MEDIA_SECONDS, 5);
  });

  it('setItemDuration clamps a requested duration above the limit (e.g. the inspector Duration field)', () => {
    const { project, itemId } = projectWithImageItem(5);
    const next = setItemDuration(project, itemId, 9999);
    const updated = next.items.find((i) => i.id === itemId)!;
    expect(updated.endTime - updated.startTime).toBeCloseTo(MAX_MEDIA_SECONDS, 5);
  });

  it('still allows shortening a clip within the limit — the cap must never block normal editing', () => {
    const { project, itemId } = projectWithImageItem(20);
    const next = setItemDuration(project, itemId, 10);
    const updated = next.items.find((i) => i.id === itemId)!;
    expect(updated.endTime - updated.startTime).toBeCloseTo(10, 5);
  });

  it('an item starting mid-timeline is capped relative to its own start, not to absolute time zero', () => {
    const { project, itemId } = projectWithImageItem(5);
    let withOffset = project;
    withOffset = { ...withOffset, items: withOffset.items.map((i) => (i.id === itemId ? { ...i, startTime: 100, endTime: 105 } : i)) };
    const next = trimItemEnd(withOffset, itemId, 1000);
    const updated = next.items.find((i) => i.id === itemId)!;
    expect(updated.startTime).toBe(100);
    expect(updated.endTime - updated.startTime).toBeCloseTo(MAX_MEDIA_SECONDS, 5);
  });
});

describe('project-level guard (projectDurationExceedsLimit)', () => {
  it('flags a project whose total duration exceeds the limit', () => {
    const { project } = projectWithImageItem(MAX_MEDIA_SECONDS + 1);
    expect(projectDurationExceedsLimit(project)).toBe(true);
  });

  it('does not flag a project within the limit', () => {
    const { project } = projectWithImageItem(MAX_MEDIA_SECONDS - 1);
    expect(projectDurationExceedsLimit(project)).toBe(false);
  });

  it('does not flag a project exactly at the limit', () => {
    const { project } = projectWithImageItem(MAX_MEDIA_SECONDS);
    expect(projectDurationExceedsLimit(project)).toBe(false);
  });

  it('three 10-second clips placed back to back sum to 30s and are allowed', () => {
    let project = createEmptyProject({ ownerUid: 'test-uid' });
    const track = createTrack('image', 'Image', 0);
    project = addTrack(project, track);
    for (let i = 0; i < 3; i++) {
      project = addItem(project, makeItem({ trackId: track.id, startTime: i * 10, endTime: i * 10 + 10, zIndex: i }));
    }
    expect(getProjectDuration(project)).toBeCloseTo(30, 5);
    expect(projectDurationExceedsLimit(project)).toBe(false);
  });

  it('clips summing past the limit ARE flagged', () => {
    let project = createEmptyProject({ ownerUid: 'test-uid' });
    const track = createTrack('image', 'Image', 0);
    project = addTrack(project, track);
    // Two clips: one MAX_MEDIA_SECONDS, one 10s after it -> total exceeds limit.
    project = addItem(project, makeItem({ trackId: track.id, startTime: 0, endTime: MAX_MEDIA_SECONDS, zIndex: 0 }));
    project = addItem(project, makeItem({ trackId: track.id, startTime: MAX_MEDIA_SECONDS, endTime: MAX_MEDIA_SECONDS + 10, zIndex: 1 }));
    expect(getProjectDuration(project)).toBeCloseTo(MAX_MEDIA_SECONDS + 10, 5);
    expect(projectDurationExceedsLimit(project)).toBe(true);
  });
});

describe('main-track duration semantics (R26 WS-A2: getMainTrackEnd / getProjectDuration)', () => {
  function makeVideo(overrides: Partial<VideoTimelineItem> & { trackId: string }): VideoTimelineItem {
    return {
      id: generateTimelineId('item'),
      type: 'video',
      startTime: 0,
      endTime: 12,
      zIndex: 0,
      visible: true,
      mediaAssetId: 'video-asset',
      position: { x: 50, y: 50 },
      scale: 1,
      rotation: 0,
      opacity: 1,
      trimStart: 0,
      trimEnd: 12,
      speed: 1,
      reverse: false,
      volume: 1,
      muted: false,
      ...overrides,
    };
  }

  function makeAudio(overrides: Partial<AudioTimelineItem> & { trackId: string }): AudioTimelineItem {
    return {
      id: generateTimelineId('item'),
      type: 'audio',
      startTime: 0,
      endTime: 180,
      zIndex: 1,
      visible: true,
      mediaAssetId: 'audio-asset',
      role: 'music',
      volume: 1,
      muted: false,
      trimStart: 0,
      trimEnd: 180,
      fade: { fadeInDuration: 0, fadeOutDuration: 0 },
      ...overrides,
    };
  }

  function makeText(overrides: Partial<TextTimelineItem> & { trackId: string }): TextTimelineItem {
    return {
      id: generateTimelineId('item'),
      type: 'text',
      startTime: 0,
      endTime: 7,
      zIndex: 0,
      visible: true,
      text: 'Hello',
      role: 'title',
      font: 'Arial',
      fontSize: 48,
      color: '#ffffff',
      position: { x: 50, y: 20 },
      scale: 1,
      rotation: 0,
      opacity: 1,
      ...overrides,
    };
  }

  function projectWithTracks(): { project: Project; ids: Record<string, string> } {
    let project = createEmptyProject({ ownerUid: 'test-uid' });
    const ids: Record<string, string> = {};
    (['video', 'image', 'text', 'caption', 'audio'] as const).forEach((type, i) => {
      const track = createTrack(type, type, i);
      ids[type] = track.id;
      project = addTrack(project, track);
    });
    return { project, ids };
  }

  it('(a) video main 12s + 180s song → main end and project duration are 12, max-end stays 180', () => {
    const { project: base, ids } = projectWithTracks();
    let project = addItem(base, makeVideo({ trackId: ids.video, startTime: 0, endTime: 12 }));
    project = addItem(project, makeAudio({ trackId: ids.audio, startTime: 0, endTime: 180 }));
    expect(getMainTrackEnd(project)).toBe(12);
    expect(getProjectDuration(project)).toBe(12);
    // The explicit max-end helper still reports the full extent for
    // consumers that need it (timeline extent, Fit-to-project).
    expect(getMaxItemEnd(project)).toBe(180);
    // Consumer regression (ProjectContext guard / licensing-style limit):
    // the long song no longer makes the project exceed a 30s limit.
    expect(projectDurationExceedsLimit(project, 30)).toBe(false);
  });

  it('(b) image-only main track: a photo on the image track defines duration over a long song', () => {
    const { project: base, ids } = projectWithTracks();
    let project = addItem(base, makeItem({ trackId: ids.image, startTime: 0, endTime: 8, role: 'photo' }));
    project = addItem(project, makeAudio({ trackId: ids.audio, startTime: 0, endTime: 180 }));
    expect(getMainTrackEnd(project)).toBe(8);
    expect(getProjectDuration(project)).toBe(8);
  });

  it('(b2) main content spans both primary tracks: video 0–12 followed by a photo 12–20 ends at 20', () => {
    const { project: base, ids } = projectWithTracks();
    let project = addItem(base, makeVideo({ trackId: ids.video, startTime: 0, endTime: 12 }));
    project = addItem(project, makeItem({ trackId: ids.image, startTime: 12, endTime: 20, role: 'photo' }));
    expect(getMainTrackEnd(project)).toBe(20);
    expect(getProjectDuration(project)).toBe(20);
  });

  it('(b3) non-main visuals do not extend the main end: PiP video, watermark and graphic stage art rules', () => {
    const { project: base, ids } = projectWithTracks();
    let project = addItem(base, makeVideo({ trackId: ids.video, startTime: 0, endTime: 12 }));
    // PiP overlay video running long is an overlay, not the main video.
    project = addItem(project, makeVideo({ trackId: ids.video, startTime: 0, endTime: 30, pip: { isPip: true, shape: 'circle', borderWidth: 0, borderColor: '#000000', shadow: false } }));
    // A watermark image running long is decoration, not main content.
    project = addItem(project, makeItem({ trackId: ids.image, startTime: 0, endTime: 50, role: 'watermark' }));
    expect(getMainTrackEnd(project)).toBe(12);
    expect(getProjectDuration(project)).toBe(12);
    // Promo stage artwork (role 'graphic', the recipes' main images) IS main content.
    project = addItem(project, makeItem({ trackId: ids.image, startTime: 0, endTime: 15, role: 'graphic' }));
    expect(getMainTrackEnd(project)).toBe(15);
  });

  it('(c) audio-only project → no main end, old max-end rule unchanged', () => {
    const { project: base, ids } = projectWithTracks();
    const project = addItem(base, makeAudio({ trackId: ids.audio, startTime: 0, endTime: 180 }));
    expect(getMainTrackEnd(project)).toBeNull();
    expect(getProjectDuration(project)).toBe(180);
    expect(getMaxItemEnd(project)).toBe(180);
  });

  it('(d) text-only project → no main end, old max-end rule unchanged', () => {
    const { project: base, ids } = projectWithTracks();
    const project = addItem(base, makeText({ trackId: ids.text, startTime: 0, endTime: 7 }));
    expect(getMainTrackEnd(project)).toBeNull();
    expect(getProjectDuration(project)).toBe(7);
  });

  it('(e) empty project → main end null, duration 0', () => {
    const { project } = projectWithTracks();
    expect(getMainTrackEnd(project)).toBeNull();
    expect(getProjectDuration(project)).toBe(0);
    expect(getMaxItemEnd(project)).toBe(0);
    expect(getMainTrackEnd(createEmptyProject({ ownerUid: 'test-uid' }))).toBeNull();
  });

  it('(f) a main item on a missing/mismatched track does not count — duration falls back to max-end', () => {
    const { project: base, ids } = projectWithTracks();
    // Video item pointing at the audio track (invalid placement): not on a
    // primary visual track, so no main end; the fallback keeps its span.
    const project = addItem(base, makeVideo({ trackId: ids.audio, startTime: 0, endTime: 12 }));
    expect(getMainTrackEnd(project)).toBeNull();
    expect(getProjectDuration(project)).toBe(12);
  });
});

function projectWithTwoAdjacentImageItems(): { project: Project; firstId: string; secondId: string } {
  let project = createEmptyProject({ ownerUid: 'test-uid' });
  const track = createTrack('image', 'Image', 0);
  project = addTrack(project, track);
  const first = makeItem({ trackId: track.id, startTime: 0, endTime: 5, zIndex: 0 });
  const second = makeItem({ trackId: track.id, startTime: 5, endTime: 10, zIndex: 1 });
  project = addItem(project, first);
  project = addItem(project, second);
  return { project, firstId: first.id, secondId: second.id };
}

describe('getBoundaryTransition (Phase 2.1 Transitions panel read-side)', () => {
  it('is undefined for back-to-back clips with no transition applied', () => {
    const { project, firstId } = projectWithTwoAdjacentImageItems();
    expect(getBoundaryTransition(project, firstId)).toBeUndefined();
  });

  it('reports the preset + overlap duration after applyTransition', () => {
    const { project, firstId } = projectWithTwoAdjacentImageItems();
    const next = applyTransition(project, firstId, 'fade');
    const boundary = getBoundaryTransition(next, firstId);
    expect(boundary?.preset).toBe('fade');
    // 'fade' catalog default is 0.45s — the overlap applyTransition created.
    expect(boundary?.durationSeconds).toBeCloseTo(0.45, 5);
  });

  it('is undefined for a lone hand-set entrance with no matching exit/overlap pair', () => {
    const { project, firstId, secondId } = projectWithTwoAdjacentImageItems();
    const next = updateItem(project, secondId, { animation: { entrance: 'fade' } });
    expect(getBoundaryTransition(next, firstId)).toBeUndefined();
  });
});

describe('updateItemMotion (Phase 2.1 shared motion setter)', () => {
  it('sets the effect type on a media item, defaulting the rest of the motion shape', () => {
    const { project, itemId } = projectWithImageItem(5);
    const next = updateItemMotion(project, itemId, { type: 'ken-burns' });
    const updated = next.items.find((i) => i.id === itemId) as ImageTimelineItem;
    expect(updated.motion?.type).toBe('ken-burns');
  });

  it('merges partial patches without wiping the chosen effect', () => {
    const { project, itemId } = projectWithImageItem(5);
    let next = updateItemMotion(project, itemId, { type: 'parallax', direction: 'left' });
    next = updateItemMotion(next, itemId, { intensity: 1.5 });
    const updated = next.items.find((i) => i.id === itemId) as ImageTimelineItem;
    expect(updated.motion).toEqual({ type: 'parallax', direction: 'left', intensity: 1.5 });
  });

  it('is a no-op (same project reference) for a missing item id', () => {
    const { project } = projectWithImageItem(5);
    expect(updateItemMotion(project, 'no-such-item', { type: 'flash' })).toBe(project);
  });
});

describe('setItemSpeed (Phase 2.3 speed controls)', () => {
  function projectWithVideoItem(): { project: Project; itemId: string } {
    let project = createEmptyProject({ ownerUid: 'test-uid' });
    const track = createTrack('video', 'Video', 0);
    project = addTrack(project, track);
    const item: VideoTimelineItem = {
      id: generateTimelineId('item'),
      type: 'video',
      trackId: track.id,
      startTime: 2,
      endTime: 10, // 8s timeline span == 8s source span at speed 1
      zIndex: 0,
      visible: true,
      mediaAssetId: 'asset1',
      position: { x: 50, y: 50 },
      scale: 1,
      rotation: 0,
      opacity: 1,
      trimStart: 4,
      trimEnd: 12,
      speed: 1,
      reverse: false,
      volume: 1,
      muted: false,
    };
    project = addItem(project, item);
    return { project, itemId: item.id };
  }

  it('2x halves the timeline duration, anchored at startTime, trim untouched', () => {
    const { project, itemId } = projectWithVideoItem();
    const next = setItemSpeed(project, itemId, 2);
    const updated = next.items.find((i) => i.id === itemId) as VideoTimelineItem;
    expect(updated.speed).toBe(2);
    expect(updated.startTime).toBe(2);
    expect(updated.endTime).toBeCloseTo(6, 5); // 2 + 8/2
    expect(updated.trimStart).toBe(4);
    expect(updated.trimEnd).toBe(12);
  });

  it('0.5x doubles the timeline duration', () => {
    const { project, itemId } = projectWithVideoItem();
    const next = setItemSpeed(project, itemId, 0.5);
    const updated = next.items.find((i) => i.id === itemId) as VideoTimelineItem;
    expect(updated.endTime).toBeCloseTo(18, 5); // 2 + 8/0.5
  });

  it('clamps out-of-range rates to SPEED_MIN/SPEED_MAX', () => {
    const { project, itemId } = projectWithVideoItem();
    const fast = setItemSpeed(project, itemId, 99).items.find((i) => i.id === itemId) as VideoTimelineItem;
    expect(fast.speed).toBe(SPEED_MAX);
    const slow = setItemSpeed(project, itemId, 0.01).items.find((i) => i.id === itemId) as VideoTimelineItem;
    expect(slow.speed).toBe(SPEED_MIN);
  });

  it('is a no-op for non-video items and missing ids', () => {
    const { project, itemId } = projectWithImageItem(5);
    expect(setItemSpeed(project, itemId, 2)).toBe(project);
    const { project: videoProject } = projectWithVideoItem();
    expect(setItemSpeed(videoProject, 'no-such-item', 2)).toBe(videoProject);
  });
});

describe('audio fit (trimAudioToProjectEnd / loopAudioToProjectEnd)', () => {
  const audioAsset = (durationSeconds: number): MediaAsset => ({
    id: 'audio-asset',
    kind: 'audio',
    storageUrl: 'https://example.com/song.mp3',
    fileName: 'song.mp3',
    sizeBytes: 500_000,
    mimeType: 'audio/mpeg',
    durationSeconds,
    createdAt: 0,
  });

  /**
   * Project fixture: one video item spanning [0, videoEnd] and one audio
   * item (on its own track) with the given span/trim on a registered
   * audio asset of `assetSeconds`. Returns ids for assertions.
   */
  function projectWithAudioAndVideo(opts: {
    videoEnd: number;
    audioStart?: number;
    audioEnd: number;
    trimStart?: number;
    trimEnd: number;
    assetSeconds: number;
    fadeOut?: number;
    loop?: boolean;
  }): { project: Project; audioId: string; videoId: string } {
    let project = createEmptyProject({ ownerUid: 'test-uid' });
    const videoTrack = createTrack('video', 'Video', 0);
    const audioTrack = createTrack('audio', 'Audio', 1);
    project = addTrack(project, videoTrack);
    project = addTrack(project, audioTrack);
    project = addMediaAsset(project, audioAsset(opts.assetSeconds));
    project = addMediaAsset(project, {
      id: 'video-asset',
      kind: 'video',
      storageUrl: 'https://example.com/clip.mp4',
      fileName: 'clip.mp4',
      sizeBytes: 1_000_000,
      mimeType: 'video/mp4',
      durationSeconds: opts.videoEnd,
      width: 1080,
      height: 1920,
      createdAt: 0,
    });
    const video: VideoTimelineItem = {
      id: generateTimelineId('item'),
      type: 'video',
      trackId: videoTrack.id,
      startTime: 0,
      endTime: opts.videoEnd,
      zIndex: 0,
      visible: true,
      mediaAssetId: 'video-asset',
      position: { x: 50, y: 50 },
      scale: 1,
      rotation: 0,
      opacity: 1,
      trimStart: 0,
      trimEnd: opts.videoEnd,
      speed: 1,
      reverse: false,
      volume: 1,
      muted: false,
    };
    const audio: AudioTimelineItem = {
      id: generateTimelineId('item'),
      type: 'audio',
      trackId: audioTrack.id,
      startTime: opts.audioStart ?? 0,
      endTime: opts.audioEnd,
      zIndex: 1,
      visible: true,
      mediaAssetId: 'audio-asset',
      role: 'music',
      volume: 1,
      muted: false,
      trimStart: opts.trimStart ?? 0,
      trimEnd: opts.trimEnd,
      fade: { fadeInDuration: 0, fadeOutDuration: opts.fadeOut ?? 0 },
      ...(opts.loop ? { loop: true } : {}),
    };
    project = addItem(project, video);
    project = addItem(project, audio);
    return { project, audioId: audio.id, videoId: video.id };
  }

  it('getContentEndTime excludes the fitted item itself', () => {
    const { project, audioId } = projectWithAudioAndVideo({ videoEnd: 20, audioEnd: 45, trimEnd: 45, assetSeconds: 45 });
    expect(getContentEndTime(project)).toBe(45);
    expect(getContentEndTime(project, audioId)).toBe(20);
  });

  it('trim: cuts an over-long clip down to the project end, moving the trim window 1:1 and clearing loop', () => {
    const { project, audioId } = projectWithAudioAndVideo({ videoEnd: 20, audioEnd: 30, trimEnd: 30, assetSeconds: 30, loop: true });
    const next = trimAudioToProjectEnd(project, audioId);
    const updated = next.items.find((i) => i.id === audioId) as AudioTimelineItem;
    expect(updated.endTime).toBe(20);
    expect(updated.trimEnd).toBe(20);
    expect(updated.loop).toBe(false);
    expect(updated.fade.fadeOutDuration).toBeCloseTo(FIT_FADE_OUT_SECONDS, 5);
  });

  it('trim: extends a short clip using source the asset actually has', () => {
    const { project, audioId } = projectWithAudioAndVideo({ videoEnd: 20, audioEnd: 10, trimEnd: 10, assetSeconds: 25 });
    const next = trimAudioToProjectEnd(project, audioId);
    const updated = next.items.find((i) => i.id === audioId) as AudioTimelineItem;
    expect(updated.endTime).toBe(20);
    expect(updated.trimEnd).toBe(20);
  });

  it('trim: never extends past the asset’s real duration', () => {
    const { project, audioId } = projectWithAudioAndVideo({ videoEnd: 20, audioEnd: 10, trimEnd: 10, assetSeconds: 15 });
    const next = trimAudioToProjectEnd(project, audioId);
    const updated = next.items.find((i) => i.id === audioId) as AudioTimelineItem;
    expect(updated.endTime).toBe(15);
    expect(updated.trimEnd).toBe(15);
  });

  it('trim: respects a fade-out the user already set instead of overwriting it with the default', () => {
    const { project, audioId } = projectWithAudioAndVideo({ videoEnd: 20, audioEnd: 30, trimEnd: 30, assetSeconds: 30, fadeOut: 2 });
    const next = trimAudioToProjectEnd(project, audioId);
    const updated = next.items.find((i) => i.id === audioId) as AudioTimelineItem;
    expect(updated.fade.fadeOutDuration).toBe(2);
    expect(updated.fade.fadeInDuration).toBe(0);
  });

  it('loop: stretches the span to the project end, sets loop, leaves the trim window untouched', () => {
    const { project, audioId } = projectWithAudioAndVideo({ videoEnd: 24, audioEnd: 8, trimEnd: 8, assetSeconds: 8 });
    const next = loopAudioToProjectEnd(project, audioId);
    const updated = next.items.find((i) => i.id === audioId) as AudioTimelineItem;
    expect(updated.loop).toBe(true);
    expect(updated.endTime).toBe(24);
    expect(updated.trimStart).toBe(0);
    expect(updated.trimEnd).toBe(8);
    expect(updated.fade.fadeOutDuration).toBeCloseTo(FIT_FADE_OUT_SECONDS, 5);
  });

  it('both fit helpers are no-ops when the audio item is alone on the timeline', () => {
    let project = createEmptyProject({ ownerUid: 'test-uid' });
    const audioTrack = createTrack('audio', 'Audio', 0);
    project = addTrack(project, audioTrack);
    project = addMediaAsset(project, audioAsset(10));
    const audio: AudioTimelineItem = {
      id: generateTimelineId('item'),
      type: 'audio',
      trackId: audioTrack.id,
      startTime: 0,
      endTime: 10,
      zIndex: 0,
      visible: true,
      mediaAssetId: 'audio-asset',
      role: 'music',
      volume: 1,
      muted: false,
      trimStart: 0,
      trimEnd: 10,
      fade: { fadeInDuration: 0, fadeOutDuration: 0 },
    };
    project = addItem(project, audio);
    expect(trimAudioToProjectEnd(project, audio.id)).toBe(project);
    expect(loopAudioToProjectEnd(project, audio.id)).toBe(project);
  });

  it('fit helpers ignore non-audio items and missing ids', () => {
    const { project, videoId } = projectWithAudioAndVideo({ videoEnd: 20, audioEnd: 10, trimEnd: 10, assetSeconds: 25 });
    expect(trimAudioToProjectEnd(project, videoId)).toBe(project);
    expect(loopAudioToProjectEnd(project, videoId)).toBe(project);
    expect(trimAudioToProjectEnd(project, 'no-such-item')).toBe(project);
    expect(loopAudioToProjectEnd(project, 'no-such-item')).toBe(project);
  });

  it('a looped, fitted project survives a serialize/parse round-trip and still validates', () => {
    const { project, audioId } = projectWithAudioAndVideo({ videoEnd: 24, audioEnd: 8, trimEnd: 8, assetSeconds: 8 });
    const fitted = loopAudioToProjectEnd(project, audioId);
    const parsed = parseProject(serializeProject(fitted, 1234));
    expect(parsed.project).not.toBeNull();
    const roundTripped = parsed.project!.items.find((i) => i.id === audioId) as AudioTimelineItem;
    expect(roundTripped.loop).toBe(true);
    expect(roundTripped.endTime).toBe(24);
  });
});
