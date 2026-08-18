/**
 * RiddimRoom Studio — multi-track timeline data model.
 *
 * Source of this architecture: approved in `riddimroom-studio-phase1-plan.md`
 * follow-up discussion (multi-track timeline requirement). This is the
 * foundation only — types, Firestore-shaped structure, serialization, and
 * validation. No editor UI and no rendering engine are implemented here.
 *
 * Design principle (per approval): every overlay — video, image, text,
 * caption, or audio — is an independent `TimelineItem` sitting on a `Track`,
 * with its own timing and stacking order. None of them are ever represented
 * as a property bag hung off a "main clip" the way BoltVideoApp's
 * `BrandingSettings` (global watermark) currently works. See
 * `riddimroom-studio-timeline-architecture-proposal.md` for the full
 * research this is based on (BoltVideoApp, EventCam, Caption).
 *
 * Source-of-feature notes (per project rule — every ported concept must
 * document its origin):
 * - `Track` + item `trackId`/`zIndex`: extends the `track: number` field
 *   already proven on BoltVideoApp's `TextOverlay`/`CaptionTrack`, promoted
 *   here to a first-class concept covering every media type, not just text.
 * - `CaptionTimelineItem.words` shape: BoltVideoApp's `WordTiming` (itself
 *   sourced from riddimroom-caption's `WordCaption`), reused as-is.
 * - `CaptionStyleId`/animation vocabulary: riddimroom-caption's
 *   `CaptionStyle`/`AnimationStyle` (17 styles), referenced by id rather
 *   than embedded, so a style can be shared across many caption items.
 * - `ImageTimelineItem` position/opacity/size shape: EventCam's
 *   `WatermarkSettings`/`TextOverlaySettings` percentage-based positioning,
 *   generalized so a watermark is just an ordinary `ImageTimelineItem` on a
 *   track named "Watermark" — never a special-cased global setting.
 * - `VideoTimelineItem` trim/speed/crop/colorGrade fields: BoltVideoApp's
 *   `VideoClipSettings`, moved from "attached to a clip" to "fields on an
 *   independent timeline item".
 */

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------

/** The five track types required by the approved architecture. */
export type TrackType = 'video' | 'image' | 'text' | 'caption' | 'audio';

export interface Track {
  id: string;
  type: TrackType;
  /** Display name, e.g. "Main Video", "Watermark", "Voiceover". User-editable. */
  name: string;
  /**
   * Vertical position among tracks of visualizable types, lowest drawn
   * first. This is a *default* stacking hint per track; the authoritative
   * per-item stacking order is each item's own `zIndex`, so items can be
   * reordered without renumbering tracks. Not meaningful for `audio` tracks
   * (audio has no visual stacking), but still used for UI row ordering.
   */
  order: number;
  /** Hidden tracks are skipped entirely at render/export time. */
  visible: boolean;
  /** Locked tracks reject edits in the future editor UI (not enforced by this module). */
  locked: boolean;
  /** Audio-only: track-level mute, independent of any individual item's mute/volume. */
  muted?: boolean;
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

export interface Position2D {
  /** Percentage of canvas width, 0-100. Not pixels, so it survives resolution changes. */
  x: number;
  /** Percentage of canvas height, 0-100. */
  y: number;
}

/** Shared visual placement fields for anything drawn on screen (video/image/text/caption). */
export interface Transform {
  position: Position2D;
  /** 1 = natural size. */
  scale: number;
  /** Degrees, clockwise. */
  rotation: number;
  /** 0 = fully transparent, 1 = fully opaque. */
  opacity: number;
}

export interface FadeSettings {
  /** Seconds. 0 = no fade. */
  fadeInDuration: number;
  /** Seconds. 0 = no fade. */
  fadeOutDuration: number;
}

/**
 * Named animation presets. Union of BoltVideoApp's `TextOverlay.animation`
 * values and riddimroom-caption's `AnimationStyle` values, so nothing from
 * either proven source is lost. The future render engine maps these to
 * actual per-frame transforms (e.g. BoltVideoApp's transition/animation
 * library) — this module only records *which* animation is selected.
 */
export type AnimationPreset =
  | 'none' | 'fade' | 'slide-up' | 'slide-down' | 'slide-left' | 'slide-right'
  | 'typewriter' | 'pop' | 'bounce' | 'word-by-word' | 'karaoke' | 'zoom'
  | 'shake' | 'fadeup' | 'smoke' | 'glitch' | 'skew' | 'elastic' | 'flip'
  | 'fire' | 'spin' | 'slideSplit' | 'rainbow' | 'heartbeat';

export interface AnimationSettings {
  entrance?: AnimationPreset;
  exit?: AnimationPreset;
}

export interface TrimSettings {
  /** Seconds into the source media where playback of this item begins. */
  trimStart: number;
  /** Seconds into the source media where playback of this item ends. */
  trimEnd: number;
}

export interface CropSettings {
  /** All four fields are percentages (0-100) of the source media's own dimensions. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ColorGradeSettings {
  /** -100 to 100, 0 = unchanged. Matches BoltVideoApp's VideoClipSettings scale. */
  brightness: number;
  contrast: number;
  saturation: number;
}

// ---------------------------------------------------------------------------
// Media assets — the shared pool every timeline item references by id
// ---------------------------------------------------------------------------

export type MediaAssetKind = 'video' | 'image' | 'audio';

export interface MediaAsset {
  id: string;
  kind: MediaAssetKind;
  /** Storage location (e.g. Firebase Storage path or URL) — populated once Step 5 (Upload) exists. */
  storageUrl: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  /** Seconds. Present for video/audio; absent for image. */
  durationSeconds?: number;
  /** Pixels. Present for video/image; absent for audio. */
  width?: number;
  height?: number;
  createdAt: number;
  /**
   * Background-removal pairing (image assets only) — "final production
   * fix" spec item 4's Original/Background-Removed toggle. Set on the
   * ORIGINAL asset once a processed counterpart exists, so re-toggling
   * doesn't reprocess the image every time. The processed asset points
   * back via `originalAssetId` so the toggle also works starting from
   * the removed-background version. Both are plain MediaAssets in the
   * same `mediaAssets` pool — this is just a same-pool cross-reference,
   * not a parallel asset system.
   */
  backgroundRemovedAssetId?: string;
  /** Set on a background-removed asset, pointing back to the original it was derived from. */
  originalAssetId?: string;
}

// ---------------------------------------------------------------------------
// Timeline items — one discriminated union, five concrete kinds
// ---------------------------------------------------------------------------

interface TimelineItemBase {
  id: string;
  /** Must reference an existing `Track.id` of the matching type — enforced by `validateProject`. */
  trackId: string;
  /** Seconds, absolute position on the master timeline. */
  startTime: number;
  /** Seconds, absolute position on the master timeline. Must be > startTime. */
  endTime: number;
  /**
   * Explicit stacking order among items that overlap in time, independent
   * of which track they're on — higher draws on top. Deliberately a
   * per-item field (not derived from track order) so authors can restack
   * without moving items between tracks. See `getItemDuration` for why
   * duration itself is a derived helper rather than a stored field.
   */
  zIndex: number;
  visible: boolean;
  locked?: boolean;
}

export interface VideoTimelineItem extends TimelineItemBase, Transform, TrimSettings {
  type: 'video';
  mediaAssetId: string;
  /** Playback speed multiplier. 1 = normal. */
  speed: number;
  reverse: boolean;
  /** This clip's own embedded audio volume (0-1), independent of any Audio track. */
  volume: number;
  muted: boolean;
  crop?: CropSettings;
  colorGrade?: ColorGradeSettings;
  fade?: FadeSettings;
  animation?: AnimationSettings;
}

export interface ImageTimelineItem extends TimelineItemBase, Transform {
  type: 'image';
  mediaAssetId: string;
  /**
   * Covers PNG/JPG overlays, logos, watermarks, graphics, stickers, and
   * promotional artwork alike — a watermark is just an ImageTimelineItem on
   * a track named "Watermark", never a special-cased global setting.
   */
  role: 'overlay' | 'watermark' | 'logo' | 'sticker' | 'photo' | 'graphic';
  motion?: {
    type: 'none' | 'ken-burns' | 'pan' | 'zoom' | 'parallax' | 'bounce';
    direction?: 'left' | 'right' | 'up' | 'down' | 'zoom-in' | 'zoom-out';
    strength?: number;
  };
  fade?: FadeSettings;
  animation?: AnimationSettings;
}

export interface TextTimelineItem extends TimelineItemBase, Transform {
  type: 'text';
  text: string;
  role: 'title' | 'lower-third' | 'overlay' | 'subtitle';
  font: string;
  fontSize: number;
  color: string;
  fade?: FadeSettings;
  animation?: AnimationSettings;
}

/** Word-level timing, relative to the item's own `startTime` (0 = synced to item start). */
export interface CaptionWordTiming {
  text: string;
  /** Seconds, relative to this CaptionTimelineItem's startTime. */
  start: number;
  /** Seconds, relative to this CaptionTimelineItem's startTime. */
  end: number;
}

export interface CaptionTimelineItem extends TimelineItemBase {
  type: 'caption';
  words: CaptionWordTiming[];
  /** References a named style (riddimroom-caption's CaptionStyle shape) rather than embedding one. */
  captionStyleId: string;
  source: 'ai' | 'manual';
  /**
   * Always true in this data model — captions remain editable structured
   * data (this type) all the way to final render/export, per the approved
   * architecture. Burned-in pixels are an export-time concern, not part of
   * the project document.
   */
  editable: true;
}

export interface AudioTimelineItem extends TimelineItemBase, TrimSettings {
  type: 'audio';
  mediaAssetId: string;
  role: 'original' | 'music' | 'voiceover' | 'sfx';
  /** 0-1. */
  volume: number;
  muted: boolean;
  fade: FadeSettings;
}

export type TimelineItem =
  | VideoTimelineItem
  | ImageTimelineItem
  | TextTimelineItem
  | CaptionTimelineItem
  | AudioTimelineItem;

/** Maps each TimelineItem's `type` to the one `TrackType` it's allowed to sit on. */
export const ITEM_TYPE_TO_TRACK_TYPE: Record<TimelineItem['type'], TrackType> = {
  video: 'video',
  image: 'image',
  text: 'text',
  caption: 'caption',
  audio: 'audio',
};

// ---------------------------------------------------------------------------
// Project — the Firestore-shaped document root
// ---------------------------------------------------------------------------

/**
 * Bumped whenever this shape changes in a way old documents can't be read
 * as-is, so `deserializeProject` can branch on it later. Starts at 1 since
 * this is the first version of the schema.
 */
export const TIMELINE_SCHEMA_VERSION = 1;

export interface Project {
  id: string;
  /** Firebase Auth uid of the owning user — matches Step 2's UserProfile.uid, not duplicated data. */
  ownerUid: string;
  name: string;
  schemaVersion: number;
  tracks: Track[];
  items: TimelineItem[];
  /** Shared pool of uploaded media, referenced by id from items — never embedded per-item. */
  mediaAssets: Record<string, MediaAsset>;
  /** Pixels. Matches BoltVideoApp's ExportSettings resolution concept, fixed per-project here. */
  canvasWidth: number;
  canvasHeight: number;
  frameRate: number;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
}
