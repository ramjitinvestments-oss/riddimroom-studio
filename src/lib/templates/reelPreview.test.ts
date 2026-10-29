import { describe, it, expect } from 'vitest';
import {
  buildPreview,
  buildPreviewProject,
  createPreviewCache,
  createPreviewScheduler,
  hasPreviewMedia,
  previewSignature,
} from './reelPreview';
import { applyFullTemplate, applyHookToProject } from './apply';
import { getTemplate } from '../templates';
import { createDefaultProject } from '../projects/persistence';
import { appendMediaToTimeline } from '../timeline/insert';
import { updateItem } from '../timeline/utils';
import type { MediaAsset, Project } from '../../types/timeline';

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
 */
function normalizeGeneratedIds(project: Project, knownIds: Set<string>): Project {
  let added = 0;
  return {
    ...project,
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

  it('hook: timestamps stay inside the hook window at the playhead', () => {
    const fixture = projectWithClips(1);
    const template = getTemplate('gold-smash-intro')!; // 2.5s
    const at = 2;
    const { timestamps } = buildPreview(fixture, template, at);
    expect(timestamps.length).toBeGreaterThan(0);
    for (const t of timestamps) {
      expect(t).toBeGreaterThanOrEqual(at);
      expect(t).toBeLessThanOrEqual(at + template.durationSeconds);
    }
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

  it('hook signatures track the playhead (≥0.25s); full signatures ignore it', () => {
    const fixture = projectWithClips(1);
    const hook = getTemplate('gold-smash-intro')!;
    expect(previewSignature(fixture, hook, 2.5)).not.toBe(previewSignature(fixture, hook, 2));
    const full = getTemplate('viral-hook-story')!;
    expect(previewSignature(fixture, full, 7)).toBe(previewSignature(fixture, full, 2));
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
