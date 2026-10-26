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
 * Phase 2.3 — keyframe-lite: the item's END transform. When present, the
 * compositor interpolates position/scale/opacity linearly across the
 * item's on-screen duration, from its base `Transform` to this end state
 * (`interpolateTransform` in `lib/render/compositor.ts`, shared by preview
 * and export). Rotation is deliberately not part of it — the base
 * rotation holds for the whole item. Absent = static transform, exactly
 * the pre-2.3 behavior.
 */
export interface EndTransformSettings {
  position: Position2D;
  /** 1 = natural size (same meaning as `Transform.scale`). */
  scale: number;
  /** 0-1. */
  opacity: number;
  /** True = smoothstep easing; false/absent = linear. */
  eased?: boolean;
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
  | 'fire' | 'spin' | 'slideSplit' | 'rainbow' | 'heartbeat'
  // "Final production fix" spec item 7 — added to reach the required
  // 25-30 premium transitions across 4 named categories (see
  // `lib/transitions.ts` for the category catalog); every one of these
  // (plus every preset above) has bespoke, distinct math in
  // `computeEntranceExit`, not a shared fallback.
  | 'dip-to-black' | 'dip-to-white' | 'light-leak' | 'film-dissolve'
  | 'lens-blur' | 'whip-pan' | 'snap-zoom' | 'flash'
  // Templates v3 — premium transition build-out. Every one has bespoke
  // math in `computeEntranceExit` (compositor.ts), rendered identically
  // by preview and export since both call the same `drawFrame`.
  | 'cross-zoom' | 'mask-reveal' | 'luma-fade' | 'film-burn'
  | 'dip-to-gold' | 'smooth-spin';

export interface AnimationSettings {
  entrance?: AnimationPreset;
  exit?: AnimationPreset;
  /**
   * "Final production fix" spec item 7 — transitions need "adjustable
   * intensity", not just an on/off preset choice. A multiplier applied to
   * every preset's displacement/scale/blur amounts in
   * `computeEntranceExit` (1 = the preset's normal look; e.g. 0.5 = a
   * subtler version of the same motion, 2 = a much more aggressive one).
   * Undefined behaves exactly like 1 (existing projects need no migration).
   */
  intensity?: number;
}

/**
 * "Final production fix" spec item 8 — motion/zoom effects (Ken Burns
 * family), a section explicitly distinct from `AnimationSettings`
 * (entrance/exit transitions, which only play briefly at an item's start/
 * end). A `MotionSettings` effect instead runs CONTINUOUSLY across an
 * item's entire on-screen duration — e.g. a slow pan+zoom the whole time a
 * photo is on screen — and can be active at the same time as an
 * entrance/exit transition (both apply to the same frame; see
 * `computeMotionAdjustment`/`combineAdjustments` in
 * `lib/render/compositor.ts`).
 */
export type MotionEffectType =
  | 'none'
  | 'ken-burns'
  | 'slow-zoom-in'
  | 'slow-zoom-out'
  | 'dynamic-zoom'
  | 'punch-zoom'
  | 'product-focus'
  | 'parallax'
  | 'subtle-shake'
  | 'spotlight'
  | 'vignette'
  | 'flash'
  | 'light-sweep'
  | 'word-tour'
  | 'dolly-push'
  | 'orbit-drift'
  | 'focus-pull';

/** Used only by the directional effects (ken-burns, parallax); ignored by the rest. */
export type MotionDirection = 'left' | 'right' | 'up' | 'down' | 'zoom-in' | 'zoom-out';

/** One stop of a word-tour camera move (see `MotionSettings.tourStops`). */
export interface MotionTourStop {
  /** Position along the item's own duration, 0..1. */
  t: number;
  /** Camera offset as a fraction of canvas width (x) / height (y). */
  x: number;
  y: number;
  /** Zoom multiplier at this stop. */
  scale: number;
}

export interface MotionSettings {
  type: MotionEffectType;
  direction?: MotionDirection;
  /**
   * Word-tour stops (R12): a camera path baked from the artwork's own
   * OCR word boxes — the view travels to the words that matter. Only
   * meaningful when `type` is 'word-tour'; offsets are canvas
   * fractions so the same project tours identically at any render
   * size. Built by `lib/promo/camera.ts`; not a user-pickable effect.
   */
  tourStops?: MotionTourStop[];
  /**
   * R22 Homecoming: when true, a continuous move (ken-burns, slow
   * zooms, product-focus, dolly-push) blends back to the home
   * framing — identity adjustment, the full artwork uncropped —
   * across its final 20%, instead of ending mid-move. Promo
   * builders set this on hero motions (see applyHomecoming).
   */
  homecoming?: boolean;
  /**
   * 0.5-2, multiplies the effect's displacement/scale/overlay amount (same
   * range and meaning as `AnimationSettings.intensity`). Undefined behaves
   * exactly like 1.
   */
  intensity?: number;
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

export type PipShape = 'circle' | 'rounded' | 'square';

export interface PipSettings {
  /** PiP shape. 'circle' = talking-head bubble, 'rounded' = rounded rect, 'square' = plain rect. */
  shape: PipShape;
  /** Border width in px (canvas space). 0 = no border. */
  borderWidth: number;
  borderColor: string;
  /** Soft drop shadow. */
  shadow: boolean;
  /** True when this video item is a PiP overlay (drawn on top of the main video). */
  isPip: boolean;
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
  /** PiP overlay settings. Absent = normal full-frame video. */
  pip?: PipSettings;
  animation?: AnimationSettings;
  /** "Final production fix" spec item 8 — see `MotionSettings`'s doc comment. Video's own motion (e.g. a subtle Ken Burns treatment layered on top of the clip's normal playback). */
  motion?: MotionSettings;
  /** Phase 2.3 — keyframe-lite end transform; see `EndTransformSettings`. */
  endTransform?: EndTransformSettings;
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
  /**
   * Templates v3 — same `ColorGradeSettings` shape video items have
   * always carried (see `VideoTimelineItem.colorGrade`); templates apply
   * named grades to slotted photos as well as clips. Consumed by the
   * shared compositor (`colorGradeToFilter` in `lib/grades.ts`) in both
   * preview and export. Absent = ungraded, exactly the pre-v3 behavior.
   */
  colorGrade?: ColorGradeSettings;
  /**
   * Source crop window (percentages of the source's own dimensions —
   * same `CropSettings` shape video items carry). Consumed by the shared
   * compositor in preview + export: only the window is drawn, and the
   * item's box follows the window's aspect. Written by preset applies
   * (frame crops) and the reframe picker. Absent = the whole image.
   */
  crop?: CropSettings;
  motion?: MotionSettings;
  fade?: FadeSettings;
  animation?: AnimationSettings;
  /** Phase 2.3 — keyframe-lite end transform; see `EndTransformSettings`. */
  endTransform?: EndTransformSettings;
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
  /** R19 size system: multiplier over the style's authored size
      (S 0.8 / M 1 / L 1.25 / XL 1.55). Absent = M. The rendered px
      also scale with canvas width, so a cue looks the same at any
      render size. */
  sizeScale?: number;
  /** R19 placement zone. Absent = 'bottom' (the safe-area anchor). */
  anchorY?: 'bottom' | 'middle' | 'top';
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
  /**
   * Tweaks round — "Loop to fill project" (see `loopAudioToProjectEnd` in
   * `lib/timeline/utils.ts`). When true, the item's timeline span may be
   * LONGER than its trim window: both render paths (PreviewPane,
   * canvas2dRenderer) wrap the source position inside
   * `[trimStart, trimEnd)` via `computeLoopedSourceTime` instead of
   * playing the source once and falling silent. Absent/false = the
   * pre-existing play-once behavior, so old projects need no migration.
   */
  loop?: boolean;
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
  /**
   * v1 licensing: when true, the compositor draws a small "RiddimRoom Studio"
   * watermark (free tier). Paid lifetime projects set this false.
   * Defaults to true for backwards compat with pre-v1 projects (which have no field).
   */
  watermarkEnabled?: boolean;
  /**
   * Dashboard poster (polish batch 2): a small JPEG data URL generated at
   * save time from the project's first video/image asset (see
   * `lib/media/thumbnails.ts`), rendered as the project card's cover on
   * the dashboard. Purely cosmetic — absent on projects saved before this
   * existed, projects with no visual media, or whenever the media couldn't
   * be decoded CORS-clean.
   */
  posterDataUrl?: string;
}
