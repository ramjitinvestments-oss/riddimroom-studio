/**
 * RiddimRoom Studio — editor-facing timeline insertion helpers.
 *
 * Sits on top of `utils.ts`'s pure construction/query functions (never
 * duplicates them) to answer the editor UI's actual question: "the user
 * just uploaded/captured this MediaAsset (or wants to add text/a
 * watermark) — what TimelineItem(s) and Track placement does that become?"
 * Keeping this decision in one shared module, rather than inline in each
 * panel component, is what the "do not introduce a parallel/ad-hoc data
 * model" requirement is actually protecting against — every panel calls
 * the same functions instead of each inventing its own item defaults.
 */

import type {
  AudioTimelineItem,
  CaptionTimelineItem,
  CaptionWordTiming,
  ImageTimelineItem,
  MediaAsset,
  Project,
  TextTimelineItem,
  TimelineItem,
  Track,
  TrackType,
  VideoTimelineItem,
} from '../../types/timeline';
import { addItem, addMediaAsset, generateTimelineId, getItemsForTrack, getTracksByType, updateItem } from './utils';
import { resolveProjectCaptionOverlaps } from '../captions/timing';
import { MAX_MEDIA_SECONDS } from '../media/constants';
import { addPipOverlay } from '../pip';
import { dualAlignmentTrims } from '../camera/dualCapture';

const DEFAULT_IMAGE_DURATION_SECONDS = 5;

/**
 * Safe fallback for a probed media duration: `?? fallback` alone does NOT
 * catch `NaN` (nullish coalescing only substitutes for `null`/`undefined`,
 * and `NaN` is a legitimate `number`) — a real bug found during the
 * full-app audit (fixed at its source in `lib/media/probe.ts`, which was
 * reading `video.duration`/`audio.duration` after the probing element had
 * already been reset) let a `NaN` `durationSeconds` slip past every
 * `?? 5` in this file, producing a `NaN` item `endTime` that corrupted the
 * whole project's computed duration. This helper is the second, defensive
 * layer — even if some future probing path (or a genuinely malformed
 * asset record) produces `NaN` again, an item's placement on the timeline
 * can no longer inherit it.
 */
function safeDuration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * "Universal 30-second media standard" — resolves the actual `[trimStart,
 * trimEnd)` source window a new video/audio item should use. When the
 * caller (the pre-import trim/select modal, or a camera-capture clamp)
 * supplied an explicit window via `AppendMediaOptions.trimStart`/`trimEnd`,
 * that's honored (clamped to the asset's real bounds). Otherwise this
 * behaves exactly as before — the item spans the asset's whole probed
 * duration — except the result is now ALSO defensively capped at
 * `MAX_MEDIA_SECONDS`: nothing upstream should ever hand this an
 * over-length asset with no trim window, but if it does, the item placed on
 * the timeline still can't exceed the product's hard limit.
 */
function resolveTrimWindow(
  fullDuration: number,
  options: Pick<AppendMediaOptions, 'trimStart' | 'trimEnd'>,
): { trimStart: number; trimEnd: number; duration: number } {
  const trimStart = options.trimStart !== undefined ? Math.max(0, Math.min(options.trimStart, fullDuration)) : 0;
  const rawTrimEnd = options.trimEnd !== undefined ? Math.max(trimStart + 0.1, Math.min(options.trimEnd, fullDuration)) : fullDuration;
  const duration = Math.min(rawTrimEnd - trimStart, MAX_MEDIA_SECONDS);
  return { trimStart, trimEnd: trimStart + duration, duration };
}

function nextZIndex(project: Project): number {
  return project.items.reduce((max, item) => Math.max(max, item.zIndex), -1) + 1;
}

function firstTrackOfType(project: Project, type: TrackType): Track {
  const tracks = getTracksByType(project, type);
  if (tracks.length === 0) {
    throw new Error(`This project has no "${type}" track. Every new project is created with one of each track type — this should not happen.`);
  }
  return tracks[0];
}

/** Where a new item on `trackId` should start: right after the last item currently on that track (sequential placement). */
function nextStartTime(project: Project, trackId: string, preferredStart?: number): number {
  const existing = getItemsForTrack(project, trackId);
  const earliestFree = existing.reduce((max, item) => Math.max(max, item.endTime), 0);
  if (preferredStart === undefined) return earliestFree;
  return Math.max(preferredStart, 0);
}

export interface AppendMediaOptions {
  /** Timeline position to insert at; defaults to right after the last item on the target track. */
  atTime?: number;
  /** For image assets only — how long the image stays on screen. Defaults to 5s. */
  imageDurationSeconds?: number;
  /**
   * For image assets only — initial placement (percent coordinates +
   * scale, the Transform fields' own units). Defaults to the centered,
   * full-frame placement every image has always gotten; the "Add
   * Overlay" upload action passes a corner position + small scale so a
   * fresh overlay reads as an overlay, not a replacement picture.
   */
  position?: { x: number; y: number };
  scale?: number;
  role?: ImageTimelineItem['role'] | AudioTimelineItem['role'];
  /**
   * Video/audio only — "universal 30-second media standard". Restricts the
   * placed item to this source-time window instead of the asset's full
   * duration: either the window the user picked in the pre-import
   * trim/select modal (an upload longer than `MAX_MEDIA_SECONDS`), or the
   * point a camera recording was auto-stopped/clamped at. When omitted, the
   * item uses the asset's whole probed duration exactly as before (still
   * capped defensively at `MAX_MEDIA_SECONDS`, see below).
   */
  trimStart?: number;
  trimEnd?: number;
}

/**
 * Registers `asset` in the project's media pool and places a matching
 * TimelineItem on the one track type that asset kind belongs on
 * (`video`->video track, `image`->image track, `audio`->audio track),
 * per `ITEM_TYPE_TO_TRACK_TYPE`. Returns a new Project; does not mutate.
 */
export function appendMediaToTimeline(project: Project, asset: MediaAsset, options: AppendMediaOptions = {}): Project {
  let next = addMediaAsset(project, asset);
  const zIndex = nextZIndex(next);

  if (asset.kind === 'video') {
    const track = firstTrackOfType(next, 'video');
    const startTime = nextStartTime(next, track.id, options.atTime);
    const fullDuration = safeDuration(asset.durationSeconds, 5);
    const { trimStart, trimEnd, duration } = resolveTrimWindow(fullDuration, options);
    const item: VideoTimelineItem = {
      id: generateTimelineId('item'),
      type: 'video',
      trackId: track.id,
      startTime,
      endTime: startTime + duration,
      zIndex,
      visible: true,
      mediaAssetId: asset.id,
      position: { x: 50, y: 50 },
      scale: 1,
      rotation: 0,
      opacity: 1,
      trimStart,
      trimEnd,
      speed: 1,
      reverse: false,
      volume: 1,
      muted: false,
    };
    return normalizeVisualZOrder(addItem(next, item));
  }

  if (asset.kind === 'image') {
    const track = firstTrackOfType(next, 'image');
    const startTime = nextStartTime(next, track.id, options.atTime);
    const duration = options.imageDurationSeconds ?? DEFAULT_IMAGE_DURATION_SECONDS;
    const item: ImageTimelineItem = {
      id: generateTimelineId('item'),
      type: 'image',
      trackId: track.id,
      startTime,
      endTime: startTime + duration,
      zIndex,
      visible: true,
      mediaAssetId: asset.id,
      role: (options.role as ImageTimelineItem['role']) ?? 'photo',
      position: options.position ?? { x: 50, y: 50 },
      scale: options.scale ?? 1,
      rotation: 0,
      opacity: 1,
    };
    return normalizeVisualZOrder(addItem(next, item));
  }

  // audio
  const track = firstTrackOfType(next, 'audio');
  const startTime = nextStartTime(next, track.id, options.atTime);
  const fullDuration = safeDuration(asset.durationSeconds, 5);
  const { trimStart, trimEnd, duration } = resolveTrimWindow(fullDuration, options);
  const item: AudioTimelineItem = {
    id: generateTimelineId('item'),
    type: 'audio',
    trackId: track.id,
    startTime,
    endTime: startTime + duration,
    zIndex,
    visible: true,
    mediaAssetId: asset.id,
    role: (options.role as AudioTimelineItem['role']) ?? 'original',
    volume: 1,
    muted: false,
    trimStart,
    trimEnd,
    fade: { fadeInDuration: 0, fadeOutDuration: 0 },
  };
  return addItem(next, item);
}

/**
 * Layer classes for the stacking contract the compositor assumes but
 * insertion order used to violate: main content (0) < PiP overlays (1) <
 * graphic overlays — watermarks, logos, stickers (2) < text (3) <
 * captions (4). Every insert used to take `max zIndex + 1`, so deleting
 * the main clip and re-adding it put the new main clip ON TOP of the
 * logo and text overlays — and since the compositor draws strictly by
 * zIndex, the opaque full-frame video silently buried them in preview
 * and export (the 2026-10-23 "swap the main clip, lose the overlays"
 * defect). After a main-content append, visual items are re-layered by
 * class (stable within a class by their previous zIndex), which also
 * self-heals projects already carrying the bad order. The user's own
 * bring-forward/send-backward adjustments still work afterwards — this
 * runs only at append time.
 */
function visualClassRank(item: TimelineItem): number {
  switch (item.type) {
    case 'video':
      return item.pip?.isPip ? 1 : 0;
    case 'image':
      return item.role === 'photo' || item.role === 'graphic' ? 0 : 2;
    case 'text':
      return 3;
    case 'caption':
      return 4;
    default:
      return -1; // audio — not visual, left alone
  }
}

export function normalizeVisualZOrder(project: Project): Project {
  const visual = project.items
    .filter((i) => visualClassRank(i) >= 0)
    .sort((a, b) => visualClassRank(a) - visualClassRank(b) || a.zIndex - b.zIndex || a.startTime - b.startTime);
  let next = project;
  visual.forEach((item, idx) => {
    if (item.zIndex !== idx) next = updateItem(next, item.id, { zIndex: idx });
  });
  return next;
}

export interface AddTextOptions {
  text: string;
  atTime: number;
  durationSeconds?: number;
  role?: TextTimelineItem['role'];
  fontSize?: number;
  color?: string;
  position?: { x: number; y: number };
  /** Font family name (a premium face from lib/fonts, or a system stack). */
  font?: string;
}

/** Adds a new `text` timeline item on the project's text track (Step 9). */
export function addTextItem(project: Project, options: AddTextOptions): Project {
  const track = firstTrackOfType(project, 'text');
  const duration = options.durationSeconds ?? 3;
  const item: TextTimelineItem = {
    id: generateTimelineId('item'),
    type: 'text',
    trackId: track.id,
    startTime: options.atTime,
    endTime: options.atTime + duration,
    zIndex: nextZIndex(project),
    visible: true,
    text: options.text,
    role: options.role ?? 'overlay',
    font: options.font ?? 'Arial',
    fontSize: options.fontSize ?? 48,
    color: options.color ?? '#ffffff',
    position: options.position ?? { x: 50, y: 20 },
    scale: 1,
    rotation: 0,
    opacity: 1,
  };
  return addItem(project, item);
}

export interface AddWatermarkOptions {
  asset: MediaAsset;
  atTime: number;
  durationSeconds: number;
  position?: { x: number; y: number };
  scale?: number;
  opacity?: number;
}

/** Adds a watermark: an `image` timeline item with role "watermark" on the project's image track (Step 8). */
export function addWatermarkItem(project: Project, options: AddWatermarkOptions): Project {
  let next = addMediaAsset(project, options.asset);
  const track = firstTrackOfType(next, 'image');
  const item: ImageTimelineItem = {
    id: generateTimelineId('item'),
    type: 'image',
    trackId: track.id,
    startTime: options.atTime,
    endTime: options.atTime + options.durationSeconds,
    zIndex: nextZIndex(next),
    visible: true,
    mediaAssetId: options.asset.id,
    role: 'watermark',
    position: options.position ?? { x: 88, y: 92 },
    scale: options.scale ?? 0.4,
    rotation: 0,
    opacity: options.opacity ?? 0.85,
  };
  return addItem(next, item);
}

export interface AddCaptionsOptions {
  /** Word-level timings already relative to `atTime` (i.e. relative to the resulting item's own startTime). */
  words: CaptionWordTiming[];
  atTime: number;
  captionStyleId: string;
  source: CaptionTimelineItem['source'];
  /** Splits `words` into multiple caption cues no longer than this many seconds each. Defaults to 4s (short, readable cues). */
  maxCueDurationSeconds?: number;
}

/**
 * Adds one or more `caption` timeline items from AI/manual word timings
 * (Step 11), chunking long transcripts into readable cues rather than one
 * giant caption item spanning the whole video.
 */
export function addCaptionItems(project: Project, options: AddCaptionsOptions): Project {
  const track = firstTrackOfType(project, 'caption');
  const maxCue = options.maxCueDurationSeconds ?? 4;
  const cues: CaptionWordTiming[][] = [];
  let current: CaptionWordTiming[] = [];
  let cueStart = 0;

  for (const word of options.words) {
    if (current.length === 0) cueStart = word.start;
    if (word.end - cueStart > maxCue && current.length > 0) {
      cues.push(current);
      current = [];
      cueStart = word.start;
    }
    current.push(word);
  }
  if (current.length > 0) cues.push(current);

  let next = project;
  for (const cueWords of cues) {
    const cueOffset = cueWords[0].start;
    const cueEnd = cueWords[cueWords.length - 1].end;
    const relativeWords: CaptionWordTiming[] = cueWords.map((w) => ({
      text: w.text,
      start: w.start - cueOffset,
      end: w.end - cueOffset,
    }));
    const item: CaptionTimelineItem = {
      id: generateTimelineId('item'),
      type: 'caption',
      trackId: track.id,
      startTime: options.atTime + cueOffset,
      endTime: options.atTime + cueEnd,
      zIndex: nextZIndex(next),
      visible: true,
      words: relativeWords,
      captionStyleId: options.captionStyleId,
      source: options.source,
      editable: true,
    };
    next = addItem(next, item);
  }
  // R20: captions never overlay — clamp the merged cue set.
  return resolveProjectCaptionOverlaps(next).project;
}

export interface AddManualCaptionCueOptions {
  /** The cue's text — stored as a single word timing spanning the whole cue; the caption inspector's word editor refines it from there. */
  text: string;
  /** Timeline position (seconds) for the cue's start — typically the playhead. Clamped to >= 0. */
  atTime: number;
  /** Defaults to 2s — long enough to read a short line, short enough not to swallow a neighbouring cue. Minimum 0.5s. */
  durationSeconds?: number;
  /** Defaults to the style of the project's most recent caption cue, else 'classic' — a hand-added cue matches the captions already on screen instead of resetting the look. */
  captionStyleId?: string;
}

/**
 * Adds ONE hand-typed caption cue (`source: 'manual'`) at `atTime`
 * (five-star surface audit, pre-live build 4). Before this helper, cues
 * could only come from AI transcription or subtitle import — a user who
 * wanted one line of their own (a hook, a name, a patois line spelled
 * their way) had no way to create it, even though every existing cue was
 * fully editable. This is the creation path that editing promise needs:
 * same item shape `addCaptionItems` writes, one word spanning the cue,
 * refined afterwards in the CaptionInspector like any other cue.
 */
export function addManualCaptionCue(project: Project, options: AddManualCaptionCueOptions): Project {
  const track = firstTrackOfType(project, 'caption');
  const startTime = Math.max(0, options.atTime);
  const duration = Math.max(0.5, options.durationSeconds ?? 2);
  const lastCue = project.items
    .filter((i): i is CaptionTimelineItem => i.type === 'caption')
    .reduce<CaptionTimelineItem | null>((latest, i) => (!latest || i.endTime > latest.endTime ? i : latest), null);
  const item: CaptionTimelineItem = {
    id: generateTimelineId('item'),
    type: 'caption',
    trackId: track.id,
    startTime,
    endTime: startTime + duration,
    zIndex: nextZIndex(project),
    visible: true,
    words: [{ text: options.text, start: 0, end: duration }],
    captionStyleId: options.captionStyleId ?? lastCue?.captionStyleId ?? 'classic',
    source: 'manual',
    editable: true,
  };
  return addItem(project, item);
}

export interface AppendDualCaptureOptions {
  /** Measured start delta between the two recorders (front start − rear start), from the dual-capture probe recording. */
  startDeltaMs: number;
  /** Timeline position for the main clip; defaults to right after the last video item, like appendMediaToTimeline. */
  atTime?: number;
}

/**
 * R29 — place a dual-capture pair on the timeline in one call: one tap
 * in the camera review ("Add both") becomes the rear clip as the main
 * video PLUS its own front-camera clip as a PiP overlay at the SAME
 * timeline start, with the two files' heads aligned by the measured
 * recorder start delta (`dualAlignmentTrims` — the earlier-started
 * file's extra head is trimmed, the later one keeps its head). The
 * overlay is placed via `addPipOverlay` with `fromCamera: true`, so it
 * gets the R24 camera framing defaults (rounded, source-aspect) and
 * starts audible (`muted: false` — the front clip is a view of the
 * same moment, and its audio state stays user-changeable like any
 * PiP's). If the main clip somehow isn't placed, the project is
 * returned with just that step done rather than an orphan overlay.
 */
export function appendDualCaptureToTimeline(
  project: Project,
  mainAsset: MediaAsset,
  overlayAsset: MediaAsset,
  options: AppendDualCaptureOptions,
): Project {
  const { rearTrimStartSeconds, frontTrimStartSeconds } = dualAlignmentTrims(options.startDeltaMs);
  const existingIds = new Set(project.items.map((i) => i.id));
  const next = appendMediaToTimeline(project, mainAsset, {
    atTime: options.atTime,
    trimStart: rearTrimStartSeconds > 0 ? rearTrimStartSeconds : undefined,
  });
  const mainItem = next.items.find(
    (i): i is VideoTimelineItem => !existingIds.has(i.id) && i.type === 'video',
  );
  if (!mainItem) return next;
  return addPipOverlay(next, overlayAsset, {
    layoutId: 'bottom-right',
    atTime: mainItem.startTime,
    trimStart: frontTrimStartSeconds > 0 ? frontTrimStartSeconds : undefined,
    fromCamera: true,
    muted: false,
  });
}
