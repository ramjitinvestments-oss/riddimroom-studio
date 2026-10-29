/**
 * R37 Phase 2 — Stage B own-media preview: pure planning for the
 * focused reel card's poster frames.
 *
 * HONESTY ANCHOR: the preview project is produced by the REAL apply
 * functions (`applyHookToProject` / `applyFullTemplate`) — never a
 * hand-tuned approximation — and the browser glue
 * (`components/Editor/reelPreviewRenderer.ts`) draws it with the same
 * `drawFrame` compositor as the real preview/export. What the card
 * shows is what Apply does.
 *
 * This module is pure (no DOM): it decides WHICH applied project and
 * WHICH timestamps to draw, and provides the cache key + the bounded
 * LRU cache + render scheduler the panel uses so swiping the strip
 * never re-renders more than it must. Rendering itself lives in the
 * renderer glue file.
 */
import type { Project, TimelineItem } from '../../types/timeline';
import type { StudioTemplate } from '../templates';
import { applyFullTemplate, applyHookToProject } from './apply';
import { getProjectDuration } from '../timeline/utils';

/** True when any video/image item references a media asset that exists in the project. */
export function hasPreviewMedia(project: Project): boolean {
  return project.items.some(
    (item) =>
      (item.type === 'video' || item.type === 'image') &&
      Boolean(project.mediaAssets[item.mediaAssetId]),
  );
}

/**
 * The applied clone a preview would show — a pure pass-through to the
 * real apply functions (hooks apply at the playhead; full edits apply
 * with no options, exactly as the panel's no-loop apply does).
 */
export function buildPreviewProject(project: Project, template: StudioTemplate, currentTime: number): Project {
  if (template.kind === 'hook') return applyHookToProject(project, template, currentTime);
  return applyFullTemplate(project, template, {}).project;
}

function normalizeTimestamps(candidates: number[], projectDuration: number): number[] {
  const out: number[] = [];
  for (const raw of candidates) {
    if (!Number.isFinite(raw)) continue;
    const t = Math.min(Math.max(raw, 0), projectDuration);
    if (out.length === 0 || t > out[out.length - 1]) out.push(t);
  }
  return out;
}

/**
 * The applied clone plus up to 3 timestamps to draw poster frames at:
 * full edits sample their packed reel (near its start, its middle,
 * near its end); hooks sample the hook window at the playhead; a
 * full edit that produced no reel samples the applied project's
 * quarter points. An empty project (no items / zero duration) gets
 * no timestamps — the card keeps its Stage-A poster.
 */
export function buildPreview(
  project: Project,
  template: StudioTemplate,
  currentTime: number,
): { project: Project; timestamps: number[] } {
  if (template.kind === 'hook') {
    const applied = applyHookToProject(project, template, currentTime);
    if (project.items.length === 0 || getProjectDuration(project) <= 0 || getProjectDuration(applied) <= 0) {
      return { project: applied, timestamps: [] };
    }
    const duration = getProjectDuration(applied);
    const candidates = [
      currentTime + 0.15,
      currentTime + template.durationSeconds * 0.5,
      currentTime + template.durationSeconds * 0.85,
    ];
    return { project: applied, timestamps: normalizeTimestamps(candidates, duration) };
  }

  const result = applyFullTemplate(project, template, {});
  const applied = result.project;
  if (project.items.length === 0 || getProjectDuration(project) <= 0 || getProjectDuration(applied) <= 0) {
    return { project: applied, timestamps: [] };
  }
  const duration = getProjectDuration(applied);
  const { reelStartSeconds: reelStart, reelEndSeconds: reelEnd } = result;
  if (reelEnd > reelStart) {
    const span = reelEnd - reelStart;
    const candidates = [
      reelStart + Math.min(0.4, span * 0.1),
      (reelStart + reelEnd) / 2,
      reelEnd - Math.min(0.5, span * 0.15),
    ];
    return { project: applied, timestamps: normalizeTimestamps(candidates, duration) };
  }
  const candidates = [duration * 0.25, duration * 0.5, duration * 0.75];
  return { project: applied, timestamps: normalizeTimestamps(candidates, duration) };
}

/**
 * Deterministic cache key for a preview: the template, the canvas,
 * and every item's identity/timing/trim/speed — anything that would
 * change the applied frames changes the key. Hooks also fold in the
 * playhead (rounded to 0.25s), because a hook preview is anchored
 * where it would be inserted.
 */
export function previewSignature(project: Project, template: StudioTemplate, currentTime: number): string {
  const itemPart = project.items
    .map((item) => {
      const media = item as TimelineItem & { mediaAssetId?: string; trimStart?: number; trimEnd?: number; speed?: number };
      return [
        item.id,
        item.type,
        media.mediaAssetId ?? '',
        item.startTime,
        item.endTime,
        media.trimStart ?? '',
        media.trimEnd ?? '',
        media.speed ?? '',
      ].join(':');
    })
    .join(',');
  const base = [template.id, `${project.canvasWidth}x${project.canvasHeight}`, itemPart].join('|');
  if (template.kind === 'hook') {
    const rounded = Math.round(currentTime / 0.25) * 0.25;
    return `${base}|@${rounded.toFixed(2)}`;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Bounded LRU cache
// ---------------------------------------------------------------------------

export interface PreviewCache<T> {
  /** Returns the value and refreshes its recency. */
  get(key: string): T | undefined;
  /** Returns the value WITHOUT refreshing recency. */
  peek(key: string): T | undefined;
  set(key: string, value: T): void;
  /** Presence check WITHOUT refreshing recency. */
  has(key: string): boolean;
  readonly size: number;
}

export function createPreviewCache<T>(limit = 12): PreviewCache<T> {
  const map = new Map<string, T>();
  const cap = Math.max(1, limit);
  return {
    get(key: string): T | undefined {
      if (!map.has(key)) return undefined;
      const value = map.get(key) as T;
      map.delete(key);
      map.set(key, value);
      return value;
    },
    peek(key: string): T | undefined {
      return map.get(key);
    },
    set(key: string, value: T): void {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > cap) {
        const oldest = map.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    has(key: string): boolean {
      return map.has(key);
    },
    get size(): number {
      return map.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Render scheduler: cache-first, one in-flight render per key
// ---------------------------------------------------------------------------

export interface PreviewScheduler<T> {
  request(key: string): Promise<T | null>;
  peek(key: string): T | undefined;
}

export function createPreviewScheduler<T>(
  render: (key: string) => Promise<T | null>,
  cache: PreviewCache<T>,
): PreviewScheduler<T> {
  const inFlight = new Map<string, Promise<T | null>>();
  return {
    request(key: string): Promise<T | null> {
      const cached = cache.get(key);
      if (cached !== undefined) return Promise.resolve(cached);
      const existing = inFlight.get(key);
      if (existing) return existing;
      const promise: Promise<T | null> = (async () => {
        try {
          const result = await render(key);
          if (result !== null && result !== undefined) {
            cache.set(key, result);
            return result;
          }
          return null;
        } catch {
          return null;
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, promise);
      return promise;
    },
    peek(key: string): T | undefined {
      return cache.peek(key);
    },
  };
}
