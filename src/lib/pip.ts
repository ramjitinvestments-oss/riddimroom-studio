/**
 * RiddimRoom Studio — PiP (picture-in-picture) overlay helpers (v1).
 *
 * A PiP overlay is just a VideoTimelineItem with pip.isPip=true, a small
 * scale, a corner position, and a high zIndex — no parallel model.
 * Layouts are one-tap presets; the user can then drag/resize freely
 * (PreviewPane drag works for any video item, PiP included).
 */
import type { MediaAsset, PipSettings, Project, VideoTimelineItem } from '../types/timeline';
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
