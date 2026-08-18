import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project, TimelineItem } from '../../types/timeline';
import { getItemsAtTime, getItemsByTrackType, getProjectDuration, updateItem } from '../../lib/timeline/utils';
import { computeFadeOpacity, drawFrame, getItemBoundsPercent, type FrameAssets, type ItemBoundsPercent } from '../../lib/render/compositor';
import { useProject } from '../../context/ProjectContext';

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
 *
 * Full-app audit additions (real-user browser testing found these missing/
 * disconnected even though the underlying `Transform`/`AudioTimelineItem`
 * data model already supported them — see `types/timeline.ts`):
 * - Standalone `audio` track items were never played back here at all (only
 *   a `video` item's own embedded audio played, and always unmuted at full
 *   volume regardless of that item's own `volume`/`muted` fields) — an
 *   imported music/voiceover track was completely silent in the live
 *   editor even though it showed on the timeline and was correctly mixed
 *   into the actual export (`canvas2dRenderer.ts` already handled this
 *   correctly; only the *preview* was missing it).
 * - There was no way to select a video/image/text item by clicking it on
 *   the canvas, nor to drag it to reposition or resize it — `position`/
 *   `scale` could only be set via the inspector's numeric sliders. This
 *   file now overlays a selection box + drag handles computed from
 *   `getItemBoundsPercent` (the exact geometry `drawFrame` itself uses),
 *   so what you see is what you can grab.
 */

interface PreviewPaneProps {
  project: Project;
  currentTime: number;
  isPlaying: boolean;
  onTimeChange: (time: number) => void;
  onPlayingChange: (playing: boolean) => void;
  selectedItemId: string | null;
  onSelectItem: (itemId: string | null) => void;
}

/** Selected-item types that can actually be dragged/resized on canvas — text has no fixed render box for a resize handle to grab (font size drives its size instead), so it's select+move only. */
type DraggableVisualType = 'video' | 'image' | 'text';

export function PreviewPane({ project, currentTime, isPlaying, onTimeChange, onPlayingChange, selectedItemId, onSelectItem }: PreviewPaneProps) {
  const { mutate } = useProject();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const [previewBoxSize, setPreviewBoxSize] = useState({ width: 360, height: 640 });
  const videoElsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const imageElsRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const activeVideoIdRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastFrameWallClockRef = useRef<number>(0);
  const projectRef = useRef(project);
  const currentTimeRef = useRef(currentTime);
  const isPlayingRef = useRef(isPlaying);
  const onPlayingChangeRef = useRef(onPlayingChange);
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [itemBounds, setItemBounds] = useState<Map<string, ItemBoundsPercent & { type: DraggableVisualType }>>(new Map());
  const dragStateRef = useRef<
    | { mode: 'move'; itemId: string; startClientX: number; startClientY: number; originalX: number; originalY: number }
    | { mode: 'resize'; itemId: string; startClientX: number; centerXPercent: number; originalScale: number }
    | null
  >(null);

  projectRef.current = project;
  currentTimeRef.current = currentTime;
  isPlayingRef.current = isPlaying;
  onPlayingChangeRef.current = onPlayingChange;

  const getVideoEl = useCallback((assetId: string, storageUrl: string) => {
    let el = videoElsRef.current.get(assetId);
    if (!el) {
      el = document.createElement('video');
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      el.muted = false;
      el.playsInline = true;
      // Found via live browser testing: a <video> element that is never
      // connected to the document can sit at readyState 0 (HAVE_NOTHING)
      // forever in some browser/extension configurations — it fires
      // `loadstart` then `stalled` and never actually decodes, so
      // `currentTime`/`play()`/`drawImage()` all silently do nothing. An
      // <img>/`new Image()` does not have this requirement (it decodes
      // fine detached), which is why only the video path needs this.
      // Kept fully off-screen and non-interactive; this is a decode
      // requirement, not a visible player.
      el.style.position = 'fixed';
      el.style.width = '1px';
      el.style.height = '1px';
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
      el.tabIndex = -1;
      document.body.appendChild(el);
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
      // Diagnostic only — this does not change what gets drawn. A failed
      // load (network error, 404, or a Storage bucket missing CORS config
      // for this origin) leaves `el` in the "broken" state (complete=true,
      // naturalWidth=0); `drawFrame`'s `isImageReady` check in
      // compositor.ts is what actually keeps a broken image out of
      // `ctx.drawImage()`, so this handler only surfaces the failure for
      // debugging rather than papering over it.
      el.onerror = () => {
        console.warn(`[PreviewPane] failed to load image asset "${assetId}" from ${storageUrl}`);
      };
      el.src = storageUrl;
      imageElsRef.current.set(assetId, el);
    }
    return el;
  }, []);

  const getAudioEl = useCallback((assetId: string, storageUrl: string) => {
    let el = audioElsRef.current.get(assetId);
    if (!el) {
      el = document.createElement('audio');
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      el.style.display = 'none';
      document.body.appendChild(el);
      el.src = storageUrl;
      audioElsRef.current.set(assetId, el);
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

          // Apply this item's own volume/mute (previously hardcoded to
          // always-unmuted/full-volume regardless of the item's actual
          // fields — found during the full-app audio audit: muting or
          // lowering a video clip's volume via the inspector had no
          // audible effect in the live preview even though the same
          // fields were already correctly respected by the real export
          // renderer, `canvas2dRenderer.ts`).
          videoEl.muted = active.muted;
          videoEl.volume = Math.max(0, Math.min(1, active.volume));

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

      // Standalone `audio` timeline items — full-app audit finding: these
      // were never played back in the live preview at all (only a video
      // item's own embedded audio ever played), so an imported music/
      // voiceover track was silent in the editor despite showing correctly
      // on the timeline and despite the export renderer already mixing it
      // in correctly. Mirrors the video branch above: seek/play/pause each
      // active audio item's element and apply its own volume/mute, pause
      // every audio item that is not currently active.
      const activeAudioItemIds = new Set<string>();
      getItemsByTrackType(proj, 'audio').forEach((item) => {
        if (item.type !== 'audio') return;
        if (!(t >= item.startTime && t < item.endTime)) return;
        const asset = proj.mediaAssets[item.mediaAssetId];
        if (!asset) return;
        activeAudioItemIds.add(item.id);
        const audioEl = getAudioEl(asset.id, asset.storageUrl);
        const fadeMul = computeFadeOpacity(item.fade, t - item.startTime, item.endTime - t);
        audioEl.muted = item.muted;
        audioEl.volume = Math.max(0, Math.min(1, item.volume * fadeMul));
        const targetSourceTime = item.trimStart + Math.max(0, t - item.startTime);
        if (isPlayingRef.current) {
          // Only force-seek on a real discontinuity (item just became
          // active, or drifted noticeably) — reassigning currentTime every
          // frame during normal playback would cause audible stutter.
          if (Number.isFinite(targetSourceTime) && Math.abs(audioEl.currentTime - targetSourceTime) > 0.35) {
            try {
              audioEl.currentTime = targetSourceTime;
            } catch {
              /* not seekable yet */
            }
          }
          if (audioEl.paused) audioEl.play().catch(() => {});
        } else {
          audioEl.pause();
          if (Number.isFinite(targetSourceTime)) {
            try {
              audioEl.currentTime = targetSourceTime;
            } catch {
              /* not seekable yet */
            }
          }
        }
      });
      audioElsRef.current.forEach((el, assetId) => {
        // Pause any audio element whose owning item is no longer active at this time.
        const stillActive = getItemsByTrackType(proj, 'audio').some(
          (item) => item.type === 'audio' && proj.mediaAssets[item.mediaAssetId]?.id === assetId && activeAudioItemIds.has(item.id),
        );
        if (!stillActive && !el.paused) el.pause();
      });

      lastFrameWallClockRef.current = wallClockNow;

      // Single authoritative project-duration clamp (Phase 3 requirement):
      // playback — video-driven or the manual clock above — must never let
      // the playhead move past `getProjectDuration(project)`, and must stop
      // (not loop) once it gets there. Per-item pausing (the video branch
      // above stopping at that item's own endTime) already handles the
      // common case where the last item ends exactly at the project's end,
      // but this clamp is what makes it correct in general (e.g. a
      // shorter video item followed by an image/text/caption tail, or a
      // manual-clock-only project with no video at all).
      const projectDuration = getProjectDuration(proj);
      if (projectDuration > 0 && t >= projectDuration) {
        t = projectDuration;
        currentTimeRef.current = t;
        if (isPlayingRef.current) {
          onTimeChange(t);
          onPlayingChangeRef.current(false);
          videoElsRef.current.forEach((el) => el.pause());
        }
      }

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

  // Cleanup media elements when the whole preview unmounts. Video elements
  // are appended to document.body by getVideoEl (see its comment) and must
  // be explicitly removed here — they don't unmount on their own the way a
  // React-rendered element would.
  useEffect(
    () => () => {
      videoElsRef.current.forEach((el) => {
        el.pause();
        el.src = '';
        if (el.parentNode) el.parentNode.removeChild(el);
      });
      videoElsRef.current.clear();
      imageElsRef.current.clear();
      audioElsRef.current.forEach((el) => {
        el.pause();
        el.src = '';
        if (el.parentNode) el.parentNode.removeChild(el);
      });
      audioElsRef.current.clear();
    },
    [],
  );

  // On-canvas selection/drag/resize — full-app audit ("free canvas
  // positioning", "preview interaction"): `Transform.position`/`.scale`
  // already existed on video/image/text items and were already editable via
  // the inspector's numeric sliders, but there was no way to select or
  // manipulate an item directly on the canvas the way a real editor lets
  // you. Bounding boxes are computed with `getItemBoundsPercent` — the same
  // geometry `drawFrame` itself uses — so the box always matches what's
  // actually drawn, never a second approximation of it.
  const measureText = useCallback((text: string, effectiveFontSize: number): { width: number; height: number } => {
    if (!measureCanvasRef.current) measureCanvasRef.current = document.createElement('canvas');
    const ctx = measureCanvasRef.current.getContext('2d');
    if (!ctx) return { width: effectiveFontSize * Math.max(1, text.length) * 0.55, height: effectiveFontSize * 1.2 };
    ctx.font = `${effectiveFontSize}px Arial, Helvetica, sans-serif`;
    const width = ctx.measureText(text || ' ').width;
    return { width: Math.max(width, 4), height: effectiveFontSize * 1.2 };
  }, []);

  const getBoundsForItem = useCallback(
    (item: TimelineItem): (ItemBoundsPercent & { type: DraggableVisualType; itemId: string; scale: number }) | null => {
      if (item.type === 'video') {
        const bounds = getItemBoundsPercent(item, 'video', project.canvasWidth, project.canvasHeight);
        return { ...bounds, type: 'video', itemId: item.id, scale: item.scale };
      }
      if (item.type === 'image') {
        const asset = project.mediaAssets[item.mediaAssetId];
        const imgEl = imageElsRef.current.get(item.mediaAssetId);
        const aspect =
          imgEl && imgEl.naturalWidth > 0
            ? imgEl.naturalHeight / imgEl.naturalWidth
            : asset && asset.width && asset.height
              ? asset.height / asset.width
              : 1;
        const bounds = getItemBoundsPercent(item, 'image', project.canvasWidth, project.canvasHeight, { naturalImageAspect: aspect });
        return { ...bounds, type: 'image', itemId: item.id, scale: item.scale };
      }
      if (item.type === 'text') {
        // `.scale` used to be a dead field for text items — see the fix in
        // compositor.ts's drawTextItem — so the on-canvas box must use the
        // same effective (fontSize * scale) size that now actually renders.
        const { width, height } = measureText(item.text, item.fontSize * item.scale);
        const bounds = getItemBoundsPercent(item, 'text', project.canvasWidth, project.canvasHeight, { textWidthPx: width, textHeightPx: height });
        return { ...bounds, type: 'text', itemId: item.id, scale: item.scale };
      }
      return null;
    },
    [project, measureText],
  );

  const selectedBounds = useMemo(() => {
    if (!selectedItemId) return null;
    const item = project.items.find((i) => i.id === selectedItemId);
    if (!item) return null;
    const active = getItemsAtTime(project, currentTime).some((i) => i.id === item.id);
    if (!active) return null;
    return getBoundsForItem(item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, currentTime, selectedItemId, getBoundsForItem]);

  const beginMoveDrag = useCallback(
    (e: React.MouseEvent, itemId: string, originalX: number, originalY: number) => {
      e.preventDefault();
      dragStateRef.current = { mode: 'move', itemId, startClientX: e.clientX, startClientY: e.clientY, originalX, originalY };
      const handleMove = (ev: MouseEvent) => {
        const s = dragStateRef.current;
        const el = containerRef.current;
        if (!s || s.mode !== 'move' || !el) return;
        const rect = el.getBoundingClientRect();
        const dxPercent = ((ev.clientX - s.startClientX) / rect.width) * 100;
        const dyPercent = ((ev.clientY - s.startClientY) / rect.height) * 100;
        const newX = Math.max(0, Math.min(100, s.originalX + dxPercent));
        const newY = Math.max(0, Math.min(100, s.originalY + dyPercent));
        mutate((p) => updateItem(p, s.itemId, { position: { x: newX, y: newY } }));
      };
      const handleUp = () => {
        dragStateRef.current = null;
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleUp);
      };
      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleUp);
    },
    [mutate],
  );

  const beginResizeDrag = useCallback(
    (e: React.MouseEvent, itemId: string, centerXPercent: number, originalScale: number, originalWidthPercent: number) => {
      e.preventDefault();
      e.stopPropagation();
      dragStateRef.current = { mode: 'resize', itemId, startClientX: e.clientX, centerXPercent, originalScale };
      const handleMove = (ev: MouseEvent) => {
        const el = containerRef.current;
        const s = dragStateRef.current;
        if (!s || s.mode !== 'resize' || !el) return;
        const rect = el.getBoundingClientRect();
        const mouseXPercent = ((ev.clientX - rect.left) / rect.width) * 100;
        const newWidthPercent = Math.abs(mouseXPercent - s.centerXPercent) * 2;
        const newScale = Math.max(0.05, Math.min(5, s.originalScale * (newWidthPercent / Math.max(0.5, originalWidthPercent))));
        mutate((p) => updateItem(p, s.itemId, { scale: newScale }));
      };
      const handleUp = () => {
        dragStateRef.current = null;
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleUp);
      };
      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleUp);
    },
    [mutate],
  );

  const handleCanvasMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const xPercent = ((e.clientX - rect.left) / rect.width) * 100;
      const yPercent = ((e.clientY - rect.top) / rect.height) * 100;

      const activeVisual = getItemsAtTime(projectRef.current, currentTimeRef.current).filter(
        (i) => i.type === 'video' || i.type === 'image' || i.type === 'text',
      );
      const sorted = [...activeVisual].sort((a, b) => b.zIndex - a.zIndex); // topmost (highest zIndex) first
      let hit: TimelineItem | null = null;
      let hitBounds: ReturnType<typeof getBoundsForItem> = null;
      for (const item of sorted) {
        const bounds = getBoundsForItem(item);
        if (!bounds) continue;
        if (
          xPercent >= bounds.leftPercent &&
          xPercent <= bounds.leftPercent + bounds.widthPercent &&
          yPercent >= bounds.topPercent &&
          yPercent <= bounds.topPercent + bounds.heightPercent
        ) {
          hit = item;
          hitBounds = bounds;
          break;
        }
      }
      // Clicking empty canvas leaves the current selection alone — the app
      // has no explicit "deselect" action anywhere (only Delete clears
      // selection, as a side effect of removing the item), so this matches
      // that existing convention rather than inventing a new one.
      if (hit && hitBounds && 'position' in hit) {
        onSelectItem(hit.id);
        beginMoveDrag(e, hit.id, (hit as { position: { x: number; y: number } }).position.x, (hit as { position: { x: number; y: number } }).position.y);
      }
    },
    [getBoundsForItem, onSelectItem, beginMoveDrag],
  );

  const aspect = project.canvasWidth / project.canvasHeight;

  // Preview sizing (full-app audit: "preview/canvas is too small") — fits
  // the canvas box to whichever of (available column width, available
  // viewport height) is more restrictive, recomputed on layout/window
  // resize via ResizeObserver rather than a fixed pixel cap (the previous
  // `maxWidth: 360` was a hard-coded constant regardless of how much
  // screen space was actually available). `RESERVED_VERTICAL_PX` accounts
  // for the header, the play/pause row, and the timeline panel below this
  // component so the box never grows tall enough to push those off-screen.
  useEffect(() => {
    const RESERVED_VERTICAL_PX = 260;
    const recompute = () => {
      const availableWidth = outerRef.current?.clientWidth || 360;
      const availableHeight = Math.max(160, window.innerHeight - RESERVED_VERTICAL_PX);
      // Fit-within-both-constraints: try filling the available width, then
      // shrink to the available height if that would be too tall.
      let width = availableWidth;
      let height = width / aspect;
      if (height > availableHeight) {
        height = availableHeight;
        width = height * aspect;
      }
      setPreviewBoxSize({ width: Math.round(width), height: Math.round(height) });
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    if (outerRef.current) ro.observe(outerRef.current);
    window.addEventListener('resize', recompute);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', recompute);
    };
  }, [aspect]);

  return (
    <div ref={outerRef} className="flex flex-col items-center gap-2 w-full">
      <div
        ref={containerRef}
        onMouseDown={handleCanvasMouseDown}
        className="relative"
        style={{
          // Computed explicitly in pixels (`previewBoxSize`, see the
          // ResizeObserver effect above) rather than left to pure CSS
          // `aspect-ratio` + `max-height` — found via live browser testing
          // that in this nested flex layout, a `max-height` constraint on
          // an `aspect-ratio` box was NOT actually being honored (the box
          // rendered far taller than the viewport, cut off at the bottom),
          // so this project's preview is a portrait (9:16) canvas whose
          // dominant/limiting dimension on a normal monitor is height, not
          // width — computing both explicitly is what makes "use the
          // available workspace, but never taller than the viewport"
          // actually hold.
          width: previewBoxSize.width,
          height: previewBoxSize.height,
        }}
      >
        <div className="absolute inset-0 bg-black rounded-lg overflow-hidden border border-white/10">
          <canvas ref={canvasRef} className="w-full h-full" />
        </div>
        {selectedBounds && (
          <div
            className="absolute border-2 border-emerald-400 cursor-move"
            style={{
              left: `${selectedBounds.leftPercent}%`,
              top: `${selectedBounds.topPercent}%`,
              width: `${selectedBounds.widthPercent}%`,
              height: `${selectedBounds.heightPercent}%`,
            }}
            title="Drag to move"
          >
            <div
              onMouseDown={(e) =>
                beginResizeDrag(
                  e,
                  selectedBounds.itemId,
                  selectedBounds.leftPercent + selectedBounds.widthPercent / 2,
                  selectedBounds.scale,
                  selectedBounds.widthPercent,
                )
              }
              title="Drag to resize"
              className="absolute w-3.5 h-3.5 bg-emerald-400 rounded-sm cursor-nwse-resize"
              style={{ right: -7, bottom: -7 }}
            />
          </div>
        )}
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
