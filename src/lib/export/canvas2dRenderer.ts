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
import { getItemsAtTime, getMainTrackEnd, getProjectDuration } from '../timeline/utils';
import { computeAudioGainAtTime, computeLoopedSourceTime, drawFrame } from './../render/compositor';
import type { Renderer, RenderOptions, RenderResult } from './renderer';
import { RenderAbortedError } from './renderer';
import { EXPORT_FINISHING_ERROR } from './exportErrors';

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
    // R26 WS-A2: the main visual track's end is the audio boundary for
    // the whole export — every gain below is computed through
    // `computeAudioGainAtTime`, which contributes exactly 0 at/past it
    // (null = no visual main track = no clipping, pre-R26 behaviour).
    // Render-time clamp only: stored items are never modified.
    const mainTrackEnd = getMainTrackEnd(project);

    // Export-quality output size (Phase 2.1): defaults to the project's
    // own canvas dimensions exactly as before. When the picker asked for a
    // smaller output, the canvas IS that size and the compositor — which
    // lays out every frame in project coordinates (see drawFrame) — is
    // brought to it with a base scale transform set once here; every
    // per-item transform inside drawFrame composes on top of it.
    const outputWidth = options.output?.width ?? project.canvasWidth;
    const outputHeight = options.output?.height ?? project.canvasHeight;
    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser could not create a 2D rendering context for export.');
    if (outputWidth !== project.canvasWidth || outputHeight !== project.canvasHeight) {
      ctx.setTransform(outputWidth / project.canvasWidth, 0, 0, outputHeight / project.canvasHeight, 0, 0);
    }

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
        // Do NOT mute the element: in Chrome a muted element also feeds
        // silence into createMediaElementSource, which silently dropped
        // the main clip's voice from exports (music elements, unmuted,
        // came through). Attaching the source already reroutes the
        // element's audio exclusively into the graph, so nothing plays
        // aloud from the element itself.
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

    // Preload everything referenced by the project up front so the render
    // loop never stalls mid-recording waiting on a network fetch.
    // Video/audio items are REQUIRED media: one that fails to load (e.g.
    // the bucket refuses the crossOrigin fetch because CORS isn't applied
    // for this origin) is collected here and aborts the export below —
    // the old behavior (resolve on error and record anyway) is exactly
    // how users ended up with a black, silent MP4 and no explanation.
    const failedMedia: string[] = [];
    await Promise.all(
      project.items.map((item) => {
        if (item.type === 'video' || item.type === 'audio') {
          const asset = project.mediaAssets[item.mediaAssetId];
          if (!asset) return Promise.resolve();
          const el = item.type === 'video' ? getVideoHandle(asset.id, asset.storageUrl).element : getAudioHandle(asset.id, asset.storageUrl).element;
          const media = el as HTMLMediaElement;
          return new Promise<void>((resolve) => {
            const fail = () => {
              failedMedia.push(asset.fileName || asset.id);
              resolve();
            };
            if (media.error) return fail();
            if (media.readyState >= 1) return resolve();
            media.addEventListener('loadedmetadata', () => resolve(), { once: true });
            media.addEventListener('error', fail, { once: true });
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

    if (failedMedia.length > 0) {
      cleanup();
      throw new Error(
        `Media failed to load (${failedMedia.join(', ')}) — export cancelled. Check your connection or file access, then try again.`,
      );
    }

    // A canvas tainted by non-CORS media (e.g. the preview's playback
    // fallback) makes captureStream() throw a SecurityError — surface
    // that as a clear message instead of an opaque browser exception.
    let canvasStream: MediaStream;
    try {
      canvasStream = (canvas as HTMLCanvasElement & { captureStream: (fps?: number) => MediaStream }).captureStream(
        options.output?.frameRate ?? project.frameRate,
      );
    } catch (captureErr) {
      cleanup();
      // R34: the CORS cause is diagnosis detail for the console only —
      // the user-facing message is the plain finishing string.
      // eslint-disable-next-line no-console
      console.error('[canvas2dRenderer] canvas capture failed (likely a clip loaded without CORS access):', captureErr);
      throw new Error(EXPORT_FINISHING_ERROR);
    }
    const combinedStream = new MediaStream([...canvasStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);

    const mimeType = pickSupportedMimeType();
    // Export-quality bitrates (Phase 2.1): pinned only when the caller
    // resolved output settings; without them MediaRecorder keeps its
    // browser-default bitrate, as before.
    const recorderOptions: MediaRecorderOptions = { mimeType };
    if (options.output) {
      recorderOptions.videoBitsPerSecond = options.output.videoBitsPerSecond;
      recorderOptions.audioBitsPerSecond = options.output.audioBitsPerSecond;
    }
    const recorder = new MediaRecorder(combinedStream, recorderOptions);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    // Autoplay policy: an AudioContext created outside the direct export
    // click handler can start in the 'suspended' state, which would leave
    // the mixed destination stream silent for the entire recording even
    // though every element is playing. Resume it before the recorder
    // starts so the exported audio track actually carries sound.
    try {
      await audioCtx.resume();
    } catch {
      /* best effort — the render proceeds; the final blob-size sanity
         check in the caller still guards against a silent output file */
    }

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
          // Speed (Phase 2.3): mirror PreviewPane exactly — the element
          // plays at the item's rate and timeline time maps to source
          // time through it, so a 2x clip occupies half the timeline span
          // in the export just as it does in the preview.
          (handle.element as HTMLVideoElement).playbackRate = item.speed || 1;
          const targetTime = item.trimStart + Math.max(0, t - item.startTime) * (item.speed || 1);
          if (Math.abs((handle.element as HTMLVideoElement).currentTime - targetTime) > 0.35) {
            try { (handle.element as HTMLVideoElement).currentTime = targetTime; } catch { /* not seekable yet */ }
          }
          handle.element.play().catch(() => {});
          // The item's own fade (WS-A1) and the main-track boundary
          // (WS-A2) both live in the shared gain helper — the embedded
          // audio of a clip that overhangs the main end contributes
          // nothing past the boundary, same as a standalone audio item.
          handle.gain.gain.value = computeAudioGainAtTime(item, t, mainTrackEnd);
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
          // Looping items (tweaks round): the target wraps inside the
          // trim window (`computeLoopedSourceTime`, the same helper the
          // preview uses, so both wrap at the same moments). A playing
          // element only needs a seek when it crosses a wrap — the
          // >0.35s divergence check catches exactly that, mirroring the
          // video branch's drift handling above. The element's own
          // `loop` property is not used: it wraps at the file's end, not
          // the trim window's. Non-loop items keep the original
          // seek-on-start behavior untouched.
          const targetTime = item.loop
            ? computeLoopedSourceTime(item.trimStart, item.trimEnd, Math.max(0, t - item.startTime))
            : item.trimStart + Math.max(0, t - item.startTime);
          if ((handle.element as HTMLAudioElement).paused) {
            try {
              (handle.element as HTMLAudioElement).currentTime = targetTime;
            } catch {
              /* ignore */
            }
            handle.element.play().catch(() => {});
          } else if (item.loop && Math.abs((handle.element as HTMLAudioElement).currentTime - targetTime) > 0.35) {
            try {
              (handle.element as HTMLAudioElement).currentTime = targetTime;
            } catch {
              /* ignore */
            }
          }
          // Apply the item's own fade-in/fade-out to its gain, not just
          // mute/volume — `AudioTimelineItem.fade` previously had no effect
          // anywhere (found during the full-app audio audit alongside
          // exposing it in the inspector for the first time); reuses the
          // exact same ramp `drawFrame` applies to visual opacity so an
          // audio fade and a video/image fade behave identically. R26:
          // the shared helper also clamps the audible window at the
          // main-track boundary (WS-A2) — a looping item keeps wrapping
          // inside its trim window below, but its gain is exactly 0
          // at/past the boundary, so the fill never sounds past the
          // main end.
          handle.gain.gain.value = computeAudioGainAtTime(item, t, mainTrackEnd);
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
