import React, { useCallback, useEffect, useRef } from 'react';
import type { Project } from '../../types/timeline';
import { getItemsByTrackType } from '../../lib/timeline/utils';
import { drawFrame, type FrameAssets } from '../../lib/render/compositor';

/**
 * Live canvas preview — draws the same `drawFrame` compositor the export
 * renderer uses (see `src/lib/render/compositor.ts`), so what the editor
 * shows is what gets exported, not a second hand-maintained approximation.
 *
 * Video playback drives the clock: while a video timeline item is active at
 * the current position, this component plays that item's underlying
 * <video> element and derives the timeline's current time from the
 * video's own `currentTime` (accounting for that item's `startTime`/
 * `trimStart`) rather than a separate JS timer, so audio/video stay in
 * sync. When no video item is active (e.g. an image-only or text-only
 * span), a manual rAF clock advances time instead.
 *
 * Requires the Storage bucket to serve media with CORS enabled for the
 * app's origin (see `storage.cors.json` at the repo root) — without it,
 * the browser still plays the video normally but canvas capture
 * (export) will fail; this component itself degrades gracefully (browser
 * playback still works even if a captureStream-based caller downstream
 * would not).
 */

interface PreviewPaneProps {
  project: Project;
  currentTime: number;
  isPlaying: boolean;
  onTimeChange: (time: number) => void;
  onPlayingChange: (playing: boolean) => void;
}

export function PreviewPane({ project, currentTime, isPlaying, onTimeChange, onPlayingChange }: PreviewPaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoElsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const imageElsRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const activeVideoIdRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastFrameWallClockRef = useRef<number>(0);
  const projectRef = useRef(project);
  const currentTimeRef = useRef(currentTime);
  const isPlayingRef = useRef(isPlaying);

  projectRef.current = project;
  currentTimeRef.current = currentTime;
  isPlayingRef.current = isPlaying;

  const getVideoEl = useCallback((assetId: string, storageUrl: string) => {
    let el = videoElsRef.current.get(assetId);
    if (!el) {
      el = document.createElement('video');
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      el.muted = false;
      el.playsInline = true;
      el.src = storageUrl;
      videoElsRef.current.set(assetId, el);
    }
    return el;
  }, []);

  const getImageEl = useCallback((assetId: string, storageUrl: string) => {
    let el = imageElsRef.current.get(assetId);
    if (!el) {
      el = new Image();
      el.crossOrigin = 'anonymous';
      el.src = storageUrl;
      imageElsRef.current.set(assetId, el);
    }
    return el;
  }, []);

  // Main render/clock loop. Runs continuously while mounted so the canvas
  // stays correct after edits even while paused, not just while playing.
  useEffect(() => {
    const tick = (wallClockNow: number) => {
      const proj = projectRef.current;
      const canvas = canvasRef.current;
      if (!canvas) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const videoItems = getItemsByTrackType(proj, 'video').filter((i) => i.type === 'video');
      let t = currentTimeRef.current;
      const active = videoItems.find((i) => t >= i.startTime && t < i.endTime) as
        | (typeof videoItems)[number]
        | undefined;

      // Preload every image item currently referenced so drawFrame never
      // has to wait on a network fetch mid-draw.
      getItemsByTrackType(proj, 'image').forEach((item) => {
        if (item.type !== 'image') return;
        const asset = proj.mediaAssets[item.mediaAssetId];
        if (asset) getImageEl(asset.id, asset.storageUrl);
      });

      let frameAssets: FrameAssets = { images: imageElsRef.current };

      if (active && active.type === 'video') {
        const asset = proj.mediaAssets[active.mediaAssetId];
        if (asset) {
          const videoEl = getVideoEl(asset.id, asset.storageUrl);

          if (activeVideoIdRef.current !== active.id) {
            // Switching which video item is active: pause the previous one,
            // seek the new one to the correct source offset for this timeline position.
            videoElsRef.current.forEach((el) => el.pause());
            const targetSourceTime = active.trimStart + Math.max(0, t - active.startTime);
            if (Number.isFinite(targetSourceTime)) {
              try {
                videoEl.currentTime = targetSourceTime;
              } catch {
                /* not seekable yet — will settle once metadata loads */
              }
            }
            activeVideoIdRef.current = active.id;
          }

          if (isPlayingRef.current) {
            if (videoEl.paused) videoEl.play().catch(() => {});
            // Video-driven clock: derive global time from the element's own
            // currentTime so audio and picture never drift apart.
            const derived = active.startTime + (videoEl.currentTime - active.trimStart);
            if (Number.isFinite(derived) && derived >= active.startTime) {
              t = derived;
              currentTimeRef.current = t;
              onTimeChange(t);
            }
            if (videoEl.currentTime >= active.trimEnd || t >= active.endTime) {
              videoEl.pause();
            }
          } else {
            videoEl.pause();
          }

          frameAssets = { images: imageElsRef.current, activeVideo: { assetId: asset.id, element: videoEl } };
        }
      } else {
        // No active video item — pause everything and advance with a manual clock if playing.
        videoElsRef.current.forEach((el) => el.pause());
        activeVideoIdRef.current = null;
        if (isPlayingRef.current) {
          const last = lastFrameWallClockRef.current || wallClockNow;
          const deltaSeconds = (wallClockNow - last) / 1000;
          t = currentTimeRef.current + deltaSeconds;
          currentTimeRef.current = t;
          onTimeChange(t);
        }
      }
      lastFrameWallClockRef.current = wallClockNow;

      canvas.width = proj.canvasWidth;
      canvas.height = proj.canvasHeight;
      drawFrame(ctx, proj, t, frameAssets);

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getVideoEl, getImageEl, onTimeChange]);

  // Stop playback cleanly when the caller flips isPlaying off (e.g. reached the end).
  useEffect(() => {
    if (!isPlaying) {
      videoElsRef.current.forEach((el) => el.pause());
    }
  }, [isPlaying]);

  // External seeks (scrubber drag) — force the active video element to the right source offset.
  useEffect(() => {
    if (isPlayingRef.current) return; // playback loop owns currentTime while playing
    const videoItems = getItemsByTrackType(project, 'video').filter((i) => i.type === 'video');
    const active = videoItems.find((i) => currentTime >= i.startTime && currentTime < i.endTime) as
      | (typeof videoItems)[number]
      | undefined;
    if (active && active.type === 'video') {
      const asset = project.mediaAssets[active.mediaAssetId];
      if (asset) {
        const el = getVideoEl(asset.id, asset.storageUrl);
        const targetSourceTime = active.trimStart + Math.max(0, currentTime - active.startTime);
        try {
          el.currentTime = targetSourceTime;
        } catch {
          /* ignore until metadata is ready */
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentTime, project.id]);

  // Cleanup media elements when the whole preview unmounts.
  useEffect(
    () => () => {
      videoElsRef.current.forEach((el) => {
        el.pause();
        el.src = '';
      });
      videoElsRef.current.clear();
      imageElsRef.current.clear();
    },
    [],
  );

  const aspect = project.canvasWidth / project.canvasHeight;

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="bg-black rounded-lg overflow-hidden border border-white/10" style={{ width: '100%', maxWidth: 360, aspectRatio: `${aspect}` }}>
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPlayingChange(!isPlaying)}
          className="px-4 py-1.5 text-xs font-bold uppercase tracking-wide bg-emerald-600 hover:bg-emerald-500 rounded-lg text-white"
        >
          {isPlaying ? 'Pause' : 'Play'}
        </button>
        <span className="text-xs text-white/40 font-mono">{currentTime.toFixed(1)}s</span>
      </div>
    </div>
  );
}
