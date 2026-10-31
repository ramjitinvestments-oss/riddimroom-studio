import { describe, it, expect } from 'vitest';
import {
  buildPreview,
  buildPreviewProject,
  createPreviewCache,
  createPreviewScheduler,
  hasPreviewMedia,
  hookPreviewAnchor,
  previewSignature,
} from './reelPreview';
import { applyFullTemplate, applyHookToProject } from './apply';
import { getTemplate } from '../templates';
import { createDefaultProject } from '../projects/persistence';
import { appendMediaToTimeline } from '../timeline/insert';
import { updateItem } from '../timeline/utils';
import type { CaptionTimelineItem, MediaAsset, Project, TextTimelineItem } from '../../types/timeline';

function videoAsset(id: string, durationSeconds = 30): MediaAsset {
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

function projectWithClips(count: number): Project {
  let project = createDefaultProject('uid-1');
  for (let i = 0; i < count; i++) {
    project = appendMediaToTimeline(project, videoAsset(`asset-clip-${i}`));
  }
  return project;
}

/**
 * Applies generate fresh ids for the items they ADD (headline/CTA
 * texts…); replace those with positional placeholders so two honest
 * applies of the same input can be deep-compared. Ids the input
 * already carried are kept as-is.
 *
 * R40 Phase 2 (flake fix): `updatedAt` is also zeroed on both sides.
 * Each apply stamps the result with the current time, so two honest
 * applies of the same input run a millisecond apart differed by that
 * stamp alone and the deep-equals below failed intermittently. The
 * stamp says when the apply ran, not what it produced — it is not
 * part of what "exactly the real apply" means.
 */
function normalizeGeneratedIds(project: Project, knownIds: Set<string>): Project {
  let added = 0;
  return {
    ...project,
    updatedAt: 0,
    items: project.items.map((item) =>
      knownIds.has(item.id) ? item : { ...item, id: `added-${added++}` },
    ),
  };
}

describe('R37 Phase 2 — reelPreview honesty', () => {
  it('buildPreviewProject is exactly the real full apply', () => {
    const fixture = projectWithClips(3);
    const template = getTemplate('viral-hook-story')!;
    const knownIds = new Set(fixture.items.map((i) => i.id));
    const viaPreview = buildPreviewProject(fixture, template, 0);
    const viaApply = applyFullTemplate(fixture, template, {}).project;
    expect(normalizeGeneratedIds(viaPreview, knownIds)).toEqual(normalizeGeneratedIds(viaApply, knownIds));
  });

  it('buildPreviewProject is exactly the real hook apply at the playhead', () => {
    const fixture = projectWithClips(1);
    const template = getTemplate('gold-smash-intro')!;
    const knownIds = new Set(fixture.items.map((i) => i.id));
    const viaPreview = buildPreviewProject(fixture, template, 4);
    const viaApply = applyHookToProject(fixture, template, 4);
    expect(normalizeGeneratedIds(viaPreview, knownIds)).toEqual(normalizeGeneratedIds(viaApply, knownIds));
  });

  it('buildPreview never mutates the input project', () => {
    const fixture = projectWithClips(3);
    const snapshot = JSON.stringify(fixture);
    buildPreview(fixture, getTemplate('music-video')!, 0);
    buildPreview(fixture, getTemplate('gold-smash-intro')!, 1);
    expect(JSON.stringify(fixture)).toBe(snapshot);
  });
});

describe('R37 Phase 2 — reelPreview timestamps', () => {
  it('full template with media: 3 strictly increasing timestamps inside the reel', () => {
    const fixture = projectWithClips(3);
    const template = getTemplate('viral-hook-story')!;
    const truth = applyFullTemplate(fixture, template, {});
    const { timestamps } = buildPreview(fixture, template, 0);
    expect(timestamps).toHaveLength(3);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]);
    }
    for (const t of timestamps) {
      expect(t).toBeGreaterThanOrEqual(truth.reelStartSeconds);
      expect(t).toBeLessThanOrEqual(truth.reelEndSeconds);
    }
  });

  it('hook: timestamps stay inside the hook window at the stable placed-element anchor (R40 P-41)', () => {
    const fixture = projectWithClips(1);
    const template = getTemplate('gold-smash-intro')!; // 2.5s
    const anchor = hookPreviewAnchor(fixture);
    const { timestamps } = buildPreview(fixture, template, 2);
    expect(timestamps.length).toBeGreaterThan(0);
    for (const t of timestamps) {
      expect(t).toBeGreaterThanOrEqual(anchor);
      expect(t).toBeLessThanOrEqual(anchor + template.durationSeconds);
    }
    // The playhead argument no longer moves the window at all.
    expect(buildPreview(fixture, template, 7.5).timestamps).toEqual(timestamps);
  });

  it('empty project: no preview media and no timestamps', () => {
    const empty = createDefaultProject('uid-1');
    expect(hasPreviewMedia(empty)).toBe(false);
    expect(buildPreview(empty, getTemplate('viral-hook-story')!, 0).timestamps).toEqual([]);
    expect(buildPreview(empty, getTemplate('gold-smash-intro')!, 0).timestamps).toEqual([]);
  });

  it('hasPreviewMedia is true when a clip references an existing asset', () => {
    expect(hasPreviewMedia(projectWithClips(1))).toBe(true);
  });
});

describe('R37 Phase 2 — previewSignature', () => {
  it('is deterministic for identical inputs', () => {
    const fixture = projectWithClips(2);
    const template = getTemplate('viral-hook-story')!;
    expect(previewSignature(fixture, template, 0)).toBe(previewSignature(fixture, template, 0));
  });

  it('changes when an item timing changes', () => {
    const fixture = projectWithClips(2);
    const template = getTemplate('viral-hook-story')!;
    const video = fixture.items.find((i) => i.type === 'video')!;
    const moved = updateItem(fixture, video.id, { endTime: video.endTime + 1 });
    expect(previewSignature(moved, template, 0)).not.toBe(previewSignature(fixture, template, 0));
  });

  it('changes with a different template', () => {
    const fixture = projectWithClips(2);
    expect(previewSignature(fixture, getTemplate('music-video')!, 0)).not.toBe(
      previewSignature(fixture, getTemplate('viral-hook-story')!, 0),
    );
  });

  it('hook signatures ignore the moving playhead (R40 P-41); full signatures ignore it too', () => {
    const fixture = projectWithClips(1);
    const hook = getTemplate('gold-smash-intro')!;
    expect(previewSignature(fixture, hook, 2.5)).toBe(previewSignature(fixture, hook, 2));
    expect(previewSignature(fixture, hook, 9.75)).toBe(previewSignature(fixture, hook, 0));
    const full = getTemplate('viral-hook-story')!;
    expect(previewSignature(fixture, full, 7)).toBe(previewSignature(fixture, full, 2));
  });

  it('hook anchor derives from the placed elements’ start times — moving an element moves the anchor', () => {
    const fixture = projectWithClips(1);
    const video = fixture.items.find((i) => i.type === 'video')!;
    expect(hookPreviewAnchor(fixture)).toBe(video.startTime);
    const moved = updateItem(fixture, video.id, { startTime: video.startTime + 3, endTime: video.endTime + 3 });
    expect(hookPreviewAnchor(moved)).toBe(video.startTime + 3);
    const hook = getTemplate('gold-smash-intro')!;
    expect(previewSignature(moved, hook, 0)).not.toBe(previewSignature(fixture, hook, 0));
  });

  it('scheduler: advancing currentTime during playback schedules no new hook render (R40 P-41)', async () => {
    const fixture = projectWithClips(1);
    const hook = getTemplate('gold-smash-intro')!;
    let renders = 0;
    const cache = createPreviewCache<string>(12);
    const scheduler = createPreviewScheduler<string>(async (key) => {
      renders += 1;
      return `frame:${key}`;
    }, cache);
    const keyAt = (t: number) => previewSignature(fixture, hook, t);
    expect(await scheduler.request(keyAt(0))).toBe(`frame:${keyAt(0)}`);
    // Playback advances in small steps — every key is the same key.
    for (const t of [0.35, 0.7, 1.4, 2.8, 5.6]) {
      expect(keyAt(t)).toBe(keyAt(0));
      expect(await scheduler.request(keyAt(t))).toBe(`frame:${keyAt(0)}`);
    }
    expect(renders).toBe(1);
    expect(cache.size).toBe(1);
  });
});

describe('R40 P-07 — previewSignature covers every visual edit', () => {
  const template = getTemplate('viral-hook-story')!;

  function changedSignature(mutateFixture: (project: Project) => Project): string {
    return previewSignature(mutateFixture(projectWithClips(2)), template, 0);
  }

  it('an unchanged project keeps the same signature (even after a JSON round trip)', () => {
    const fixture = projectWithClips(2);
    const roundTripped = JSON.parse(JSON.stringify(fixture)) as Project;
    expect(previewSignature(roundTripped, template, 0)).toBe(previewSignature(fixture, template, 0));
  });

  // One case per render-relevant field class: edit it, and the cached
  // own-media preview must be invalidated (signature changes).
  const videoCases: [string, Record<string, unknown>][] = [
    ['position', { position: { x: 61, y: 42 } }],
    ['scale', { scale: 1.4 }],
    ['rotation', { rotation: 12 }],
    ['opacity', { opacity: 0.5 }],
    ['crop window', { crop: { x: 5, y: 5, width: 50, height: 50 } }],
    ['zIndex', { zIndex: 9 }],
    ['visibility', { visible: false }],
    ['PiP settings', { pip: { isPip: true, shape: 'circle', borderWidth: 3, borderColor: '#FFD100', shadow: true } }],
    ['end transform', { endTransform: { position: { x: 50, y: 40 }, scale: 1.2, opacity: 0.8 } }],
    ['fades', { fade: { fadeInDuration: 1, fadeOutDuration: 0.5 } }],
    ['animation', { animation: { entrance: 'pop', intensity: 2 } }],
    ['motion effect', { motion: { type: 'ken-burns', direction: 'left' } }],
    ['colour grade', { colorGrade: { brightness: 10, contrast: 5, saturation: 0 } }],
    ['frame rect', { frameRect: { x: 0, y: 0, w: 50, h: 100 } }],
    ['flip', { flipX: true }],
    ['crop zoom', { cropZoom: 2 }],
    ['crop pan', { cropOffsetX: 0.5 }],
    ['reverse', { reverse: true }],
    ['speed', { speed: 2 }],
    ['volume', { volume: 0.25 }],
    ['mute', { muted: true }],
    ['track change', { trackId: 'another-track' }],
  ];
  for (const [label, patch] of videoCases) {
    it(`changes when a video item's ${label} changes`, () => {
      const base = previewSignature(projectWithClips(2), template, 0);
      const changed = changedSignature((project) => {
        const video = project.items.find((i) => i.type === 'video')!;
        return updateItem(project, video.id, patch as never);
      });
      expect(changed).not.toBe(base);
    });
  }

  it('changes when a text item’s words or style change', () => {
    const textItem: TextTimelineItem = {
      id: 'text-1', trackId: 'track-text', type: 'text',
      startTime: 0, endTime: 3, zIndex: 5, visible: true,
      position: { x: 50, y: 80 }, scale: 1, rotation: 0, opacity: 1,
      text: 'Big sale', role: 'title', font: 'Inter', fontSize: 48, color: '#FFFFFF',
    };
    const fixture = projectWithClips(1);
    const withText: Project = { ...fixture, items: [...fixture.items, textItem] };
    const base = previewSignature(withText, template, 0);
    const edit = (patch: Partial<TextTimelineItem>): Project => ({
      ...withText,
      items: withText.items.map((i) => (i.id === 'text-1' && i.type === 'text' ? { ...i, ...patch } : i)),
    });
    expect(previewSignature(edit({ text: 'Bigger sale' }), template, 0)).not.toBe(base);
    expect(previewSignature(edit({ fontSize: 64 }), template, 0)).not.toBe(base);
    expect(previewSignature(edit({ color: '#FFD100' }), template, 0)).not.toBe(base);
    expect(previewSignature(edit({ font: 'Archivo' }), template, 0)).not.toBe(base);
    expect(previewSignature(edit({ position: { x: 50, y: 30 } }), template, 0)).not.toBe(base);
  });

  it('changes when a caption item’s words or style change', () => {
    const captionItem: CaptionTimelineItem = {
      id: 'cap-1', trackId: 'track-caption', type: 'caption',
      startTime: 0, endTime: 3, zIndex: 6, visible: true,
      words: [{ text: 'Hello', start: 0, end: 0.5 }],
      captionStyleId: 'bold-pop', source: 'manual', editable: true,
    };
    const fixture = projectWithClips(1);
    const withCaption: Project = { ...fixture, items: [...fixture.items, captionItem] };
    const base = previewSignature(withCaption, template, 0);
    const edit = (patch: Partial<CaptionTimelineItem>): Project => ({
      ...withCaption,
      items: withCaption.items.map((i) => (i.id === 'cap-1' && i.type === 'caption' ? { ...i, ...patch } : i)),
    });
    expect(previewSignature(edit({ words: [{ text: 'Goodbye', start: 0, end: 0.5 }] }), template, 0)).not.toBe(base);
    expect(previewSignature(edit({ captionStyleId: 'clean' }), template, 0)).not.toBe(base);
    expect(previewSignature(edit({ sizeScale: 1.55 }), template, 0)).not.toBe(base);
    expect(previewSignature(edit({ anchorY: 'top' }), template, 0)).not.toBe(base);
  });

  it('changes when a track is hidden or the watermark is switched off', () => {
    const fixture = projectWithClips(2);
    const base = previewSignature(fixture, template, 0);
    const hiddenTrack: Project = {
      ...fixture,
      tracks: fixture.tracks.map((t, i) => (i === 0 ? { ...t, visible: false } : t)),
    };
    expect(previewSignature(hiddenTrack, template, 0)).not.toBe(base);
    expect(previewSignature({ ...fixture, watermarkEnabled: false }, template, 0)).not.toBe(base);
  });
});

describe('R37 Phase 2 — preview cache (LRU)', () => {
  it('evicts the oldest entry beyond the limit', () => {
    const cache = createPreviewCache<string>(3);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');
    cache.set('d', 'D');
    expect(cache.has('a')).toBe(false);
    expect(cache.size).toBe(3);
    expect(cache.get('d')).toBe('D');
  });

  it('get refreshes recency; peek/has do not', () => {
    const cache = createPreviewCache<string>(3);
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.set('c', 'C');
    expect(cache.peek('a')).toBe('A');
    cache.set('d', 'D');
    expect(cache.has('a')).toBe(false); // peek did not protect 'a'

    const cache2 = createPreviewCache<string>(3);
    cache2.set('a', 'A');
    cache2.set('b', 'B');
    cache2.set('c', 'C');
    expect(cache2.get('a')).toBe('A');
    cache2.set('d', 'D');
    expect(cache2.has('a')).toBe(true); // get refreshed 'a'…
    expect(cache2.has('b')).toBe(false); // …so 'b' was the oldest
  });
});

describe('R37 Phase 2 — preview scheduler', () => {
  it('cache hit skips the render', async () => {
    let renders = 0;
    const cache = createPreviewCache<string>(12);
    const scheduler = createPreviewScheduler<string>(async (key) => {
      renders += 1;
      return `frame:${key}`;
    }, cache);
    expect(await scheduler.request('k1')).toBe('frame:k1');
    expect(await scheduler.request('k1')).toBe('frame:k1');
    expect(renders).toBe(1);
    expect(scheduler.peek('k1')).toBe('frame:k1');
  });

  it('two concurrent requests for one key share ONE render', async () => {
    let renders = 0;
    let release: ((value: string) => void) | null = null;
    const cache = createPreviewCache<string>(12);
    const scheduler = createPreviewScheduler<string>((key) => {
      renders += 1;
      return new Promise<string>((resolve) => {
        release = () => resolve(`frame:${key}`);
      });
    }, cache);
    const p1 = scheduler.request('k');
    const p2 = scheduler.request('k');
    expect(renders).toBe(1);
    release!('frame:k');
    await expect(p1).resolves.toBe('frame:k');
    await expect(p2).resolves.toBe('frame:k');
    expect(renders).toBe(1);
  });

  it('a null result is NOT cached — the next request re-renders', async () => {
    let renders = 0;
    const cache = createPreviewCache<string>(12);
    const scheduler = createPreviewScheduler<string>(async () => {
      renders += 1;
      return renders === 1 ? null : 'frame';
    }, cache);
    expect(await scheduler.request('k')).toBeNull();
    expect(cache.has('k')).toBe(false);
    expect(await scheduler.request('k')).toBe('frame');
    expect(renders).toBe(2);
    expect(await scheduler.request('k')).toBe('frame');
    expect(renders).toBe(2); // now cached
  });

  it('different keys render independently', async () => {
    const renderedKeys: string[] = [];
    const cache = createPreviewCache<string>(12);
    const scheduler = createPreviewScheduler<string>(async (key) => {
      renderedKeys.push(key);
      return `frame:${key}`;
    }, cache);
    expect(await scheduler.request('a')).toBe('frame:a');
    expect(await scheduler.request('b')).toBe('frame:b');
    expect(renderedKeys.sort()).toEqual(['a', 'b']);
  });
});
