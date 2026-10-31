import React, { useState } from 'react';
import { FONT_OPTIONS } from '../../lib/fonts';
import { ArrowLeft, ArrowLeftToLine, ArrowRight, ArrowRightToLine, Check, Crop, Frame, X } from 'lucide-react';
import { SlotTrimPicker } from './SlotTrimPicker';
import { ReframePicker } from './ReframePicker';
import { hasCroppableSlack, resolveSourceDuration } from '../../lib/timeline/trimWindow';
import type { AnimationPreset, AudioTimelineItem, CaptionTimelineItem, MotionDirection, MotionEffectType, MotionSettings, PipSettings, PipShape, TimelineItem } from '../../types/timeline';
import { pipShapeRefitZoom } from '../../lib/pip';
import { PipRingControls, PipShapeStrip } from './PipShapeControls';
import { useProject } from '../../context/ProjectContext';
import {
  updateItem,
  removeItem,
  getItemDuration,
  trimItemStart,
  setItemDuration,
  canCrossDissolve,
  crossDissolveAlreadyApplied,
  applyCrossDissolve,
  canApplyTransition,
  transitionAlreadyApplied,
  applyTransition,
  updateItemMotion,
  setItemSpeed,
  SPEED_MIN,
  SPEED_MAX,
  addCaptionWord,
  formatTimecode,
  isVisualItem,
  bringForward,
  sendBackward,
  bringToFront,
  sendToBack,
} from '../../lib/timeline/utils';
import { CAPTION_STYLES } from '../../lib/captions/styles';
import { isPipItem } from '../../lib/pip';
import { findHeldMainVisualItem } from '../../lib/render/compositor';
import { hasDifferingSharedUse, SHARED_CLIP_NOTE } from '../../lib/sharedClip';
import {
  TRANSITION_CATEGORIES,
  TRANSITION_INTENSITY_DEFAULT,
  TRANSITION_INTENSITY_MAX,
  TRANSITION_INTENSITY_MIN,
  findTransitionPreset,
  transitionPresetsByCategory,
} from '../../lib/transitions';
import { MOTION_DIRECTIONS, MOTION_EFFECTS, MOTION_INTENSITY_DEFAULT, MOTION_INTENSITY_MAX, MOTION_INTENSITY_MIN, findMotionEffect } from '../../lib/motionEffects';
import { MAX_FADE_SECONDS, MAX_MEDIA_SECONDS } from '../../lib/media/constants';

const CROSS_DISSOLVE_DURATION_SECONDS = 0.6;

/**
 * Generic property inspector for the currently-selected timeline item.
 * Fields shown depend on the item's `type` (position/size/opacity for
 * anything visual, text content/font/color for `text`, timing for
 * everything) — all edits go through `useProject().mutate` +
 * `updateItem`/the trim/duration helpers, i.e. through the Project/Timeline
 * model, never local component state that would need reconciling with it
 * later.
 *
 * Start/Duration route through `trimItemStart`/`setItemDuration` (not a raw
 * `updateItem({startTime/endTime})` patch) specifically because a video/
 * audio item also carries a `trimStart`/`trimEnd` source-playback window
 * that must move in lockstep with the timeline slot — see those functions'
 * doc comments in `lib/timeline/utils.ts` for the bug this replaced
 * ("shortening" a clip used to change its timeline slot but not which part
 * of the source video actually played).
 */

// "Final production fix" spec item 7 — the full categorized Clean/Modern/
// Cinematic/Marketing preset catalog now lives in lib/transitions.ts and is
// rendered as <optgroup>s directly below; this file only keeps the small
// text-exclusive kinetic-reveal list (a different mechanism — see
// transitions.ts's own header comment on why they're not in that catalog).
const TEXT_ONLY_ANIMATION_OPTIONS: { value: AnimationPreset; label: string }[] = [
  { value: 'typewriter', label: 'Typewriter' },
  { value: 'word-by-word', label: 'Word by word' },
];

// React.memo (polish batch 2): the only prop is the selected item object,
// whose identity is stable across EditorShell re-renders that don't touch
// the project (playback time commits, step/sheet changes) — memo keeps
// those from re-rendering this large form. Real edits flow through
// useProject() context + a new item identity, both of which still
// re-render it as before.
export const ItemInspector = React.memo(function ItemInspector({ item }: { item: TimelineItem }) {
  const { mutate, project } = useProject();

  const patch = (fields: Record<string, unknown>) => {
    mutate((project) => updateItem(project, item.id, fields));
  };

  const patchPosition = (axis: 'x' | 'y', value: number) => {
    if (!('position' in item)) return;
    patch({ position: { ...(item as any).position, [axis]: value } });
  };

  const handleDelete = () => {
    mutate((project) => removeItem(project, item.id));
    // R27 WS-M6 — surface the undo toast at the moment of loss
    // (EditorShell listens for 'rr:undo-toast' and offers one-tap Undo).
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('rr:undo-toast', { detail: { message: 'Item deleted' } }));
    }
  };

  const duration = getItemDuration(item);
  const hasAnimation = item.type === 'video' || item.type === 'image' || item.type === 'text';
  const animation = hasAnimation ? (item as any).animation as { entrance?: AnimationPreset; exit?: AnimationPreset; intensity?: number } | undefined : undefined;
  const fade = hasAnimation ? (item as any).fade as { fadeInDuration: number; fadeOutDuration: number } | undefined : undefined;

  // "Final production fix" spec item 8 — Motion/Zoom Effects (Ken Burns
  // family), image/video only (Position/Scale/Rotation above already covers
  // text, and motion effects are a photo/video-camera-movement concept).
  // Deliberately a separate "Effects" section from "Transition" above:
  // motion runs continuously across the item's whole on-screen duration,
  // transitions only play briefly at entrance/exit — see
  // `computeMotionAdjustment`'s doc comment in `lib/render/compositor.ts`.
  const hasMotion = item.type === 'video' || item.type === 'image';
  const motion = hasMotion ? ((item as any).motion as MotionSettings | undefined) : undefined;
  const motionEffectInfo = findMotionEffect(motion?.type);
  // Writes through the shared `updateItemMotion` util (Phase 2.1) — the
  // exact `{ type: 'none', ...current, ...fields }` merge this closure
  // used to do inline, now shared with the first-class Effects panel so
  // both write the one `motion` field identically.
  const patchMotion = (fields: Partial<MotionSettings>) => {
    mutate((p) => updateItemMotion(p, item.id, fields));
  };

  // Cross Dissolve — only offered when there's an actual adjacent same-
  // track item to dissolve into/from (see `findAdjacentNextItem`'s doc
  // comment); this is what keeps the control from ever being a cosmetic
  // button with nothing real to do.
  // R36 hold-last-frame: this item will hold (its last frame / the
  // picture stays up for the project's tail) exactly when the shared
  // compositor's finder names it the holder at its own end — one
  // source of truth, so the note never appears for an item that
  // won't actually hold.
  const willHold =
    !!project &&
    (item.type === 'video' || item.type === 'image') &&
    findHeldMainVisualItem(project, item.endTime)?.id === item.id;

  const dissolveAvailable = hasAnimation && !!project && canCrossDissolve(project, item.id);
  const dissolveApplied = dissolveAvailable && !!project && crossDissolveAlreadyApplied(project, item.id, CROSS_DISSOLVE_DURATION_SECONDS);

  // "Final production fix" spec item 7's "real overlap-based transitions"
  // (push/wipe/slide-between-clips, not just a plain dissolve) — same
  // adjacency gate as Cross Dissolve above, but lets the user pick ANY
  // preset from the full categorized catalog rather than always a plain
  // fade. `transitionPresetForBoundary` is local UI state (which preset is
  // currently selected in the picker for THIS boundary), not project
  // state — applying it is the actual project mutation.
  const transitionAvailable = hasAnimation && !!project && canApplyTransition(project, item.id);
  const [transitionPresetForBoundary, setTransitionPresetForBoundary] = useState<AnimationPreset>('fade');
  // Templates v3 — crop picker (choose which part of the source a
  // shortened clip keeps). Only offered when the source is longer than
  // the item's current window — otherwise there is nothing to slide.
  const [showCropPicker, setShowCropPicker] = useState(false);
  // v9 — spatial reframe (preset frame crops), the SlotTrimPicker's twin.
  const [showReframePicker, setShowReframePicker] = useState(false);
  const videoAsset = item.type === 'video' && project ? project.mediaAssets[item.mediaAssetId] : undefined;
  const frameAsset = (item.type === 'video' || item.type === 'image') && project ? project.mediaAssets[item.mediaAssetId] : undefined;
  const frameCrop = (item.type === 'video' || item.type === 'image') ? item.crop : undefined;
  const videoSourceDuration = item.type === 'video' ? resolveSourceDuration(item, videoAsset?.durationSeconds) : 0;
  const canAdjustCrop = item.type === 'video' && !!videoAsset && hasCroppableSlack(item, videoSourceDuration);
  const transitionBoundaryDuration = findTransitionPreset(transitionPresetForBoundary)?.defaultDurationSeconds ?? 0.6;
  const transitionApplied =
    transitionAvailable && !!project && transitionAlreadyApplied(project, item.id, transitionBoundaryDuration);

  return (
    <div className="flex flex-col gap-3 bg-white/5 rounded-lg p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-bold uppercase tracking-wide text-white/60">{item.type} item</span>
        <button
          onClick={handleDelete}
          className="min-h-11 px-2 flex items-center text-red-400 hover:text-red-300 font-bold"
        >
          Delete
        </button>
      </div>

      {item.type === 'text' && (
        <div className="flex flex-col gap-2">
          <span className="font-bold uppercase tracking-wide text-white/40">Text</span>
          {/* Phase 2.3 — text style presets. They set only the two fields
              the compositor's drawTextItem actually consumes for text
              (fontSize — multiplied by the item's scale — and color), so a
              preset click is a real render change in preview + export,
              never a label-only choice. */}
          <div className="flex gap-1.5">
            {(
              [
                { id: 'headline', label: 'Headline', fontSize: 76, color: '#FFD100' },
                { id: 'subtitle', label: 'Subtitle', fontSize: 36, color: '#FFFFFF' },
                { id: 'cta', label: 'CTA', fontSize: 48, color: '#FF5C1A' },
              ] as const
            ).map((preset) => {
              const isActive = item.fontSize === preset.fontSize && item.color.toLowerCase() === preset.color.toLowerCase();
              return (
                <button
                  key={preset.id}
                  onClick={() => patch({ fontSize: preset.fontSize, color: preset.color })}
                  aria-pressed={isActive}
                  className={`min-h-11 flex-1 px-2 rounded-lg border text-xs font-bold transition ${
                    isActive
                      ? 'border-gold ring-1 ring-gold/60 bg-gold/10 text-gold'
                      : 'border-white/10 bg-white/5 hover:bg-white/10 text-white/80'
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
          <label className="flex flex-col gap-1">
            Font
            <select
              aria-label="Text font"
              value={item.font}
              onChange={(e) => patch({ font: e.target.value })}
              className="min-h-11 bg-white/10 rounded px-2 py-1 text-white text-base focus:outline-none focus:border-gold/60"
            >
              <option value="Arial">Classic (Arial)</option>
              {FONT_OPTIONS.map((f) => (
                <option key={f.family} value={f.family}>
                  {f.label} — {f.vibe}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Text
            <textarea
              value={item.text}
              onChange={(e) => patch({ text: e.target.value })}
              className="bg-white/10 rounded px-2 py-1 text-white text-base resize-none"
              rows={2}
            />
          </label>
          <label className="flex flex-col gap-1">
            Font size
            <input
              type="range"
              min={16}
              max={120}
              value={item.fontSize}
              onChange={(e) => patch({ fontSize: Number(e.target.value) })}
            />
          </label>
          <label className="flex items-center gap-2">
            Color
            <input type="color" value={item.color} onChange={(e) => patch({ color: e.target.value })} />
          </label>
        </div>
      )}

      {(item.type === 'image' || item.type === 'video' || item.type === 'text') && 'position' in item && (
        <div className="flex flex-col gap-2">
          <span className="font-bold uppercase tracking-wide text-white/40">Transform</span>
          <label className="flex flex-col gap-1">
            Position X ({(item as any).position.x.toFixed(0)}%)
            <input
              type="range"
              min={0}
              max={100}
              value={(item as any).position.x}
              onChange={(e) => patchPosition('x', Number(e.target.value))}
            />
          </label>
          <label className="flex flex-col gap-1">
            Position Y ({(item as any).position.y.toFixed(0)}%)
            <input
              type="range"
              min={0}
              max={100}
              value={(item as any).position.y}
              onChange={(e) => patchPosition('y', Number(e.target.value))}
            />
          </label>
          <label className="flex flex-col gap-1">
            Scale ({(item as any).scale.toFixed(2)}x)
            <input
              type="range"
              min={0.1}
              max={3}
              step={0.05}
              value={(item as any).scale}
              onChange={(e) => patch({ scale: Number(e.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1">
            Opacity ({Math.round((item as any).opacity * 100)}%)
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={(item as any).opacity}
              onChange={(e) => patch({ opacity: Number(e.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1">
            Rotation ({Math.round((item as any).rotation)}°)
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={(item as any).rotation}
              onChange={(e) => patch({ rotation: Number(e.target.value) })}
            />
          </label>
          {/* R24 — editor Flip (WS-P2): mirrors the drawn media in both
              preview and export (shared compositor). Video/image only;
              the same toggle lives in the PiP panel for PiP items. */}
          {(item.type === 'video' || item.type === 'image') && (
            <button
              onClick={() => patch({ flipX: (item as { flipX?: boolean }).flipX !== true })}
              aria-pressed={(item as { flipX?: boolean }).flipX === true}
              className={`min-h-11 px-3 rounded-lg border text-xs font-bold flex items-center justify-center gap-1.5 transition ${
                (item as { flipX?: boolean }).flipX === true
                  ? 'border-gold ring-1 ring-gold/60 bg-gold/10 text-gold'
                  : 'border-white/10 bg-white/5 hover:bg-white/10 text-white/80'
              }`}
            >
              Flip horizontally {(item as { flipX?: boolean }).flipX === true ? '· On' : ''}
            </button>
          )}
        </div>
      )}

      {item.type === 'video' && (
        <div className="flex flex-col gap-2 border-t border-white/10 pt-2">
          <span className="font-bold uppercase tracking-wide text-white/40">Picture in picture (PiP)</span>
          <div className="flex gap-2">
            <button
              onClick={() => patch({ pip: { shape: (item as { pip?: { shape?: string } }).pip?.shape ?? 'rounded', borderWidth: (item as { pip?: { borderWidth?: number } }).pip?.borderWidth ?? 4, borderColor: (item as { pip?: { borderColor?: string } }).pip?.borderColor ?? '#FFFFFF', shadow: (item as { pip?: { shadow?: boolean } }).pip?.shadow ?? true, isPip: true } })}
              disabled={!!(item as { pip?: { isPip?: boolean } }).pip?.isPip}
              className="min-h-11 px-3 rounded bg-white/10 hover:bg-white/20 text-xs font-bold disabled:opacity-40 flex items-center gap-1.5"
            >
              {(item as { pip?: { isPip?: boolean } }).pip?.isPip ? (<><Check size={14} strokeWidth={3} /> Is PiP overlay</>) : 'Make PiP overlay'}
            </button>
            {(item as { pip?: { isPip?: boolean } }).pip?.isPip && (
              <button
                onClick={() => patch({ pip: { shape: 'rounded', borderWidth: 0, borderColor: '#FFFFFF', shadow: false, isPip: false } })}
                className="min-h-11 px-3 rounded bg-white/10 hover:bg-white/20 text-xs font-bold"
              >
                Remove PiP
              </button>
            )}
          </div>
          {(item as { pip?: { isPip?: boolean } }).pip?.isPip && (
            <>
              {/* R25 — same nine shapes + finishes as the PiP panel
                  (shared PipShapeControls), incl. the shape-change
                  crop-zoom refit by the new shape's safe factor. */}
              <PipShapeStrip
                value={((item as { pip?: { shape?: PipShape } }).pip?.shape ?? 'rounded') as PipShape}
                onChange={(shape) =>
                  patch({
                    pip: { ...(item as { pip?: object }).pip, shape },
                    cropZoom: pipShapeRefitZoom((item as { cropZoom?: number }).cropZoom, shape),
                  })
                }
              />
              <PipRingControls
                pip={
                  ((item as { pip?: PipSettings }).pip ?? {
                    shape: 'rounded',
                    borderWidth: 4,
                    borderColor: '#FFFFFF',
                    shadow: true,
                    isPip: true,
                  }) as PipSettings
                }
                onPatch={(p) => patch({ pip: { ...(item as { pip?: object }).pip, ...p } })}
              />
              <label className="flex flex-col gap-1 text-xs">
                Border width ({(item as { pip?: { borderWidth?: number } }).pip?.borderWidth ?? 4}px)
                <input type="range" min={0} max={12} step={1} value={(item as { pip?: { borderWidth?: number } }).pip?.borderWidth ?? 4} onChange={(e) => patch({ pip: { ...(item as { pip?: object }).pip, borderWidth: Number(e.target.value) } })} />
              </label>
              <label className="flex items-center gap-2 text-xs">
                Border color
                <input type="color" value={(item as { pip?: { borderColor?: string } }).pip?.borderColor ?? '#FFFFFF'} onChange={(e) => patch({ pip: { ...(item as { pip?: object }).pip, borderColor: e.target.value } })} />
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={(item as { pip?: { shadow?: boolean } }).pip?.shadow ?? true} onChange={(e) => patch({ pip: { ...(item as { pip?: object }).pip, shadow: e.target.checked } })} />
                Shadow
              </label>
            </>
          )}
        </div>
      )}

      {item.type === 'video' && (
        <div className="flex flex-col gap-2 border-t border-white/10 pt-2">
          <span className="font-bold uppercase tracking-wide text-white/40">Speed</span>
          {/* Phase 2.3 — writes through `setItemSpeed`, the one helper that
              keeps the timeline invariant (duration = source span / speed)
              by re-deriving endTime from the unchanged trim window; the
              preview and export both run the element at this rate. */}
          <div className="flex flex-wrap gap-1.5">
            {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => {
              const isActive = Math.abs(item.speed - rate) < 0.001;
              return (
                <button
                  key={rate}
                  onClick={() => mutate((p) => setItemSpeed(p, item.id, rate))}
                  aria-pressed={isActive}
                  className={`min-h-11 px-2.5 rounded-lg border text-xs font-bold transition ${
                    isActive
                      ? 'border-gold ring-1 ring-gold/60 bg-gold/10 text-gold'
                      : 'border-white/10 bg-white/5 hover:bg-white/10 text-white/80'
                  }`}
                >
                  {rate}x
                </button>
              );
            })}
          </div>
          <label className="flex flex-col gap-1">
            <span className="flex items-center justify-between">
              <span>Playback speed</span>
              <span className="text-white/40">{item.speed.toFixed(2)}x · clip now {duration.toFixed(1)}s</span>
            </span>
            <input
              type="range"
              min={SPEED_MIN}
              max={SPEED_MAX}
              step={0.05}
              value={item.speed}
              onChange={(e) => mutate((p) => setItemSpeed(p, item.id, Number(e.target.value)))}
              className="w-full"
            />
          </label>
        </div>
      )}

      {item.type === 'video' && canAdjustCrop && (
        <div className="flex flex-col gap-2 border-t border-white/10 pt-2">
          <span className="font-bold uppercase tracking-wide text-white/40">Source crop</span>
          <p className="text-[11px] text-white/35 -mt-1">
            This clip shows {formatTimecode(item.trimEnd - item.trimStart)} of its {formatTimecode(videoSourceDuration)} source — slide the
            crop window to choose which part survives.
          </p>
          <button
            onClick={() => setShowCropPicker(true)}
            className="min-h-11 px-3 rounded-lg border border-gold/40 bg-gold/10 hover:bg-gold/20 text-gold text-xs font-bold flex items-center justify-center gap-1.5 transition"
          >
            <Crop size={14} /> Adjust crop
          </button>
        </div>
      )}

      {(item.type === 'video' || item.type === 'image') && frameCrop && (
        <div className="flex flex-col gap-2 border-t border-white/10 pt-2">
          <span className="font-bold uppercase tracking-wide text-white/40">Frame position</span>
          <p className="text-[11px] text-white/35 -mt-1">
            A preset cropped this clip to a {Math.round(frameCrop.width)}% × {Math.round(frameCrop.height)}% window of its
            source. Slide the window if it missed the subject.
          </p>
          <button
            onClick={() => setShowReframePicker(true)}
            className="min-h-11 px-3 rounded-lg border border-gold/40 bg-gold/10 hover:bg-gold/20 text-gold text-xs font-bold flex items-center justify-center gap-1.5 transition"
          >
            <Frame size={14} /> Reframe
          </button>
        </div>
      )}

      {item.type === 'video' && (
        <div className="flex flex-col gap-2 border-t border-white/10 pt-2">
          <span className="font-bold uppercase tracking-wide text-white/40">{isPipItem(item) ? 'Overlay audio' : 'Original audio'}</span>
          <p className="text-[11px] text-white/35 -mt-1">
            {isPipItem(item)
              ? 'This overlay clip’s own sound only — separate from the main video’s audio. Raise it to hear a talking head over the main clip, or mute it to keep the main audio clean.'
              : 'This clip’s own sound only — audio tracks you add are controlled separately. Lower it or mute it to lay your own music or voiceover over the picture.'}
          </p>
          <div className="flex items-center gap-2">
          <label className="flex flex-col gap-1 flex-1">
            Volume ({Math.round(item.volume * 100)}%)
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={item.volume}
              onChange={(e) => patch({ volume: Number(e.target.value) })}
            />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={item.muted} onChange={(e) => patch({ muted: e.target.checked })} />
            Mute
          </label>
          </div>
        </div>
      )}

      {isVisualItem(item) && (
        <div className="flex items-center gap-1 border-t border-white/10 pt-2">
          <span className="font-bold uppercase tracking-wide text-white/40 mr-1">Layer</span>
          <button
            onClick={() => mutate((p) => sendToBack(p, item.id))}
            title="Send to back"
            className="min-h-11 px-1.5 flex items-center justify-center gap-0.5 rounded bg-white/10 hover:bg-white/20 text-white text-[11px]"
          >
            <ArrowLeftToLine size={13} /> Back
          </button>
          <button
            onClick={() => mutate((p) => sendBackward(p, item.id))}
            title="Send backward"
            className="min-h-11 px-1.5 flex items-center justify-center gap-0.5 rounded bg-white/10 hover:bg-white/20 text-white text-[11px]"
          >
            <ArrowLeft size={13} /> Back
          </button>
          <button
            onClick={() => mutate((p) => bringForward(p, item.id))}
            title="Bring forward"
            className="min-h-11 px-1.5 flex items-center justify-center gap-0.5 rounded bg-white/10 hover:bg-white/20 text-white text-[11px]"
          >
            Fwd <ArrowRight size={13} />
          </button>
          <button
            onClick={() => mutate((p) => bringToFront(p, item.id))}
            title="Bring to front"
            className="min-h-11 px-1.5 flex items-center justify-center gap-0.5 rounded bg-white/10 hover:bg-white/20 text-white text-[11px]"
          >
            Front <ArrowRightToLine size={13} />
          </button>
        </div>
      )}

      {hasMotion && (
        <div className="flex flex-col gap-2 border-t border-white/10 pt-2">
          <span className="font-bold uppercase tracking-wide text-white/40">Effects</span>
          <label className="flex flex-col gap-1">
            Motion effect
            <select
              value={motion?.type ?? 'none'}
              onChange={(e) => patchMotion({ type: e.target.value as MotionEffectType })}
              className="bg-white/10 rounded px-2 py-1 text-white text-base"
            >
              <option value="none">None</option>
              {MOTION_EFFECTS.map((effect) => (
                <option key={effect.id} value={effect.id} title={effect.description}>
                  {effect.label}
                </option>
              ))}
            </select>
          </label>
          {motionEffectInfo && (
            <>
              <p className="text-white/30 text-[11px]">{motionEffectInfo.description}</p>
              {motionEffectInfo.usesDirection && (
                <label className="flex flex-col gap-1">
                  Direction
                  <select
                    value={motion?.direction ?? 'right'}
                    onChange={(e) => patchMotion({ direction: e.target.value as MotionDirection })}
                    className="bg-white/10 rounded px-2 py-1 text-white text-base"
                  >
                    {MOTION_DIRECTIONS.map((dir) => (
                      <option key={dir.id} value={dir.id}>
                        {dir.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex flex-col gap-1">
                <span className="flex items-center justify-between">
                  <span>Effect intensity</span>
                  <span className="text-white/40">{(motion?.intensity ?? MOTION_INTENSITY_DEFAULT).toFixed(1)}x</span>
                </span>
                <input
                  type="range"
                  min={MOTION_INTENSITY_MIN}
                  max={MOTION_INTENSITY_MAX}
                  step={0.1}
                  value={motion?.intensity ?? MOTION_INTENSITY_DEFAULT}
                  onChange={(e) => patchMotion({ intensity: Number(e.target.value) })}
                />
              </label>
            </>
          )}
        </div>
      )}

      {hasAnimation && (
        <div className="flex flex-col gap-2 border-t border-white/10 pt-2">
          <span className="font-bold uppercase tracking-wide text-white/40">Transition</span>
          <div className="flex items-center gap-2">
            <label className="flex flex-col gap-1 flex-1">
              Entrance
              <select
                value={animation?.entrance ?? 'none'}
                onChange={(e) => patch({ animation: { ...animation, entrance: e.target.value as AnimationPreset } })}
                className="bg-white/10 rounded px-2 py-1 text-white text-base"
              >
                <option value="none">None</option>
                {TRANSITION_CATEGORIES.map((cat) => (
                  <optgroup key={cat.id} label={cat.label}>
                    {transitionPresetsByCategory(cat.id).map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
                {item.type === 'text' && (
                  <optgroup label="Kinetic text (entrance only)">
                    {TEXT_ONLY_ANIMATION_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            <label className="flex flex-col gap-1 flex-1">
              Exit
              <select
                value={animation?.exit ?? 'none'}
                onChange={(e) => patch({ animation: { ...animation, exit: e.target.value as AnimationPreset } })}
                className="bg-white/10 rounded px-2 py-1 text-white text-base"
              >
                <option value="none">None</option>
                {TRANSITION_CATEGORIES.map((cat) => (
                  <optgroup key={cat.id} label={cat.label}>
                    {transitionPresetsByCategory(cat.id).map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1">
            <span className="flex items-center justify-between">
              <span>Transition intensity</span>
              <span className="text-white/40">{(animation?.intensity ?? TRANSITION_INTENSITY_DEFAULT).toFixed(1)}x</span>
            </span>
            <input
              type="range"
              min={TRANSITION_INTENSITY_MIN}
              max={TRANSITION_INTENSITY_MAX}
              step={0.1}
              value={animation?.intensity ?? TRANSITION_INTENSITY_DEFAULT}
              onChange={(e) => patch({ animation: { ...animation, intensity: Number(e.target.value) } })}
            />
          </label>
          <div className="flex items-center gap-2">
            <label className="flex flex-col gap-1 flex-1">
              Fade in (s, max {Math.min(MAX_FADE_SECONDS, duration).toFixed(1)})
              <input
                type="number"
                min={0}
                max={Math.min(MAX_FADE_SECONDS, duration)}
                step={0.1}
                value={fade?.fadeInDuration ?? 0}
                onChange={(e) =>
                  patch({
                    fade: {
                      fadeInDuration: Math.max(0, Math.min(Number(e.target.value), MAX_FADE_SECONDS, duration)),
                      fadeOutDuration: fade?.fadeOutDuration ?? 0,
                    },
                  })
                }
                className="bg-white/10 rounded px-2 py-1 text-white text-base"
              />
            </label>
            <label className="flex flex-col gap-1 flex-1">
              Fade out (s, max {Math.min(MAX_FADE_SECONDS, duration).toFixed(1)})
              <input
                type="number"
                min={0}
                max={Math.min(MAX_FADE_SECONDS, duration)}
                step={0.1}
                value={fade?.fadeOutDuration ?? 0}
                onChange={(e) =>
                  patch({
                    fade: {
                      fadeInDuration: fade?.fadeInDuration ?? 0,
                      fadeOutDuration: Math.max(0, Math.min(Number(e.target.value), MAX_FADE_SECONDS, duration)),
                    },
                  })
                }
                className="bg-white/10 rounded px-2 py-1 text-white text-base"
              />
            </label>
          </div>
          {dissolveAvailable && (
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={() => mutate((p) => applyCrossDissolve(p, item.id, CROSS_DISSOLVE_DURATION_SECONDS))}
                disabled={dissolveApplied}
                className={`min-h-11 px-2 rounded uppercase tracking-wide font-bold text-[11px] ${
                  dissolveApplied ? 'bg-white/5 text-white/30 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-500 text-white'
                }`}
                title="Overlap this clip with the next one on this track and cross-fade between them"
              >
                {dissolveApplied ? 'Cross Dissolve Applied' : (<>Cross Dissolve <ArrowRight size={12} className="inline" /></>)}
              </button>
            </div>
          )}
          {transitionAvailable && (
            <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
              <span className="font-bold uppercase tracking-wide text-white/40 text-[10px]">Transition to next clip</span>
              <div className="flex items-center gap-2">
                <select
                  value={transitionPresetForBoundary}
                  onChange={(e) => setTransitionPresetForBoundary(e.target.value as AnimationPreset)}
                  className="min-h-11 bg-white/10 rounded px-2 py-1 text-white text-base flex-1"
                >
                  {TRANSITION_CATEGORIES.map((cat) => (
                    <optgroup key={cat.id} label={cat.label}>
                      {transitionPresetsByCategory(cat.id).map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <button
                  onClick={() => mutate((p) => applyTransition(p, item.id, transitionPresetForBoundary, transitionBoundaryDuration))}
                  disabled={transitionApplied}
                  className={`min-h-11 px-2 rounded uppercase tracking-wide font-bold text-[11px] shrink-0 ${
                    transitionApplied ? 'bg-white/5 text-white/30 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-500 text-white'
                  }`}
                  title="Overlap this clip with the next one on this track and play this transition between them — both clips draw simultaneously during the overlap, real WYSIWYG in preview and export"
                >
                  {transitionApplied ? 'Applied' : (<>Apply <ArrowRight size={12} className="inline" /></>)}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {item.type !== 'caption' && (
        <div className="flex flex-col gap-2 border-t border-white/10 pt-2">
          <span className="font-bold uppercase tracking-wide text-white/40">Timing</span>
          <div className="flex items-center gap-2">
          <label className="flex flex-col gap-1 flex-1">
            Start (s)
            <input
              type="number"
              step={0.1}
              value={item.startTime}
              onChange={(e) => mutate((project) => trimItemStart(project, item.id, Number(e.target.value)))}
              className="bg-white/10 rounded px-2 py-1 text-white text-base"
            />
          </label>
          <label className="flex flex-col gap-1 flex-1">
            Duration (s, max {MAX_MEDIA_SECONDS})
            <input
              type="number"
              step={0.1}
              min={0.1}
              max={MAX_MEDIA_SECONDS}
              value={duration}
              onChange={(e) => mutate((project) => setItemDuration(project, item.id, Number(e.target.value)))}
              className="bg-white/10 rounded px-2 py-1 text-white text-base"
            />
          </label>
          </div>
        </div>
      )}
      {item.type !== 'caption' && <p className="text-white/30">Duration: {duration.toFixed(1)}s</p>}
      {/* R40 P-11 (DOCUMENT verdict): one media element per asset is
          still the model — when this item's clip is also used in a
          differing place, say so plainly, here and nowhere else. */}
      {project && hasDifferingSharedUse(project, item) && (
        <p className="text-white/50">{SHARED_CLIP_NOTE}</p>
      )}
      {willHold && item.type === 'video' && (
        <p className="text-white/50">{"This clip's last frame stays on screen until the project ends."}</p>
      )}
      {willHold && item.type === 'image' && (
        <p className="text-white/50">This picture stays on screen until the project ends.</p>
      )}

      {item.type === 'caption' && <CaptionInspector item={item} />}
      {item.type === 'audio' && <AudioInspector item={item} />}

      {item.type !== 'audio' && (
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={item.visible} onChange={(e) => patch({ visible: e.target.checked })} />
          Visible
        </label>
      )}

      {showReframePicker && (item.type === 'video' || item.type === 'image') && frameAsset && (
        <ReframePicker
          item={item}
          asset={frameAsset}
          onCancel={() => setShowReframePicker(false)}
          onConfirm={(crop) => {
            patch({ crop });
            setShowReframePicker(false);
          }}
        />
      )}

      {showCropPicker && item.type === 'video' && videoAsset && (
        <SlotTrimPicker
          item={item}
          asset={videoAsset}
          onCancel={() => setShowCropPicker(false)}
          onConfirm={(trimStart) => {
            patch({ trimStart, trimEnd: trimStart + (item.trimEnd - item.trimStart) });
            setShowCropPicker(false);
          }}
        />
      )}
    </div>
  );
});

/**
 * Audio-item-specific controls — before this pass, an imported standalone
 * audio item (music/voiceover/sfx) had NO dedicated UI at all once placed
 * on the timeline: no volume, no mute, no fade, and a "Visible" checkbox
 * that makes no sense for something with no picture. Full-app audit finding
 * (`AUDIO UX`): the underlying `AudioTimelineItem.volume`/`.muted`/`.fade`
 * fields already existed and were already correctly respected by the
 * export renderer (`canvas2dRenderer.ts`) — they just had no inspector
 * control, so a user had no way to actually adjust them.
 */
function AudioInspector({ item }: { item: AudioTimelineItem }) {
  const { mutate } = useProject();
  const patch = (fields: Record<string, unknown>) => {
    mutate((project) => updateItem(project, item.id, fields));
  };
  // "Universal 30-second media standard" spec item 12 — fade duration must
  // be clamped to `min(3s, available media duration)`. `getItemDuration` is
  // avoided here purely to keep this small component's imports minimal;
  // `item.endTime - item.startTime` is the identical calculation.
  const clipDuration = item.endTime - item.startTime;
  const maxFade = Math.min(MAX_FADE_SECONDS, clipDuration);
  return (
    <div className="flex flex-col gap-2 border-t border-white/10 pt-2">
      <span className="font-bold uppercase tracking-wide text-white/40">Audio</span>
      <div className="flex items-center gap-2">
        <label className="flex flex-col gap-1 flex-1">
          Volume ({Math.round(item.volume * 100)}%)
          <input type="range" min={0} max={1} step={0.05} value={item.volume} onChange={(e) => patch({ volume: Number(e.target.value) })} />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={item.muted} onChange={(e) => patch({ muted: e.target.checked })} />
          Mute
        </label>
      </div>
      <div className="flex items-center gap-2">
        <label className="flex flex-col gap-1 flex-1">
          Fade in (s, max {maxFade.toFixed(1)})
          <input
            type="number"
            min={0}
            max={maxFade}
            step={0.1}
            value={item.fade.fadeInDuration}
            onChange={(e) =>
              patch({ fade: { fadeInDuration: Math.max(0, Math.min(Number(e.target.value), maxFade)), fadeOutDuration: item.fade.fadeOutDuration } })
            }
            className="bg-white/10 rounded px-2 py-1 text-white text-base"
          />
        </label>
        <label className="flex flex-col gap-1 flex-1">
          Fade out (s, max {maxFade.toFixed(1)})
          <input
            type="number"
            min={0}
            max={maxFade}
            step={0.1}
            value={item.fade.fadeOutDuration}
            onChange={(e) =>
              patch({ fade: { fadeInDuration: item.fade.fadeInDuration, fadeOutDuration: Math.max(0, Math.min(Number(e.target.value), maxFade)) } })
            }
            className="bg-white/10 rounded px-2 py-1 text-white text-base"
          />
        </label>
      </div>
    </div>
  );
}

/**
 * Caption-specific editing UI — the caption pipeline had ZERO caption-
 * specific fields before this pass (a caption item could only be deleted
 * via the generic Delete button above). Per-word text/timing edits and the
 * style picker below all go through `updateItem(..., {words})` /
 * `updateItem(..., {captionStyleId})`, so a change is visible in the
 * preview/export on the very next `drawFrame` call — there is no separate
 * "decorative" caption editor state to keep in sync.
 */
function CaptionInspector({ item }: { item: CaptionTimelineItem }) {
  const { mutate } = useProject();

  const patchWords = (words: CaptionTimelineItem['words']) => {
    mutate((project) => updateItem(project, item.id, { words }));
  };

  const updateWord = (index: number, fields: Partial<CaptionTimelineItem['words'][number]>) => {
    const words = item.words.map((w, i) => (i === index ? { ...w, ...fields } : w));
    // Guard against invalid negative/reversed timing from a manual edit —
    // same invariant `addCaptionWord` enforces for the Add Word control.
    const edited = words[index];
    const start = Math.max(0, edited.start);
    const end = Math.max(start + 0.01, edited.end);
    words[index] = { ...edited, start, end };
    patchWords(words);
  };

  const deleteWord = (index: number) => {
    patchWords(item.words.filter((_, i) => i !== index));
  };

  const addWord = () => {
    mutate((project) => addCaptionWord(project, item.id));
  };

  return (
    <div className="flex flex-col gap-2 border-t border-white/10 pt-2">
      <span className="font-bold uppercase tracking-wide text-white/40">Caption</span>

      <div className="flex flex-col gap-1.5">
        <span>Style</span>
        {/* Preview chips (polish batch) — each chip renders the style's
            REAL params (family / weight / color / stroke / background /
            uppercase) on sample text at chip scale, so the picker shows
            what the caption will actually look like instead of a bare
            name in a <select>. Selected chip carries the gold ring. */}
        <div className="grid grid-cols-2 gap-1.5">
          {CAPTION_STYLES.map((style) => {
            const isSelected = item.captionStyleId === style.id;
            const chipStroke =
              style.strokeWidth > 0 && style.strokeColor !== 'transparent'
                ? Math.max(0.4, style.strokeWidth / 6)
                : 0;
            return (
              <button
                key={style.id}
                onClick={() => mutate((project) => updateItem(project, item.id, { captionStyleId: style.id }))}
                title={style.label}
                aria-pressed={isSelected}
                className={`rounded-lg overflow-hidden border text-left transition ${
                  isSelected ? 'border-gold ring-1 ring-gold' : 'border-white/10 hover:border-white/30'
                }`}
              >
                <span className="flex h-11 items-center justify-center overflow-hidden px-1.5" style={{ background: style.background ?? '#141414' }}>
                  <span
                    className="whitespace-nowrap"
                    style={{
                      fontFamily: style.fontFamily,
                      fontSize: 13,
                      fontWeight: 700,
                      lineHeight: 1.1,
                      color: style.color,
                      textTransform: style.uppercase ? 'uppercase' : 'none',
                      WebkitTextStroke: chipStroke ? `${chipStroke}px ${style.strokeColor}` : undefined,
                      textShadow: '0 1px 2px rgba(0,0,0,0.7)',
                    }}
                  >
                    Your caption
                  </span>
                </span>
                <span className="block truncate bg-white/5 px-1.5 py-1 text-[10px] text-white/60">{style.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-1 max-h-56 overflow-y-auto pr-1">
        {item.words.length === 0 && <p className="text-white/30 italic">No words in this caption.</p>}
        {item.words.map((word, index) => (
          <div key={index} className="flex items-center gap-1 bg-white/5 rounded p-1">
            <input
              type="text"
              value={word.text}
              onChange={(e) => updateWord(index, { text: e.target.value })}
              className="bg-white/10 rounded px-2 py-1 text-white text-base flex-1 min-w-0"
            />
            <input
              type="number"
              step={0.05}
              value={Number(word.start.toFixed(2))}
              onChange={(e) => updateWord(index, { start: Number(e.target.value) })}
              title="Word start (s, relative to caption start)"
              className="bg-white/10 rounded px-1 py-1 text-white text-base w-14"
            />
            <input
              type="number"
              step={0.05}
              value={Number(word.end.toFixed(2))}
              onChange={(e) => updateWord(index, { end: Number(e.target.value) })}
              title="Word end (s, relative to caption start)"
              className="bg-white/10 rounded px-1 py-1 text-white text-base w-14"
            />
            {/* Deliberately NOT bumped to the 44px touch minimum like other buttons in
                this panel: it lives inside a dense 4-control word row (text + start +
                end + delete) where a 44px-tall delete control would roughly double
                every row's height and push most of a multi-word caption off-screen on
                mobile. Widened modestly instead so it's still easier to hit than a
                bare 1-char tap target. */}
            <button
              onClick={() => deleteWord(index)}
              aria-label="Delete word"
              className="min-h-9 min-w-9 flex items-center justify-center text-red-400 hover:text-red-300"
            >
              <X size={14} strokeWidth={3} />
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={addWord}
        className="self-start min-h-11 px-3 rounded bg-white/10 hover:bg-white/20 text-white uppercase tracking-wide font-bold text-[11px]"
      >
        + Add word
      </button>
      <p className="text-white/30">
        Timeline span: {item.startTime.toFixed(1)}s – {item.endTime.toFixed(1)}s ({(item.endTime - item.startTime).toFixed(1)}s)
      </p>
    </div>
  );
}
