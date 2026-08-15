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
  Track,
  TrackType,
  VideoTimelineItem,
} from '../../types/timeline';
import { addItem, addMediaAsset, generateTimelineId, getItemsForTrack, getTracksByType } from './utils';

const DEFAULT_IMAGE_DURATION_SECONDS = 5;

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
  role?: ImageTimelineItem['role'] | AudioTimelineItem['role'];
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
    const duration = asset.durationSeconds ?? 5;
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
      trimStart: 0,
      trimEnd: duration,
      speed: 1,
      reverse: false,
      volume: 1,
      muted: false,
    };
    return addItem(next, item);
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
      position: { x: 50, y: 50 },
      scale: 1,
      rotation: 0,
      opacity: 1,
    };
    return addItem(next, item);
  }

  // audio
  const track = firstTrackOfType(next, 'audio');
  const startTime = nextStartTime(next, track.id, options.atTime);
  const duration = asset.durationSeconds ?? 5;
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
    trimStart: 0,
    trimEnd: duration,
    fade: { fadeInDuration: 0, fadeOutDuration: 0 },
  };
  return addItem(next, item);
}

export interface AddTextOptions {
  text: string;
  atTime: number;
  durationSeconds?: number;
  role?: TextTimelineItem['role'];
  fontSize?: number;
  color?: string;
  position?: { x: number; y: number };
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
    font: 'Arial',
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
  return next;
}
