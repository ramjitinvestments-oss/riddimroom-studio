/**
 * RiddimRoom Studio — PiP (picture-in-picture) overlay helpers (v1).
 *
 * A PiP overlay is just a VideoTimelineItem with pip.isPip=true, a small
 * scale, a corner position, and a high zIndex — no parallel model.
 * Layouts are one-tap presets; the user can then drag/resize freely
 * (PreviewPane drag works for any video item, PiP included).
 */
import type { MediaAsset, PipSettings, Project, VideoTimelineItem } from '../types/timeline';
import { addItem, addMediaAsset, generateTimelineId, getItemsByTrackType } from './timeline/utils';
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
  const shape = options.shape ?? layout.shape;
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
    muted: options.muted ?? true,
    pip: { shape, borderWidth: options.borderWidth ?? 4, borderColor: '#FFFFFF', shadow: true, isPip: true },
  };
  return addItem(next, item);
}

export function isPipItem(item: { type: string; pip?: PipSettings }): boolean {
  return item.type === 'video' && !!item.pip?.isPip;
}
