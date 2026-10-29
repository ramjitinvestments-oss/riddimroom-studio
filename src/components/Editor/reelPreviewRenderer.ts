/**
 * R37 Phase 2 — Stage B preview renderer (browser glue, no React).
 *
 * Draws poster frames of an APPLIED preview project (built by the
 * pure `lib/templates/reelPreview.ts` from the real apply functions)
 * with the shared `drawFrame` compositor — the same function the
 * live PreviewPane and the exporters use, so a card frame is exactly
 * what Apply + play would show.
 *
 * Fully failure-silent by design: any problem (no DOM, no loadable
 * media, a CORS-blocked asset, a seek that never lands) degrades to
 * `null` / a missing asset, and the card simply keeps its Stage-A
 * poster. Nothing here may throw into the panel.
 */
import type { Project } from '../../types/timeline';
import { getItemsAtTime } from '../../lib/timeline/utils';
import { drawFrame, videoSourceTimeForItem } from '../../lib/render/compositor';

const IMAGE_LOAD_TIMEOUT_MS = 2500;
const VIDEO_METADATA_TIMEOUT_MS = 4000;
const SEEK_TIMEOUT_MS = 700;

/** Resolves true when `event` fires within the timeout, false otherwise (or on `errorEvent`). */
function waitForEvent(target: EventTarget, event: string, timeoutMs: number, errorEvent?: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      target.removeEventListener(event, onEvent);
      if (errorEvent) target.removeEventListener(errorEvent, onError);
      resolve(ok);
    };
    const onEvent = () => finish(true);
    const onError = () => finish(false);
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    target.addEventListener(event, onEvent);
    if (errorEvent) target.addEventListener(errorEvent, onError);
  });
}

async function loadImage(url: string): Promise<HTMLImageElement | null> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  const loaded = waitForEvent(img, 'load', IMAGE_LOAD_TIMEOUT_MS, 'error');
  img.src = url;
  if (img.complete && img.naturalWidth > 0) return img;
  return (await loaded) && img.naturalWidth > 0 ? img : null;
}

async function loadVideo(url: string, created: HTMLVideoElement[]): Promise<HTMLVideoElement | null> {
  const el = document.createElement('video');
  created.push(el);
  el.crossOrigin = 'anonymous';
  el.muted = true;
  el.playsInline = true;
  el.preload = 'auto';
  // A detached <video> may never decode (see PreviewPane): attach it
  // off-screen — fixed, 1×1px, invisible, non-interactive.
  el.style.position = 'fixed';
  el.style.width = '1px';
  el.style.height = '1px';
  el.style.opacity = '0';
  el.style.pointerEvents = 'none';
  document.body.appendChild(el);
  const loaded = waitForEvent(el, 'loadedmetadata', VIDEO_METADATA_TIMEOUT_MS, 'error');
  el.src = url;
  return (await loaded) ? el : null;
}

async function seekVideo(el: HTMLVideoElement, targetSeconds: number): Promise<void> {
  if (Math.abs(targetSeconds - el.currentTime) <= 0.03) return;
  const seeked = waitForEvent(el, 'seeked', SEEK_TIMEOUT_MS);
  try {
    el.currentTime = targetSeconds;
  } catch {
    return;
  }
  await seeked; // proceed either way — a stale frame beats no frame
}

/**
 * Renders one small canvas per timestamp for the applied project, or
 * null when there is nothing honest to show (no DOM, no timestamps,
 * no loadable media, or any failure along the way).
 */
export async function renderPreviewCanvases(
  appliedProject: Project,
  timestamps: number[],
): Promise<HTMLCanvasElement[] | null> {
  if (typeof document === 'undefined') return null;
  if (!timestamps || timestamps.length === 0) return null;
  if (!(appliedProject.canvasWidth > 0) || !(appliedProject.canvasHeight > 0)) return null;

  const createdVideos: HTMLVideoElement[] = [];
  try {
    // Load each DISTINCT media asset used by the project's video /
    // image items; an asset that fails or times out is simply absent
    // from the frame (the compositor skips what it cannot draw).
    const images = new Map<string, HTMLImageElement>();
    const videos = new Map<string, HTMLVideoElement>();
    const seen = new Set<string>();
    for (const item of appliedProject.items) {
      if (item.type !== 'video' && item.type !== 'image') continue;
      const assetId = item.mediaAssetId;
      if (seen.has(assetId)) continue;
      seen.add(assetId);
      const asset = appliedProject.mediaAssets[assetId];
      if (!asset || !asset.storageUrl) continue;
      if (item.type === 'image') {
        const img = await loadImage(asset.storageUrl);
        if (img) images.set(assetId, img);
      } else {
        const el = await loadVideo(asset.storageUrl, createdVideos);
        if (el) videos.set(assetId, el);
      }
    }
    if (images.size === 0 && videos.size === 0) return null;

    const width = 144;
    const height = Math.min(256, Math.max(80, Math.round((144 * appliedProject.canvasHeight) / appliedProject.canvasWidth)));

    const canvases: HTMLCanvasElement[] = [];
    for (const t of timestamps) {
      // Seek every active video item's element to the source time it
      // shows at t, so the drawn frame is the frame at t — not
      // whatever the element happened to be parked on.
      for (const item of getItemsAtTime(appliedProject, t)) {
        if (item.type !== 'video') continue;
        const el = videos.get(item.mediaAssetId);
        if (el) await seekVideo(el, videoSourceTimeForItem(item, t));
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.scale(width / appliedProject.canvasWidth, height / appliedProject.canvasHeight);
      drawFrame(ctx, appliedProject, t, { images, videos });
      canvases.push(canvas);
    }
    return canvases.length > 0 ? canvases : null;
  } catch {
    return null;
  } finally {
    for (const el of createdVideos) {
      try {
        el.pause();
      } catch {
        // already gone — cleanup stays silent
      }
      el.remove();
      el.removeAttribute('src');
      try {
        el.load();
      } catch {
        // clearing a detached element is best-effort
      }
    }
  }
}
