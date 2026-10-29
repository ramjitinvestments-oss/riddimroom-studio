import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateProjectExportGate } from './projectDurationGate';
import { getExportsToday } from './licensing';
import {
  addItem,
  addMediaAsset,
  addTrack,
  createEmptyProject,
  createTrack,
  generateTimelineId,
  setItemDuration,
  updateItem,
} from './timeline/utils';
import { deserializeProject, serializeProject } from './timeline/serialization';
import type { AudioTimelineItem, ImageTimelineItem, Project, VideoTimelineItem } from '../types/timeline';

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

const PIP_SETTINGS = { isPip: true, shape: 'circle', borderWidth: 0, borderColor: '#000000', shadow: false } as const;

/** Main video `mainSeconds` + a PiP video ending at `pipEndSeconds`, on the one video track. */
function projectWithMainAndPip(mainSeconds: number, pipEndSeconds: number): Project {
  let project = createEmptyProject({ ownerUid: 'test-uid' });
  const track = createTrack('video', 'Main Video', 0);
  project = addTrack(project, track);
  project = addItem(project, makeVideo({ trackId: track.id, startTime: 0, endTime: mainSeconds, trimEnd: mainSeconds }));
  project = addItem(
    project,
    makeVideo({ trackId: track.id, startTime: 0, endTime: pipEndSeconds, trimEnd: pipEndSeconds, pip: { ...PIP_SETTINGS }, zIndex: 2 }),
  );
  return project;
}

function makeImage(overrides: Partial<ImageTimelineItem> & { trackId: string }): ImageTimelineItem {
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

function projectWithMainDuration(durationSeconds: number): Project {
  let project = createEmptyProject({ ownerUid: 'test-uid' });
  const track = createTrack('image', 'Image', 0);
  project = addTrack(project, track);
  project = addMediaAsset(project, {
    id: 'asset1',
    kind: 'image',
    storageUrl: 'https://example.invalid/asset1.png',
    fileName: 'asset1.png',
    sizeBytes: 100,
    mimeType: 'image/png',
    width: 1080,
    height: 1920,
    createdAt: 1,
  });
  return addItem(project, makeImage({ trackId: track.id, startTime: 0, endTime: durationSeconds }));
}

describe('project duration export gate — tier matrix', () => {
  it('free at 29.9 seconds exports', () => {
    const gate = evaluateProjectExportGate(projectWithMainDuration(29.9), 'free');
    expect(gate.maxProjectSeconds).toBe(30);
    expect(gate.durationSeconds).toBeCloseTo(29.9, 5);
    expect(gate.exceedsCap).toBe(false);
    expect(gate.message).toBeNull();
  });

  it('free at exactly 30.0 seconds exports', () => {
    const gate = evaluateProjectExportGate(projectWithMainDuration(30), 'free');
    expect(gate.exceedsCap).toBe(false);
    expect(gate.message).toBeNull();
  });

  it('free at 30.1 seconds is refused with the plain message', () => {
    const gate = evaluateProjectExportGate(projectWithMainDuration(30.1), 'free');
    expect(gate.exceedsCap).toBe(true);
    expect(gate.message).toBe(
      'This project is 0:30.1 long, but Free projects can be up to 30 seconds. Trim it to 30 seconds or upgrade to Lifetime to export it.',
    );
    expect(gate.indicator).toContain('Free plan: up to 30 seconds — this project is 0:30.1');
  });

  it('lifetime at 30.1 seconds exports', () => {
    const gate = evaluateProjectExportGate(projectWithMainDuration(30.1), 'lifetime');
    expect(gate.maxProjectSeconds).toBe(600);
    expect(gate.exceedsCap).toBe(false);
  });

  it('lifetime at exactly 600 seconds exports', () => {
    const gate = evaluateProjectExportGate(projectWithMainDuration(600), 'lifetime');
    expect(gate.exceedsCap).toBe(false);
    expect(gate.message).toBeNull();
  });

  it('lifetime at 600.1 seconds is refused', () => {
    const gate = evaluateProjectExportGate(projectWithMainDuration(600.1), 'lifetime');
    expect(gate.exceedsCap).toBe(true);
    expect(gate.message).toBe(
      'This project is 10:00.1 long, but Lifetime projects can be up to 10 minutes. Trim it to 10 minutes to export it.',
    );
  });

  it('R36: 12s main + 40s PiP on Free is refused, and the copy reads 0:40', () => {
    const gate = evaluateProjectExportGate(projectWithMainAndPip(12, 40), 'free');
    expect(gate.durationSeconds).toBe(40);
    expect(gate.exceedsCap).toBe(true);
    expect(gate.message).toBe(
      'This project is 0:40 long, but Free projects can be up to 30 seconds. Trim it to 30 seconds or upgrade to Lifetime to export it.',
    );
    expect(gate.indicator).toContain('Free plan: up to 30 seconds — this project is 0:40');
  });

  it('R36: 40s main + 12s PiP on Free is refused at 0:40 (as before)', () => {
    const gate = evaluateProjectExportGate(projectWithMainAndPip(40, 12), 'free');
    expect(gate.durationSeconds).toBe(40);
    expect(gate.exceedsCap).toBe(true);
    expect(gate.message).toContain('This project is 0:40 long');
    expect(gate.indicator).toContain('this project is 0:40');
  });

  it('R36: 12s main + 40s PiP on Lifetime exports fine', () => {
    const gate = evaluateProjectExportGate(projectWithMainAndPip(12, 40), 'lifetime');
    expect(gate.durationSeconds).toBe(40);
    expect(gate.exceedsCap).toBe(false);
    expect(gate.message).toBeNull();
  });

  it('R36: a PiP-only project (no main item) still measures its video duration', () => {
    let project = createEmptyProject({ ownerUid: 'test-uid' });
    const track = createTrack('video', 'Main Video', 0);
    project = addTrack(project, track);
    project = addItem(project, makeVideo({ trackId: track.id, startTime: 0, endTime: 40, trimEnd: 40, pip: { ...PIP_SETTINGS } }));
    const gate = evaluateProjectExportGate(project, 'free');
    expect(gate.durationSeconds).toBe(40);
    expect(gate.exceedsCap).toBe(true);
  });

  it('audio-only project measures 0 (R35 exemption preserved under R36)', () => {
    let project = createEmptyProject({ ownerUid: 'test-uid' });
    const audioTrack = createTrack('audio', 'Music', 0);
    project = addTrack(project, audioTrack);
    project = addItem(project, makeAudio({ trackId: audioTrack.id, startTime: 0, endTime: 180 }));
    const gate = evaluateProjectExportGate(project, 'free');
    expect(gate.durationSeconds).toBe(0);
    expect(gate.exceedsCap).toBe(false);
    expect(gate.message).toBeNull();
  });

  it('measures the main track, not an over-long song under it (R26 semantics)', () => {
    let project = projectWithMainDuration(12);
    const audioTrack = createTrack('audio', 'Music', 1);
    project = addTrack(project, audioTrack);
    project = addMediaAsset(project, {
      id: 'audio-asset',
      kind: 'audio',
      storageUrl: 'https://example.invalid/song.mp3',
      fileName: 'song.mp3',
      sizeBytes: 100,
      mimeType: 'audio/mpeg',
      durationSeconds: 180,
      createdAt: 1,
    });
    project = addItem(project, makeAudio({ trackId: audioTrack.id, startTime: 0, endTime: 180 }));
    const gate = evaluateProjectExportGate(project, 'free');
    expect(gate.durationSeconds).toBe(12);
    expect(gate.exceedsCap).toBe(false);
  });
});

describe('project duration export gate — purity and quota', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      length: 0,
    } as Storage;
    localStorage.clear();
  });

  it('is pure: repeated evaluation is identical and the project is not mutated', () => {
    const project = projectWithMainDuration(42);
    const before = JSON.stringify(project);
    const first = evaluateProjectExportGate(project, 'free');
    const second = evaluateProjectExportGate(project, 'free');
    expect(second).toEqual(first);
    expect(JSON.stringify(project)).toBe(before);
  });

  it('a refusal consumes no daily export quota', () => {
    const uid = 'quota-uid';
    expect(getExportsToday(uid)).toBe(0);
    const gate = evaluateProjectExportGate(projectWithMainDuration(42), 'free');
    expect(gate.exceedsCap).toBe(true);
    // The gate is the only thing a refused export runs — it records
    // nothing, so the daily counter is exactly where it started.
    expect(getExportsToday(uid)).toBe(0);
  });
});

describe('grandfathering — an over-cap Free project still opens and edits', () => {
  it('loads intact, is never auto-trimmed, and becomes exportable once the user trims it', () => {
    const project = projectWithMainDuration(42);
    const itemId = project.items[0].id;

    // Load path (the structural half of opening a saved project):
    // the over-cap project comes back whole — nothing shortened.
    const loaded = deserializeProject(serializeProject(project));
    expect(loaded.errors).toEqual([]);
    expect(loaded.project).not.toBeNull();
    expect(loaded.project!.items).toHaveLength(1);
    expect(loaded.project!.items[0].endTime).toBe(42);
    expect(evaluateProjectExportGate(loaded.project!, 'free').exceedsCap).toBe(true);

    // It stays editable while over the cap (an ordinary inspector edit)…
    const edited = updateItem(loaded.project!, itemId, { opacity: 0.5 });
    expect(edited.items[0].endTime).toBe(42);

    // …and the user's own trim brings it back inside the gate.
    const trimmed = setItemDuration(edited, itemId, 30);
    expect(trimmed.items[0].endTime).toBe(30);
    expect(evaluateProjectExportGate(trimmed, 'free').exceedsCap).toBe(false);
  });
});
