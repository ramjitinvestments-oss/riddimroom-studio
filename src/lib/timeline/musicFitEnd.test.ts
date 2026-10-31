import { describe, expect, it } from 'vitest';
import {
  addItem,
  addMediaAsset,
  addTrack,
  createEmptyProject,
  createTrack,
  generateTimelineId,
  getFitTargetEnd,
  getProjectDuration,
  loopAudioToProjectEnd,
  trimAudioToProjectEnd,
} from './utils';
import type { AudioTimelineItem, Project, TextTimelineItem, VideoTimelineItem } from '../../types/timeline';

/**
 * R40 P-35 — music fit targets the TRUE project end.
 *
 * `trimAudioToProjectEnd` / `loopAudioToProjectEnd` used to aim at
 * `getContentEndTime` — the latest end of ALL other items, audio and
 * text included — so an over-long voiceover or text item stretched the
 * fitted music past the end the export would actually have (the render
 * clips audio at the R36 project end). They now aim at
 * `getFitTargetEnd`: the R36 project end (max of main-track end and
 * longest-video end) whenever the project has visual content.
 */

function baseProject(): { project: Project; videoTrackId: string; audioTrackId: string } {
  let project = createEmptyProject({ ownerUid: 'test-uid' });
  const videoTrack = createTrack('video', 'Video', 0);
  const audioTrack = createTrack('audio', 'Audio', 1);
  project = addTrack(project, videoTrack);
  project = addTrack(project, audioTrack);
  project = addMediaAsset(project, {
    id: 'video-asset', kind: 'video', storageUrl: 'https://example.com/clip.mp4', fileName: 'clip.mp4',
    sizeBytes: 1, mimeType: 'video/mp4', durationSeconds: 60, width: 1080, height: 1920, createdAt: 0,
  });
  project = addMediaAsset(project, {
    id: 'audio-asset', kind: 'audio', storageUrl: 'https://example.com/song.mp3', fileName: 'song.mp3',
    sizeBytes: 1, mimeType: 'audio/mpeg', durationSeconds: 120, createdAt: 0,
  });
  return { project, videoTrackId: videoTrack.id, audioTrackId: audioTrack.id };
}

function videoItem(id: string, trackId: string, end: number, pip = false): VideoTimelineItem {
  return {
    id, type: 'video', trackId, startTime: 0, endTime: end, zIndex: 0, visible: true,
    mediaAssetId: 'video-asset', position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 1,
    trimStart: 0, trimEnd: end, speed: 1, reverse: false, volume: 1, muted: false,
    ...(pip ? { pip: { isPip: true, shape: 'rounded' as const, borderWidth: 0, borderColor: '#000', shadow: false } } : {}),
  };
}

function audioItem(id: string, trackId: string, end: number, role: AudioTimelineItem['role'] = 'music'): AudioTimelineItem {
  return {
    id, type: 'audio', trackId, startTime: 0, endTime: end, zIndex: 1, visible: true,
    mediaAssetId: 'audio-asset', role, volume: 1, muted: false,
    trimStart: 0, trimEnd: end, fade: { fadeInDuration: 0, fadeOutDuration: 0 },
  };
}

function textItem(id: string, trackId: string, end: number): TextTimelineItem {
  return {
    id, type: 'text', trackId, startTime: 0, endTime: end, zIndex: 2, visible: true,
    text: 'Words', role: 'title', font: 'Inter', fontSize: 48, color: '#fff',
    position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 1,
  };
}

describe('R40 P-35 — getFitTargetEnd', () => {
  it('an over-long voiceover does not extend the fit target past the visual end', () => {
    const { project: p0, videoTrackId, audioTrackId } = baseProject();
    let project = addItem(p0, videoItem('v1', videoTrackId, 20));
    project = addItem(project, audioItem('voice', audioTrackId, 45, 'voiceover'));
    project = addItem(project, audioItem('music', audioTrackId, 8));
    expect(getProjectDuration(project)).toBe(20);
    expect(getFitTargetEnd(project, 'music')).toBe(20);
  });

  it('an over-long text item does not extend the fit target either', () => {
    const { project: p0, videoTrackId, audioTrackId } = baseProject();
    let project = addItem(p0, videoItem('v1', videoTrackId, 20));
    project = addItem(project, textItem('t1', videoTrackId, 60));
    project = addItem(project, audioItem('music', audioTrackId, 8));
    expect(getFitTargetEnd(project, 'music')).toBe(20);
  });

  it('a PiP-longest project fits to the PiP end (the R36 project end)', () => {
    const { project: p0, videoTrackId, audioTrackId } = baseProject();
    let project = addItem(p0, videoItem('v1', videoTrackId, 12));
    project = addItem(project, videoItem('pip', videoTrackId, 40, true));
    project = addItem(project, audioItem('music', audioTrackId, 8));
    expect(getFitTargetEnd(project, 'music')).toBe(40);
  });

  it('music-only fallback: with no visual content the target is the other items’ end', () => {
    const { project: p0, audioTrackId } = baseProject();
    let project = addItem(p0, audioItem('voice', audioTrackId, 30, 'voiceover'));
    project = addItem(project, audioItem('music', audioTrackId, 50));
    expect(getFitTargetEnd(project, 'music')).toBe(30);
  });

  it('a lone music item has no fit target (0)', () => {
    const { project: p0, audioTrackId } = baseProject();
    const project = addItem(p0, audioItem('music', audioTrackId, 50));
    expect(getFitTargetEnd(project, 'music')).toBe(0);
  });
});

describe('R40 P-35 — loop/trim fit ends at the visual project end', () => {
  it('loop: music under a 20s video with a 45s voiceover fills to 20s, not 45s', () => {
    const { project: p0, videoTrackId, audioTrackId } = baseProject();
    let project = addItem(p0, videoItem('v1', videoTrackId, 20));
    project = addItem(project, audioItem('voice', audioTrackId, 45, 'voiceover'));
    project = addItem(project, audioItem('music', audioTrackId, 8));
    const next = loopAudioToProjectEnd(project, 'music');
    const music = next.items.find((i) => i.id === 'music') as AudioTimelineItem;
    expect(music.loop).toBe(true);
    expect(music.endTime).toBe(20);
  });

  it('trim: an over-long music bed under a 20s video with a 60s text item trims to 20s', () => {
    const { project: p0, videoTrackId, audioTrackId } = baseProject();
    let project = addItem(p0, videoItem('v1', videoTrackId, 20));
    project = addItem(project, textItem('t1', videoTrackId, 60));
    project = addItem(project, audioItem('music', audioTrackId, 45));
    const next = trimAudioToProjectEnd(project, 'music');
    const music = next.items.find((i) => i.id === 'music') as AudioTimelineItem;
    expect(music.endTime).toBe(20);
    expect(music.trimEnd).toBe(20);
  });

  it('music-only fallback preserved: trimming a 50s bed against a 30s voiceover ends at 30s', () => {
    const { project: p0, audioTrackId } = baseProject();
    let project = addItem(p0, audioItem('voice', audioTrackId, 30, 'voiceover'));
    project = addItem(project, audioItem('music', audioTrackId, 50));
    const next = trimAudioToProjectEnd(project, 'music');
    const music = next.items.find((i) => i.id === 'music') as AudioTimelineItem;
    expect(music.endTime).toBe(30);
  });

  it('a lone music item is left unchanged by both fits', () => {
    const { project: p0, audioTrackId } = baseProject();
    const project = addItem(p0, audioItem('music', audioTrackId, 50));
    expect(trimAudioToProjectEnd(project, 'music')).toBe(project);
    expect(loopAudioToProjectEnd(project, 'music')).toBe(project);
  });

  it('ids are generated through the shared helper (fixture sanity)', () => {
    expect(generateTimelineId('item')).toBeTruthy();
  });
});
