/**
 * RiddimRoom Studio — Canvas2D/MediaRecorder export renderer.
 *
 * The "current practical renderer" referenced in `renderer.ts` — plays the
 * project through in real time on an off-DOM canvas + a mixed audio graph,
 * capturing both into a single `MediaRecorder` output. This is the same
 * fundamental technique BoltVideoApp/EventCam/caption already relied on
 * for export (per the implementation roadmap's research), applied here
 * against the shared `Project`/`TimelineItem` model instead of each app's
 * own ad hoc clip state, and driven by the same `drawFrame` compositor the
 * live editor preview uses, so export visually matches what was previewed.
 *
 * Known operational requirement: the Storage bucket must serve media with
 * CORS enabled for this app's origin (see `storage.cors.json`) — without
 * it, `canvas.captureStream()` produces a blank video track (a browser
 * security behavior for cross-origin media drawn to canvas, not a bug in
 * this code). `render()` detects this (output track present but the
 * canvas never receives readable pixel data) only indirectly, via the
 * final blob-size sanity check in `validateRenderResult`; a CORS
 * misconfiguration surfaces as "export produced a suspiciously small
 * file", which `ExportPanel` reports as an error rather than a false
 * success.
 */

import type { Project, TimelineItem } from '../../types/timeline';
import { getItemsAtTime, getProjectDuration } from '../timeline/utils';
import { computeFadeOpacity, drawFrame } from './../render/compositor';
import type { Renderer, RenderOptions, RenderResult } from './renderer';
import { RenderAbortedError } from './renderer';

interface MediaElementHandle {
  element: HTMLVideoElement | HTMLAudioElement;
  gain: GainNode;
  connected: boolean;
}

function pickSupportedMimeType(): string {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
  }
  return 'video/webm';
}

export class Canvas2DRenderer implements Renderer {
  readonly name = 'canvas2d';

  async render(project: Project, options: RenderOptions = {}): Promise<RenderResult> {
    const totalSeconds = getProjectDuration(project);
    if (totalSeconds <= 0) {
      throw new Error('This project has no timeline items to export.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = project.canvasWidth;
    canvas.height = project.canvasHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser could not create a 2D rendering context for export.');

    const audioCtx = new AudioContext();
    const destination = audioCtx.createMediaStreamDestination();

    const videoHandles = new Map<string, MediaElementHandle>();
    const imageEls = new Map<string, HTMLImageElement>();

    // Video/audio elements must be attached to the document (off-screen is
    // fine) to reliably decode in every browser/extension configuration —
    // found via live browser testing: a detached <video> can sit at
    // readyState 0 forever (fires `loadstart` then `stalled`, never
    // decodes). See the matching fix + longer explanation in
    // PreviewPane.tsx's `getVideoEl`. Canvas and <img> do not have this
    // requirement, so they're left as-is.
    const attachOffscreen = (el: HTMLVideoElement | HTMLAudioElement) => {
      el.style.position = 'fixed';
      el.style.width = '1px';
      el.style.height = '1px';
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
      el.tabIndex = -1;
      document.body.appendChild(el);
    };

    const getVideoHandle = (assetId: string, storageUrl: string): MediaElementHandle => {
      let handle = videoHandles.get(assetId);
      if (!handle) {
        const element = document.createElement('video');
        element.crossOrigin = 'anonymous';
        element.preload = 'auto';
        element.muted = true; // audio is routed through the Web Audio graph instead of the element's own output
        element.playsInline = true;
        attachOffscreen(element);
        element.src = storageUrl;
        const source = audioCtx.createMediaElementSource(element);
        const gain = audioCtx.createGain();
        gain.gain.value = 0;
        source.connect(gain).connect(destination);
        handle = { element, gain, connected: true };
        videoHandles.set(assetId, handle);
      }
      return handle;
    };

    const getAudioHandle = (assetId: string, storageUrl: string): MediaElementHandle => {
      let handle = videoHandles.get(`audio:${assetId}`);
      if (!handle) {
        const element = document.createElement('audio');
        element.crossOrigin = 'anonymous';
        element.preload = 'auto';
        attachOffscreen(element);
        element.src = storageUrl;
        const source = audioCtx.createMediaElementSource(element);
        const gain = audioCtx.createGain();
        gain.gain.value = 0;
        source.connect(gain).connect(destination);
        handle = { element, gain, connected: true };
        videoHandles.set(`audio:${assetId}`, handle);
      }
      return handle;
    };

    const getImageEl = (assetId: string, storageUrl: string): HTMLImageElement => {
      let el = imageEls.get(assetId);
      if (!el) {
        el = new Image();
        el.crossOrigin = 'anonymous';
        el.src = storageUrl;
        imageEls.set(assetId, el);
      }
      return el;
    };

    // Preload everything referenced by the project up front so the render
    // loop never stalls mid-recording waiting on a network fetch.
    await Promise.all(
      project.items.map((item) => {
        if (item.type === 'video' || item.type === 'audio') {
          const asset = project.mediaAssets[item.mediaAssetId];
          if (!asset) return Promise.resolve();
          const el = item.type === 'video' ? getVideoHandle(asset.id, asset.storageUrl).element : getAudioHandle(asset.id, asset.storageUrl).element;
          return new Promise<void>((resolve) => {
            if ((el as HTMLMediaElement).readyState >= 1) return resolve();
            el.addEventListener('loadedmetadata', () => resolve(), { once: true });
            el.addEventListener('error', () => resolve(), { once: true }); // don't let one bad asset block the whole export
          });
        }
        if (item.type === 'image') {
          const asset = project.mediaAssets[item.mediaAssetId];
          if (!asset) return Promise.resolve();
          const el = getImageEl(asset.id, asset.storageUrl);
          return new Promise<void>((resolve) => {
            if (el.complete) return resolve();
            el.addEventListener('load', () => resolve(), { once: true });
            el.addEventListener('error', () => resolve(), { once: true });
          });
        }
        return Promise.resolve();
      }),
    );

    const canvasStream = (canvas as HTMLCanvasElement & { captureStream: (fps?: number) => MediaStream }).captureStream(project.frameRate);
    const combinedStream = new MediaStream([...canvasStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);

    const mimeType = pickSupportedMimeType();
    const recorder = new MediaRecorder(combinedStream, { mimeType });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    const cleanup = () => {
      videoHandles.forEach((h) => {
        h.element.pause();
        h.element.src = '';
        if (h.element.parentNode) h.element.parentNode.removeChild(h.element);
      });
      videoHandles.clear();
      imageEls.clear();
      audioCtx.close().catch(() => {});
    };

    return new Promise<RenderResult>((resolve, reject) => {
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        try {
          recorder.stop();
        } catch {
          /* already stopped */
        }
      };
      options.signal?.addEventListener('abort', onAbort);

      recorder.onstop = () => {
        options.signal?.removeEventListener('abort', onAbort);
        cleanup();
        if (aborted) {
          reject(new RenderAbortedError());
          return;
        }
        const blob = new Blob(chunks, { type: mimeType });
        resolve({ blob, mimeType, durationSeconds: totalSeconds });
      };

      let startWallClock = 0;
      let lastActiveVideoId: string | null = null;

      const tick = (wallClockNow: number) => {
        if (aborted) return;
        if (!startWallClock) startWallClock = wallClockNow;
        const t = (wallClockNow - startWallClock) / 1000;

        if (t >= totalSeconds) {
          recorder.stop();
          return;
        }

        const activeItems: TimelineItem[] = getItemsAtTime(project, t);

        // v1 PiP: sync EVERY active video item (main + overlays), not just
        // the first. Each handle gets its own trim-window seek + gain.
        // PiP items are muted by default (gain 0), so they never fight the
        // main video's audio unless the user explicitly unmutes them.
        const activeVideoAssetIds = new Set<string>();
        const videosMap = new Map<string, HTMLVideoElement>();
        let frameActiveVideo: { assetId: string; element: HTMLVideoElement } | undefined;
        for (const item of activeItems) {
          if (item.type !== 'video') continue;
          const asset = project.mediaAssets[item.mediaAssetId];
          if (!asset) continue;
          activeVideoAssetIds.add(asset.id);
          const handle = getVideoHandle(asset.id, asset.storageUrl);
          const targetTime = item.trimStart + Math.max(0, t - item.startTime);
          if (Math.abs((handle.element as HTMLVideoElement).currentTime - targetTime) > 0.35) {
            try { (handle.element as HTMLVideoElement).currentTime = targetTime; } catch { /* not seekable yet */ }
          }
          handle.element.play().catch(() => {});
          const videoFadeMul = computeFadeOpacity(item.fade, t - item.startTime, item.endTime - t);
          handle.gain.gain.value = item.muted ? 0 : item.volume * videoFadeMul;
          videosMap.set(asset.id, handle.element as HTMLVideoElement);
          if (!frameActiveVideo) frameActiveVideo = { assetId: asset.id, element: handle.element as HTMLVideoElement };
        }
        // Pause video handles whose items are no longer active.
        videoHandles.forEach((h, key) => {
          if (!key.startsWith('audio:') && !activeVideoAssetIds.has(key)) {
            h.element.pause();
            h.gain.gain.value = 0;
          }
        });
        void lastActiveVideoId;
        lastActiveVideoId = activeItems.find((i) => i.type === 'video')?.id ?? null;

        const activeAudioIds = new Set<string>();
        activeItems.forEach((item) => {
          if (item.type !== 'audio') return;
          const asset = project.mediaAssets[item.mediaAssetId];
          if (!asset) return;
          activeAudioIds.add(asset.id);
          const handle = getAudioHandle(asset.id, asset.storageUrl);
          if ((handle.element as HTMLAudioElement).paused) {
            const targetTime = item.trimStart + Math.max(0, t - item.startTime);
            try {
              (handle.element as HTMLAudioElement).currentTime = targetTime;
            } catch {
              /* ignore */
            }
            handle.element.play().catch(() => {});
          }
          // Apply the item's own fade-in/fade-out to its gain, not just
          // mute/volume — `AudioTimelineItem.fade` previously had no effect
          // anywhere (found during the full-app audio audit alongside
          // exposing it in the inspector for the first time); reuses the
          // exact same ramp `drawFrame` applies to visual opacity so an
          // audio fade and a video/image fade behave identically.
          const audioFadeMul = computeFadeOpacity(item.fade, t - item.startTime, item.endTime - t);
          handle.gain.gain.value = item.muted ? 0 : item.volume * audioFadeMul;
        });
        videoHandles.forEach((h, key) => {
          if (key.startsWith('audio:')) {
            const assetId = key.slice('audio:'.length);
            if (!activeAudioIds.has(assetId)) {
              h.element.pause();
              h.gain.gain.value = 0;
            }
          }
        });

        drawFrame(ctx, project, t, { images: imageEls, activeVideo: frameActiveVideo, videos: videosMap });

        options.onProgress?.({ fraction: Math.min(1, t / totalSeconds), renderedSeconds: t, totalSeconds });

        requestAnimationFrame(tick);
      };

      recorder.start(250);
      requestAnimationFrame(tick);
    }).catch((err) => {
      cleanup();
      throw err;
    });
  }
}
