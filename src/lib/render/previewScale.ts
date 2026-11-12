/**
 * R44 Phase A (SF-1/SF-2, audit AUDIT-R43 §2.2/§3.2) — the preview's
 * display-scale route.
 *
 * The compositor (`drawFrame`) draws in PROJECT coordinates: every
 * exporter hands it a canvas at full project resolution and gets a
 * full-resolution frame. The live preview used to do exactly the same
 * thing into its on-screen canvas — up to 2160×3840 backing pixels
 * composited ~60 times a second into a box a few hundred CSS pixels
 * wide, even while paused. The reel preview renderer
 * (`reelPreviewRenderer.ts`) already proved the compositor's scale
 * route: size the canvas small, `ctx.scale(canvasW/projectW,
 * canvasH/projectH)`, and `drawFrame` produces the same picture,
 * scaled. This module is the math + the draw decision behind using
 * that route for the main preview:
 *
 * - `previewBackingSize` — the canvas backing store for a given
 *   on-screen box: box × devicePixelRatio, never larger than the
 *   project itself (a small project in a big box gains nothing from
 *   upscaling its backing store), aspect preserved by construction
 *   (one uniform ratio drives both axes).
 * - `previewDrawDecision` — the idle skip: while PAUSED, a tick whose
 *   project, playhead time, media state and canvas size are all
 *   identical to the last drawn frame has nothing new to paint, so
 *   the composite is skipped. Any change at all — an edit (new project
 *   object), a seek (new time), a media element settling (new media
 *   signature), a resize (new backing size) — forces the draw, and
 *   while PLAYING the draw always happens. This is what preserves
 *   R42's hard-won "paused edits repaint instantly" behaviour: an edit
 *   IS a project change, so it always invalidates.
 *
 * Export rendering is untouched by this module — the exporters keep
 * sizing their canvases at full project resolution.
 */

export interface PreviewBackingSize {
  /** Backing-store pixels. */
  width: number;
  height: number;
  /** Transform that maps project coordinates onto the backing store. */
  scaleX: number;
  scaleY: number;
}

/**
 * Backing size for the preview canvas. `boxWidth`/`boxHeight` are the
 * canvas's CSS-pixel display size (the pane's fitted box, which always
 * carries the project's aspect ratio); `dpr` is the display's
 * devicePixelRatio (clamped to [1, 3] — beyond 3 the extra pixels buy
 * nothing a phone screen can show and cost real memory).
 */
export function previewBackingSize(
  boxWidth: number,
  boxHeight: number,
  projectWidth: number,
  projectHeight: number,
  dpr: number,
): PreviewBackingSize {
  const safeBoxW = Math.max(1, boxWidth);
  const safeBoxH = Math.max(1, boxHeight);
  const safeProjW = Math.max(1, projectWidth);
  const safeProjH = Math.max(1, projectHeight);
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? Math.min(3, Math.max(1, dpr)) : 1;
  // One uniform ratio: the display ratio, capped so the backing store
  // never exceeds the project's own resolution on either axis.
  const ratio = Math.min(safeDpr, safeProjW / safeBoxW, safeProjH / safeBoxH);
  const width = Math.max(1, Math.round(safeBoxW * ratio));
  const height = Math.max(1, Math.round(safeBoxH * ratio));
  return { width, height, scaleX: width / safeProjW, scaleY: height / safeProjH };
}

export interface PreviewDrawInputs {
  /** Playback is running — the frame advances, always draw. */
  isPlaying: boolean;
  /** A frame has been drawn at least once on this mount. */
  hasDrawn: boolean;
  /** The canvas backing size changed this tick (assignment wipes the buffer — must repaint). */
  sizeChanged: boolean;
  /** The project object differs from the one last drawn (any edit). */
  projectChanged: boolean;
  /** The playhead time differs from the one last drawn (seek / step). */
  timeChanged: boolean;
  /** The media signature differs (an element settled, decoded, or moved). */
  mediaChanged: boolean;
}

/**
 * Should this tick composite a frame? Returns false ONLY for the
 * provably-identical paused tick: same project, same time, same media
 * state, same canvas size, and something already on the canvas.
 */
export function previewDrawDecision(input: PreviewDrawInputs): boolean {
  if (!input.hasDrawn) return true;
  if (input.isPlaying) return true;
  if (input.sizeChanged) return true;
  if (input.projectChanged) return true;
  if (input.timeChanged) return true;
  if (input.mediaChanged) return true;
  return false;
}

/**
 * A cheap content signature of the media elements feeding a frame:
 * for each video, its asset id + playhead position + readiness; for
 * each image, its asset id + loaded-ness. When a paused preview's
 * elements settle (a seek lands, a frame decodes, an image arrives),
 * the signature moves and the next tick repaints — the mechanism that
 * keeps the idle skip honest without listening to media events.
 */
export function mediaFrameSignature(
  videos: Iterable<readonly [string, { currentTime: number; readyState: number }]> | null,
  images: Iterable<readonly [string, { complete: boolean; naturalWidth: number }]> | null,
): string {
  let sig = '';
  if (videos) {
    for (const [assetId, el] of videos) {
      sig += `v:${assetId}:${el.currentTime.toFixed(3)}:${el.readyState};`;
    }
  }
  if (images) {
    for (const [assetId, el] of images) {
      sig += `i:${assetId}:${el.complete ? 1 : 0}:${el.naturalWidth};`;
    }
  }
  return sig;
}
