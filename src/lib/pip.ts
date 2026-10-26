/**
 * RiddimRoom Studio — PiP (picture-in-picture) overlay helpers (v1).
 *
 * A PiP overlay is just a VideoTimelineItem with pip.isPip=true, a small
 * scale, a corner position, and a high zIndex — no parallel model.
 * Layouts are one-tap presets; the user can then drag/resize freely
 * (PreviewPane drag works for any video item, PiP included).
 */
import type { MediaAsset, PipSettings, PipShape, Project, VideoTimelineItem } from '../types/timeline';
import { addItem, addMediaAsset, generateTimelineId, getItemsByTrackType, updateItem } from './timeline/utils';
import { MAX_MEDIA_SECONDS } from './media/constants';

export type PipLayoutId = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'side-by-side';

export interface PipLayout {
  id: PipLayoutId;
  label: string;
  position: { x: number; y: number };
  scale: number;
  shape: PipSettings['shape'];
}

export const PIP_LAYOUTS: PipLayout[] = [
  { id: 'bottom-right', label: 'Bottom-right circle', position: { x: 82, y: 78 }, scale: 0.32, shape: 'circle' },
  { id: 'bottom-left', label: 'Bottom-left', position: { x: 18, y: 78 }, scale: 0.32, shape: 'rounded' },
  { id: 'top-right', label: 'Top-right', position: { x: 82, y: 18 }, scale: 0.32, shape: 'rounded' },
  { id: 'top-left', label: 'Top-left', position: { x: 18, y: 18 }, scale: 0.32, shape: 'rounded' },
  { id: 'side-by-side', label: 'Side-by-side', position: { x: 75, y: 50 }, scale: 0.48, shape: 'rounded' },
];

export function getPipLayout(id: PipLayoutId): PipLayout {
  return PIP_LAYOUTS.find((l) => l.id === id) ?? PIP_LAYOUTS[0];
}

export interface AddPipOptions {
  layoutId?: PipLayoutId;
  atTime?: number;
  shape?: PipSettings['shape'];
  borderWidth?: number;
  borderColor?: string;
  /**
   * Source window (seconds) chosen in the pre-import trim/select modal for
   * an over-limit overlay video — same meaning as `appendMediaToTimeline`'s
   * options. When supplied, the overlay plays exactly that window instead
   * of the asset's head.
   */
  trimStart?: number;
  trimEnd?: number;
  /**
   * Initial mute state for the overlay's own audio. Defaults to `true` —
   * an uploaded overlay stays silent so the main video's audio remains
   * primary. The camera "Use as Overlay (PiP)" flow passes `false`:
   * a talking-head recording IS the sound the user wants, so it starts
   * audible at full volume. Either way the user can change it afterwards
   * (PiP panel "Overlay audio", the inspector, or the timeline clip's
   * quick-mute button — all write the same `muted`/`volume` fields).
   */
  muted?: boolean;
  /**
   * R24 — the asset is a camera recording (the CameraCapture "Use as
   * Overlay (PiP)" path). Camera PiPs get the WS-P3 framing default: a
   * ROUNDED-RECTANGLE, source-aspect box (`pip.fit: 'source'`) showing
   * the whole frame (head-and-shoulders), not the centre-cropped circle
   * — plus the talking-head audio default above. An explicit `shape`
   * option still wins over the rounded default. When omitted, the
   * existing camera signal is honoured instead: the camera flow is the
   * only current caller that passes `muted: false` (see `muted` above
   * and MediaImportPanel/EditorShell), so `muted === false` without an
   * explicit `fromCamera` is treated as a camera recording too — that
   * keeps the framing correct through the wiring that already exists,
   * with no change needed in the capture/import components.
   */
  fromCamera?: boolean;
}

/**
 * Adds a video asset as a PiP overlay on the video track, starting at
 * `atTime` (default 0) and lasting up to the asset duration (capped at
 * MAX_MEDIA_SECONDS). The overlay's audio is muted by default — the main
 * video's audio stays primary; the user can set the overlay's own volume
 * in the PiP panel / inspector. Pass `muted: false` (camera recordings)
 * to start with the overlay's audio on.
 */
export function addPipOverlay(project: Project, asset: MediaAsset, options: AddPipOptions = {}): Project {
  const layout = getPipLayout(options.layoutId ?? 'bottom-right');
  // R24 WS-P3: camera recordings default to the rounded, source-aspect
  // framing — even when the caller picked the (circular) bottom-right
  // layout, as EditorShell's overlay path always does. An explicit
  // `shape` option is the only override.
  const isCamera = options.fromCamera ?? options.muted === false;
  const shape = options.shape ?? (isCamera ? 'rounded' : layout.shape);
  let next = addMediaAsset(project, asset);
  const tracks = getItemsByTrackType(next, 'video');
  void tracks;
  // Video track: first video track (same as appendMediaToTimeline).
  const track = (next.tracks.find((t) => t.type === 'video') ?? null);
  if (!track) throw new Error('This project has no "video" track.');
  const zIndex = next.items.reduce((m, i) => Math.max(m, i.zIndex), -1) + 1;
  const fullDuration = asset.durationSeconds && Number.isFinite(asset.durationSeconds) ? asset.durationSeconds : 5;
  const trimStart = options.trimStart !== undefined ? Math.max(0, Math.min(options.trimStart, fullDuration)) : 0;
  const trimEnd =
    options.trimEnd !== undefined ? Math.max(trimStart + 0.1, Math.min(options.trimEnd, fullDuration)) : fullDuration;
  const duration = Math.min(trimEnd - trimStart, MAX_MEDIA_SECONDS);
  const startTime = options.atTime ?? 0;
  const item: VideoTimelineItem = {
    id: generateTimelineId('item'),
    type: 'video',
    trackId: track.id,
    startTime,
    endTime: startTime + duration,
    zIndex,
    visible: true,
    mediaAssetId: asset.id,
    position: { ...layout.position },
    scale: layout.scale,
    rotation: 0,
    opacity: 1,
    trimStart,
    trimEnd: trimStart + duration,
    speed: 1,
    reverse: false,
    volume: 1,
    muted: options.muted ?? !isCamera,
    pip: {
      shape,
      borderWidth: options.borderWidth ?? 4,
      borderColor: '#FFFFFF',
      shadow: true,
      isPip: true,
      // Camera items carry the source-aspect fit explicitly; every
      // other PiP omits the field and keeps the legacy cover framing.
      ...(isCamera ? { fit: 'source' as const } : {}),
    },
  };
  return addItem(next, item);
}

export function isPipItem(item: { type: string; pip?: PipSettings }): boolean {
  return item.type === 'video' && !!item.pip?.isPip;
}

// ---------------------------------------------------------------------------
// R25 — premium PiP shape registry
// ---------------------------------------------------------------------------

/** The brand gold used by the watermark pill and the R25 gold rings. */
export const PIP_BRAND_GOLD = '#FFD100';
/** Two-stop gold gradient for the premium ring (light → deep gold). */
export const PIP_GOLD_RING_STOPS = ['#FFE45C', '#C99300'] as const;
/** Default glow colour when a PiP enables glow without picking one. */
export const PIP_GLOW_GOLD = '#FFD100';
export const PIP_GLOW_WHITE = '#FFFFFF';

/**
 * The path surface every shape is traced onto. Structurally satisfied by
 * CanvasRenderingContext2D (the compositor and the picker thumbnails pass
 * the real context — the caller does `beginPath()` first) and by the
 * flattening sink behind `pipShapePolygon`, which is what lets the test
 * suite verify the EXACT geometry the renderer clips/strokes with,
 * without a canvas implementation.
 */
export interface PipPathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void;
  ellipse(x: number, y: number, radiusX: number, radiusY: number, rotation: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void;
  rect(x: number, y: number, w: number, h: number): void;
  roundRect(x: number, y: number, w: number, h: number, radii?: number): void;
  closePath(): void;
}

export interface PipShapeDef {
  id: PipShape;
  label: string;
  /**
   * Inscribed safe factor: the width (as a fraction of the box width) of
   * the largest CENTRED axis-aligned rectangle guaranteed to lie inside
   * the shape (same fraction on height, by symmetry of these shapes).
   * 1 = the whole box (square); circle ≈ 0.71; pointed/lobed shapes are
   * lower. Drives the shape-change refit (`pipShapeRefitZoom`, WS-S3).
   */
  safeFactor: number;
  /** Trace the shape's outline, centred on (0, 0), into a box of w × h. */
  trace(sink: PipPathSink, w: number, h: number): void;
}

/** The rounded-rect corner radius — MUST match the pre-R25 compositor
 *  formula so existing 'rounded' projects keep identical clip regions. */
export function pipRoundedRadius(w: number, h: number): number {
  return Math.min(28, Math.min(w, h) * 0.12);
}

function traceRoundedRect(sink: PipPathSink, w: number, h: number): void {
  // The native roundRect — literally the call the pre-R25 compositor
  // made, so 'rounded' clip regions are unchanged by construction.
  sink.roundRect(-w / 2, -h / 2, w, h, pipRoundedRadius(w, h));
}

function traceSquircle(sink: PipPathSink, w: number, h: number): void {
  // Superellipse, exponent 4 (the app-icon curve): |x/a|^4 + |y/b|^4 = 1,
  // sampled — chords sit inside the true curve, never outside the box.
  const a = w / 2;
  const b = h / 2;
  const steps = 96;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const px = a * Math.sign(c) * Math.pow(Math.abs(c), 0.5);
    const py = b * Math.sign(s) * Math.pow(Math.abs(s), 0.5);
    if (i === 0) sink.moveTo(px, py);
    else sink.lineTo(px, py);
  }
}

function tracePolygon(sink: PipPathSink, points: { x: number; y: number }[]): void {
  points.forEach((p, i) => (i === 0 ? sink.moveTo(p.x, p.y) : sink.lineTo(p.x, p.y)));
  if (points.length > 0) sink.lineTo(points[0].x, points[0].y);
}

function traceStar(sink: PipPathSink, w: number, h: number): void {
  // Smooth 5-point star, point up, inner radius 0.52 of the outer —
  // vertices joined with quadratic curves so the points read rounded,
  // not clip-art sharp. Rounding pulls the outline slightly INSIDE the
  // sharp polygon, so the traced star never escapes the box.
  const rx = w / 2;
  const ry = h / 2;
  const inner = 0.52;
  const verts: { x: number; y: number; outer: boolean }[] = [];
  for (let k = 0; k < 5; k++) {
    const ao = ((-90 + 72 * k) * Math.PI) / 180;
    verts.push({ x: rx * Math.cos(ao), y: ry * Math.sin(ao), outer: true });
    const ai = ((-54 + 72 * k) * Math.PI) / 180;
    verts.push({ x: rx * inner * Math.cos(ai), y: ry * inner * Math.sin(ai), outer: false });
  }
  const n = verts.length;
  const minSide = Math.min(w, h);
  const join = (i: number) => {
    const v = verts[(i % n + n) % n];
    const prev = verts[(i - 1 % n + n) % n];
    const next = verts[(i + 1) % n];
    const r = Math.min(v.outer ? minSide * 0.055 : minSide * 0.03, Math.hypot(v.x - prev.x, v.y - prev.y) / 2, Math.hypot(next.x - v.x, next.y - v.y) / 2);
    const toward = (p: { x: number; y: number }) => {
      const d = Math.hypot(p.x - v.x, p.y - v.y) || 1;
      return { x: v.x + ((p.x - v.x) / d) * r, y: v.y + ((p.y - v.y) / d) * r };
    };
    return { v, a: toward(prev), b: toward(next) };
  };
  const first = join(0);
  sink.moveTo(first.a.x, first.a.y);
  for (let i = 0; i < n; i++) {
    const j = join(i);
    sink.quadraticCurveTo(j.v.x, j.v.y, j.b.x, j.b.y);
    const nextJoin = join(i + 1);
    sink.lineTo(nextJoin.a.x, nextJoin.a.y);
  }
}

// The classic parametric heart, bounds measured once from the curve
// itself so the traced heart fills its box exactly, by construction.
const HEART_BOUNDS = (() => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i <= 360; i++) {
    const t = (i / 360) * Math.PI * 2;
    const s = Math.sin(t);
    const x = 16 * s * s * s;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
})();

function traceHeart(sink: PipPathSink, w: number, h: number): void {
  const { minX, maxX, minY, maxY } = HEART_BOUNDS;
  const steps = 160;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const s = Math.sin(t);
    const mx = 16 * s * s * s;
    const my = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    const px = ((mx - minX) / (maxX - minX) - 0.5) * w;
    const py = -(((my - minY) / (maxY - minY)) - 0.5) * h;
    if (i === 0) sink.moveTo(px, py);
    else sink.lineTo(px, py);
  }
}

function traceArch(sink: PipPathSink, w: number, h: number): void {
  // Flat sides and bottom, a half-ellipse crown. ry caps at half the
  // height so a wide, short box degrades to a pill-top, never negative.
  const ry = Math.min(w / 2, h / 2);
  const cy = -h / 2 + ry;
  sink.moveTo(-w / 2, h / 2);
  sink.lineTo(-w / 2, cy);
  sink.ellipse(0, cy, w / 2, ry, 0, Math.PI, Math.PI * 2);
  sink.lineTo(w / 2, h / 2);
  sink.lineTo(-w / 2, h / 2);
}

export const PIP_SHAPES: PipShapeDef[] = [
  {
    id: 'circle',
    label: 'Circle',
    safeFactor: 0.7,
    trace: (sink, w, h) => {
      sink.arc(0, 0, Math.min(w, h) / 2, 0, Math.PI * 2);
    },
  },
  {
    id: 'rounded',
    label: 'Rounded',
    safeFactor: 0.92,
    trace: traceRoundedRect,
  },
  {
    id: 'square',
    label: 'Square',
    safeFactor: 1,
    trace: (sink, w, h) => {
      sink.rect(-w / 2, -h / 2, w, h);
    },
  },
  { id: 'squircle', label: 'Squircle', safeFactor: 0.84, trace: traceSquircle },
  {
    id: 'diamond',
    label: 'Diamond',
    safeFactor: 0.5,
    trace: (sink, w, h) =>
      tracePolygon(sink, [
        { x: 0, y: -h / 2 },
        { x: w / 2, y: 0 },
        { x: 0, y: h / 2 },
        { x: -w / 2, y: 0 },
      ]),
  },
  {
    id: 'hexagon',
    label: 'Hexagon',
    safeFactor: 0.66,
    // Box-filling stretched hexagon: points at the left/right midline,
    // flat top/bottom edges — it touches all four sides of its box.
    trace: (sink, w, h) =>
      tracePolygon(sink, [
        { x: w / 2, y: 0 },
        { x: w / 4, y: h / 2 },
        { x: -w / 4, y: h / 2 },
        { x: -w / 2, y: 0 },
        { x: -w / 4, y: -h / 2 },
        { x: w / 4, y: -h / 2 },
      ]),
  },
  { id: 'star', label: 'Star', safeFactor: 0.34, trace: traceStar },
  { id: 'heart', label: 'Heart', safeFactor: 0.42, trace: traceHeart },
  { id: 'arch', label: 'Arch', safeFactor: 0.7, trace: traceArch },
];

export function getPipShapeDef(shape: PipShape | string | undefined): PipShapeDef {
  return PIP_SHAPES.find((s) => s.id === shape) ?? PIP_SHAPES.find((s) => s.id === 'square')!;
}

/** Trace a shape's outline into any path sink (canvas ctx, Path2D, test sink). */
export function tracePipShapePath(sink: PipPathSink, shape: PipShape | string | undefined, w: number, h: number): void {
  getPipShapeDef(shape).trace(sink, w, h);
}

/**
 * WS-S3 — the crop-zoom a shape change re-fits to. The user's zoom is
 * pulled back toward 1× in proportion to the new shape's safe factor:
 * a pointed/lobed shape (star 0.34, heart 0.42) relaxes a deep zoom far
 * more than a boxy one (square 1 = untouched), so a subject framed
 * tight for a rectangle is not left clipped by a point or a lobe. At
 * zoom 1 nothing changes — the cover fit already keeps the centre,
 * where subjects sit, inside every shape. Applied ONLY at the moment
 * the user changes shape (PiP panel / inspector); rendering never
 * re-fits on its own, and the user can re-zoom freely afterwards.
 */
export function pipShapeRefitZoom(currentZoom: number | undefined, shape: PipShape): number {
  const z = Math.min(3, Math.max(1, currentZoom ?? 1));
  const f = getPipShapeDef(shape).safeFactor;
  return Math.min(3, Math.max(1, 1 + (z - 1) * f));
}

// A sink that flattens everything a tracer emits into a polygon — the
// geometry the tests verify, produced by the very same tracers the
// renderer and the thumbnails draw with.
class FlatteningSink implements PipPathSink {
  points: { x: number; y: number }[] = [];
  private cur: { x: number; y: number } | null = null;
  private start: { x: number; y: number } | null = null;

  moveTo(x: number, y: number): void {
    this.points.push({ x, y });
    this.cur = { x, y };
    this.start = { x, y };
  }
  lineTo(x: number, y: number): void {
    this.points.push({ x, y });
    this.cur = { x, y };
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }
  roundRect(x: number, y: number, w: number, h: number, radii?: number): void {
    // Flattened as the lines + quarter arcs that define the roundRect
    // region (what the native call draws), with the radius the caller
    // asked for — the SDF regression test verifies the region matches.
    const rad = typeof radii === 'number' ? radii : 0;
    if (!(rad > 0)) {
      this.rect(x, y, w, h);
      return;
    }
    this.moveTo(x + rad, y);
    this.lineTo(x + w - rad, y);
    this.arc(x + w - rad, y + rad, rad, -Math.PI / 2, 0);
    this.lineTo(x + w, y + h - rad);
    this.arc(x + w - rad, y + h - rad, rad, 0, Math.PI / 2);
    this.lineTo(x + rad, y + h);
    this.arc(x + rad, y + h - rad, rad, Math.PI / 2, Math.PI);
    this.lineTo(x, y + rad);
    this.arc(x + rad, y + rad, rad, Math.PI, Math.PI * 1.5);
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void {
    const from = this.cur ?? { x: cpx, y: cpy };
    const steps = 16;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      this.lineTo(
        u * u * from.x + 2 * u * t * cpx + t * t * x,
        u * u * from.y + 2 * u * t * cpy + t * t * y,
      );
    }
  }
  bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number): void {
    const from = this.cur ?? { x: cp1x, y: cp1y };
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      this.lineTo(
        u * u * u * from.x + 3 * u * u * t * cp1x + 3 * u * t * t * cp2x + t * t * t * x,
        u * u * u * from.y + 3 * u * u * t * cp1y + 3 * u * t * t * cp2y + t * t * t * y,
      );
    }
  }
  private sweepTo(a0: number, a1: number, ccw: boolean | undefined, point: (t: number) => { x: number; y: number }): void {
    let delta = a1 - a0;
    if (ccw) {
      while (delta > 0) delta -= Math.PI * 2;
    } else {
      while (delta < 0) delta += Math.PI * 2;
    }
    const startPt = point(a0);
    if (!this.cur) this.moveTo(startPt.x, startPt.y);
    else if (Math.hypot(this.cur.x - startPt.x, this.cur.y - startPt.y) > 1e-9) this.lineTo(startPt.x, startPt.y);
    const steps = Math.max(2, Math.ceil(Math.abs(delta) / (Math.PI / 24)));
    for (let i = 1; i <= steps; i++) {
      const p = point(a0 + (delta * i) / steps);
      this.lineTo(p.x, p.y);
    }
  }
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void {
    this.sweepTo(startAngle, endAngle, counterclockwise, (t) => ({ x: x + radius * Math.cos(t), y: y + radius * Math.sin(t) }));
  }
  ellipse(x: number, y: number, radiusX: number, radiusY: number, _rotation: number, startAngle: number, endAngle: number, counterclockwise?: boolean): void {
    void _rotation;
    this.sweepTo(startAngle, endAngle, counterclockwise, (t) => ({ x: x + radiusX * Math.cos(t), y: y + radiusY * Math.sin(t) }));
  }
  closePath(): void {
    if (this.cur && this.start && Math.hypot(this.cur.x - this.start.x, this.cur.y - this.start.y) > 1e-9) {
      this.lineTo(this.start.x, this.start.y);
    }
  }
}

/**
 * The flattened outline polygon of a shape in a w × h box — used by the
 * geometry tests (inside-box, safe-factor, legacy-equivalence checks).
 */
export function pipShapePolygon(shape: PipShape | string | undefined, w: number, h: number): { x: number; y: number }[] {
  const sink = new FlatteningSink();
  tracePipShapePath(sink, shape, w, h);
  return sink.points;
}

/**
 * A flattening sink + its live points array — the render-geometry tests
 * drive `clipPipShape`/`strokePipBorder` with a fake context whose path
 * methods forward here, proving the compositor strokes/clips exactly
 * the polygon this module publishes.
 */
export function createPipShapeFlattener(): { sink: PipPathSink; points: { x: number; y: number }[] } {
  const sink = new FlatteningSink();
  return { sink, points: sink.points };
}

// ---------------------------------------------------------------------------
// Circle size + main/overlay swap (owner-requested editor changes)
// ---------------------------------------------------------------------------

/**
 * A video item fills the canvas at scale 1, so a PiP item's on-screen
 * width is simply its scale as a percentage of canvas width. The PiP
 * panel's Size slider speaks in that percentage.
 */
export function pipWidthPercentForScale(scale: number): number {
  return Math.round(scale * 100);
}

export function pipScaleForWidthPercent(percent: number): number {
  return Math.min(0.9, Math.max(0.08, percent / 100));
}

/**
 * The main video a PiP overlay sits on: the non-PiP video item with the
 * greatest time overlap with the overlay (ties → lowest zIndex, then
 * earliest start). Null when the project has no main video yet.
 */
export function findMainVideoForPip(project: Project, pipItem: VideoTimelineItem): VideoTimelineItem | null {
  const candidates = project.items.filter(
    (i): i is VideoTimelineItem => i.type === 'video' && !isPipItem(i),
  );
  if (candidates.length === 0) return null;
  const overlap = (i: VideoTimelineItem) =>
    Math.max(0, Math.min(i.endTime, pipItem.endTime) - Math.max(i.startTime, pipItem.startTime));
  return [...candidates].sort(
    (a, b) => overlap(b) - overlap(a) || a.zIndex - b.zIndex || a.startTime - b.startTime,
  )[0];
}

/**
 * Swap the main video and the selected PiP overlay (owner request): the
 * overlay becomes the full-frame main video and the main video becomes
 * the overlay, inheriting the PiP's shape/position/size. Each clip keeps
 * its own timing, trim, speed, volume and mute — only the role fields
 * (pip settings, position, scale, zIndex) trade places. Keyframe
 * end-transforms are cleared on both, since a glide authored for the main
 * stage makes no sense on a corner overlay and vice versa. Pure
 * transform: one call = one undo step. No-op when either side is missing.
 */
export function swapMainAndPip(project: Project, pipItemId: string): Project {
  const pipItem = project.items.find(
    (i): i is VideoTimelineItem => i.id === pipItemId && isPipItem(i),
  );
  if (!pipItem) return project;
  const main = findMainVideoForPip(project, pipItem);
  if (!main) return project;
  let next = updateItem(project, main.id, {
    pip: pipItem.pip,
    position: { ...pipItem.position },
    scale: pipItem.scale,
    zIndex: pipItem.zIndex,
    endTransform: undefined,
  });
  next = updateItem(next, pipItem.id, {
    pip: undefined,
    position: { ...main.position },
    scale: main.scale,
    zIndex: main.zIndex,
    endTransform: undefined,
  });
  return next;
}
