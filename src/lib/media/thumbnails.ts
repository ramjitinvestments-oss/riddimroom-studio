/**
 * RiddimRoom Studio — poster/thumbnail service (polish batch 2).
 *
 * Generates a small JPEG poster (data URL) for a media asset: the first
 * frame-ish of a video, or the image itself downscaled. Used for timeline
 * filmstrip backgrounds (`TimelinePanel`) and for the dashboard's project
 * cards (`getProjectPoster`, stored on the Project as `posterDataUrl`).
 *
 * Everything here is best-effort cosmetic: any failure — the Storage
 * bucket not serving CORS-clean media (the canvas would be tainted and
 * `toDataURL` throws), a network error, a decode stall — resolves `null`
 * and callers fall back to their existing flat/branded rendering. A 5s
 * timeout guarantees a stuck load can never hang the UI or a save.
 *
 * Results are cached for the session in a module-level Map keyed by asset
 * id (including `null` results, so a broken asset isn't retried on every
 * render), and concurrent requests for the same asset share one in-flight
 * promise.
 */

import type { MediaAsset, Project } from '../../types/timeline';

/** Posters are small UI dressing (timeline strips, card covers) — 320px wide is plenty and keeps data URLs (and the Firestore project doc carrying one) small. */
const MAX_POSTER_WIDTH = 320;
const POSTER_JPEG_QUALITY = 0.7;
/** Hard ceiling per poster attempt — past this, give up and resolve null. */
const POSTER_TIMEOUT_MS = 5000;

const posterCache = new Map<string, string | null>();
const inflightPosters = new Map<string, Promise<string | null>>();

function drawToPosterCanvas(source: CanvasImageSource, sourceWidth: number, sourceHeight: number): string | null {
  if (!sourceWidth || !sourceHeight) return null;
  const scale = Math.min(1, MAX_POSTER_WIDTH / sourceWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  // Throws a SecurityError on a tainted canvas (non-CORS media) — the
  // callers' try/catch turns that into a null poster.
  return canvas.toDataURL('image/jpeg', POSTER_JPEG_QUALITY);
}

function loadImagePoster(asset: MediaAsset): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), POSTER_TIMEOUT_MS);
    img.onload = () => {
      try {
        finish(drawToPosterCanvas(img, img.naturalWidth, img.naturalHeight));
      } catch {
        finish(null);
      }
    };
    img.onerror = () => finish(null);
    img.src = asset.storageUrl;
  });
}

function loadVideoPoster(asset: MediaAsset): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    // Same decode requirement PreviewPane documents for its own elements:
    // a <video> that is never connected to the document can sit at
    // readyState 0 forever in some browser configurations. Kept fully
    // off-screen and non-interactive; removed again on settle.
    video.style.position = 'fixed';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    video.tabIndex = -1;
    document.body.appendChild(video);

    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (video.parentNode) video.parentNode.removeChild(video);
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), POSTER_TIMEOUT_MS);

    video.addEventListener('loadedmetadata', () => {
      const duration = video.duration;
      // ~0.5s in, or 10% of the duration for short clips — early enough
      // to be representative, late enough to skip a black leader frame.
      const target = Number.isFinite(duration) && duration > 0 ? Math.min(0.5, duration * 0.1) : 0.5;
      try {
        video.currentTime = target;
      } catch {
        finish(null);
      }
    });
    video.addEventListener('seeked', () => {
      try {
        finish(drawToPosterCanvas(video, video.videoWidth, video.videoHeight));
      } catch {
        finish(null);
      }
    });
    video.addEventListener('error', () => finish(null));
    video.src = asset.storageUrl;
  });
}

/**
 * Poster for one asset, or null when none can be produced (audio assets
 * never have posters). Cached per asset id for the session; concurrent
 * calls for the same asset share one in-flight load.
 */
export function getAssetPoster(asset: MediaAsset): Promise<string | null> {
  if (asset.kind === 'audio') return Promise.resolve(null);
  if (posterCache.has(asset.id)) {
    return Promise.resolve(posterCache.get(asset.id) ?? null);
  }
  const existing = inflightPosters.get(asset.id);
  if (existing) return existing;
  const promise = (asset.kind === 'image' ? loadImagePoster(asset) : loadVideoPoster(asset))
    .catch(() => null)
    .then((url) => {
      posterCache.set(asset.id, url);
      inflightPosters.delete(asset.id);
      return url;
    });
  inflightPosters.set(asset.id, promise);
  return promise;
}

/**
 * R44 Phase D (PL-2) — filmstrip frames along a video clip.
 *
 * `getAssetPoster` gives ONE frame per asset; a 30s clip and a 2s clip
 * read identically on the timeline. The filmstrip samples
 * FILMSTRIP_FRAME_COUNT frames evenly across the asset's duration so a
 * long clip reads as a strip (the CapCut pattern, AUDIT-R43 P11). The
 * frames are sampled across the ASSET (not per clip/trim): the timeline
 * scales/offsets the strip so the frames under a clip are the frames of
 * its trim window (pure CSS geometry in TimelinePanel — no re-decode
 * when a trim changes). Deliberate limit, documented rather than
 * hidden: frames are session-cached per asset, so a replaced asset
 * (new id) re-samples, but a trim never does.
 */
export const FILMSTRIP_FRAME_COUNT = 6;
/** Hard ceiling for a whole strip (several seeks) — past this, resolve null and the clip keeps its single poster. */
const FILMSTRIP_TIMEOUT_MS = 20000;

const filmstripCache = new Map<string, string[] | null>();
const inflightFilmstrips = new Map<string, Promise<string[] | null>>();

/** Centre time of each of `count` even slices of a duration — the frames a strip samples. */
export function filmstripFrameTimes(durationSeconds: number, count: number = FILMSTRIP_FRAME_COUNT): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || count <= 0) return [];
  return Array.from({ length: count }, (_, i) => ((i + 0.5) / count) * durationSeconds);
}

function loadVideoFilmstrip(asset: MediaAsset): Promise<string[] | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.style.position = 'fixed';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    video.tabIndex = -1;
    document.body.appendChild(video);

    let settled = false;
    const finish = (value: string[] | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (video.parentNode) video.parentNode.removeChild(video);
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), FILMSTRIP_TIMEOUT_MS);

    video.addEventListener('loadedmetadata', () => {
      const times = filmstripFrameTimes(video.duration);
      if (times.length === 0) {
        finish(null);
        return;
      }
      const frames: string[] = [];
      let index = 0;
      const onSeeked = () => {
        try {
          const url = drawToPosterCanvas(video, video.videoWidth, video.videoHeight);
          if (url) frames.push(url);
        } catch {
          // A tainted/failed frame just shortens the strip.
        }
        index += 1;
        if (index >= times.length) {
          video.removeEventListener('seeked', onSeeked);
          finish(frames.length > 0 ? frames : null);
          return;
        }
        try {
          video.currentTime = times[index];
        } catch {
          video.removeEventListener('seeked', onSeeked);
          finish(frames.length > 0 ? frames : null);
        }
      };
      video.addEventListener('seeked', onSeeked);
      try {
        video.currentTime = times[0];
      } catch {
        finish(null);
      }
    });
    video.addEventListener('error', () => finish(null));
    video.src = asset.storageUrl;
  });
}

/**
 * Filmstrip frames for a video asset (null for images/audio — they keep
 * the single poster / flat rendering). Session-cached per asset id,
 * in-flight deduped, exactly like getAssetPoster.
 */
export function getAssetFilmstrip(asset: MediaAsset): Promise<string[] | null> {
  if (asset.kind !== 'video') return Promise.resolve(null);
  if (filmstripCache.has(asset.id)) {
    return Promise.resolve(filmstripCache.get(asset.id) ?? null);
  }
  const existing = inflightFilmstrips.get(asset.id);
  if (existing) return existing;
  const promise = loadVideoFilmstrip(asset)
    .catch(() => null)
    .then((urls) => {
      filmstripCache.set(asset.id, urls);
      inflightFilmstrips.delete(asset.id);
      return urls;
    });
  inflightFilmstrips.set(asset.id, promise);
  return promise;
}

/** The asset a project poster should come from: the earliest video/image item's asset. */
export function getFirstVisualAsset(project: Project): MediaAsset | null {
  const byStartTime = [...project.items].sort((a, b) => a.startTime - b.startTime);
  for (const item of byStartTime) {
    if (item.type !== 'video' && item.type !== 'image') continue;
    const asset = project.mediaAssets[item.mediaAssetId];
    if (asset && asset.kind !== 'audio') return asset;
  }
  return null;
}

/** Poster for a whole project (its first visual asset), or null. */
export function getProjectPoster(project: Project): Promise<string | null> {
  const asset = getFirstVisualAsset(project);
  if (!asset) return Promise.resolve(null);
  return getAssetPoster(asset);
}
