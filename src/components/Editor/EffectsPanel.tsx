import React from 'react';
import { Check, MoveDiagonal, Sparkles } from 'lucide-react';
import { useProject } from '../../context/ProjectContext';
import type { EndTransformSettings, MotionDirection, MotionEffectType, MotionSettings, TimelineItem } from '../../types/timeline';
import { updateItem, updateItemMotion } from '../../lib/timeline/utils';
import {
  MOTION_DIRECTIONS,
  MOTION_EFFECTS,
  MOTION_INTENSITY_DEFAULT,
  MOTION_INTENSITY_MAX,
  MOTION_INTENSITY_MIN,
  findMotionEffect,
} from '../../lib/motionEffects';

/**
 * Phase 2.1 — Motion/Zoom Effects as a first-class panel (previously only
 * a <select> inside ItemInspector). Effects run continuously across the
 * selected clip's whole on-screen duration — Ken Burns family, see
 * lib/motionEffects.ts — and every control here writes the item's one
 * `motion` field through the shared `updateItemMotion` util, the exact
 * merge ItemInspector's own motion controls use. No parallel state.
 */
export function EffectsPanel({ item }: { item: TimelineItem | null }) {
  const { project, mutate } = useProject();
  if (!project) return null;

  const header = (
    <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-white/50">
      <Sparkles size={14} className="text-gold" /> Effects
    </h3>
  );

  if (!item) {
    return (
      <div className="flex flex-col gap-2">
        {header}
        <p className="text-[11px] text-white/40">Select a video or image clip to give it a motion effect — it runs for the clip's whole duration.</p>
      </div>
    );
  }

  if (item.type !== 'video' && item.type !== 'image') {
    return (
      <div className="flex flex-col gap-2">
        {header}
        <p className="text-[11px] text-white/40">Motion effects apply to video and image clips — select one of those.</p>
      </div>
    );
  }

  const motion = (item as { motion?: MotionSettings }).motion;
  const activeType: MotionEffectType = motion?.type ?? 'none';
  const activeInfo = findMotionEffect(motion?.type);

  const setMotion = (fields: Partial<MotionSettings>) => {
    mutate((p) => updateItemMotion(p, item.id, fields));
  };

  // Keyframe-lite (Phase 2.3): the compositor interpolates position/
  // scale/opacity from the item's base transform to `endTransform` across
  // its whole duration — this section writes that one field via
  // `updateItem`, nothing parallel.
  const endTransform = (item as { endTransform?: EndTransformSettings }).endTransform;
  const setEndTransform = (fields: Partial<EndTransformSettings> | undefined) => {
    if (fields === undefined) {
      mutate((p) => updateItem(p, item.id, { endTransform: undefined }));
      return;
    }
    const base: EndTransformSettings = endTransform ?? {
      position: { ...(item as { position: { x: number; y: number } }).position },
      scale: (item as { scale: number }).scale,
      opacity: (item as { opacity: number }).opacity,
    };
    mutate((p) => updateItem(p, item.id, { endTransform: { ...base, ...fields } }));
  };

  const END_POSITIONS: { id: string; label: string; position: { x: number; y: number } }[] = [
    { id: 'tl', label: 'Top left', position: { x: 20, y: 20 } },
    { id: 'tr', label: 'Top right', position: { x: 80, y: 20 } },
    { id: 'c', label: 'Center', position: { x: 50, y: 50 } },
    { id: 'bl', label: 'Bottom left', position: { x: 20, y: 80 } },
    { id: 'br', label: 'Bottom right', position: { x: 80, y: 80 } },
  ];

  const cardClass = (isActive: boolean) =>
    `min-h-11 px-2 rounded-lg border text-left flex items-center justify-between gap-1 transition ${
      isActive
        ? 'border-gold ring-1 ring-gold/60 bg-gold/10 text-gold'
        : 'border-white/10 bg-white/5 hover:bg-white/10 text-white/80'
    }`;

  return (
    <div className="flex flex-col gap-2">
      {header}
      <div className="grid grid-cols-2 gap-1.5">
        <button onClick={() => setMotion({ type: 'none' })} aria-pressed={activeType === 'none'} className={cardClass(activeType === 'none')}>
          <span className="text-xs font-bold">None</span>
          {activeType === 'none' && <Check size={14} strokeWidth={3} className="shrink-0" />}
        </button>
        {MOTION_EFFECTS.map((effect) => {
          const isActive = activeType === effect.id;
          return (
            <button
              key={effect.id}
              onClick={() => setMotion({ type: effect.id })}
              aria-pressed={isActive}
              title={effect.description}
              className={cardClass(isActive)}
            >
              <span className="text-xs font-bold leading-tight">{effect.label}</span>
              {isActive && <Check size={14} strokeWidth={3} className="shrink-0" />}
            </button>
          );
        })}
      </div>

      {activeInfo && (
        <div className="flex flex-col gap-2 pt-1">
          <p className="text-[11px] text-white/40">{activeInfo.description}</p>
          {activeInfo.usesDirection && (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-bold uppercase tracking-wide text-white/40">Direction</span>
              <div className="flex gap-1.5">
                {MOTION_DIRECTIONS.map((dir) => {
                  const isActiveDir = (motion?.direction ?? 'right') === dir.id;
                  return (
                    <button
                      key={dir.id}
                      onClick={() => setMotion({ direction: dir.id as MotionDirection })}
                      aria-pressed={isActiveDir}
                      className={`min-h-11 flex-1 px-2 rounded-lg border text-xs font-bold transition ${
                        isActiveDir
                          ? 'border-gold ring-1 ring-gold/60 bg-gold/10 text-gold'
                          : 'border-white/10 bg-white/5 hover:bg-white/10 text-white/80'
                      }`}
                    >
                      {dir.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <label className="flex flex-col gap-1 text-xs text-white/60">
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
              onChange={(e) => setMotion({ intensity: Number(e.target.value) })}
              className="w-full"
            />
          </label>
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-white/10 pt-2">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-white/40">
            <MoveDiagonal size={12} className="text-gold" /> Animate to end position
          </span>
          <button
            onClick={() => (endTransform ? setEndTransform(undefined) : setEndTransform({}))}
            aria-pressed={!!endTransform}
            className={`min-h-11 px-3 rounded-lg border text-xs font-bold transition ${
              endTransform
                ? 'border-gold ring-1 ring-gold/60 bg-gold/10 text-gold'
                : 'border-white/10 bg-white/5 hover:bg-white/10 text-white/80'
            }`}
          >
            {endTransform ? 'On' : 'Off'}
          </button>
        </div>
        {endTransform && (
          <>
            <p className="text-[11px] text-white/40">
              The clip glides from its start transform to this end state across its whole duration — in preview and export.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {END_POSITIONS.map((preset) => {
                const isActive = endTransform.position.x === preset.position.x && endTransform.position.y === preset.position.y;
                return (
                  <button
                    key={preset.id}
                    onClick={() => setEndTransform({ position: preset.position })}
                    aria-pressed={isActive}
                    className={`min-h-11 px-2.5 rounded-lg border text-xs font-bold transition ${
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
            <label className="flex flex-col gap-1 text-xs text-white/60">
              <span className="flex items-center justify-between">
                <span>End scale</span>
                <span className="text-white/40">{endTransform.scale.toFixed(2)}x</span>
              </span>
              <input
                type="range"
                min={0.2}
                max={2.5}
                step={0.05}
                value={endTransform.scale}
                onChange={(e) => setEndTransform({ scale: Number(e.target.value) })}
                className="w-full"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-white/60">
              <span className="flex items-center justify-between">
                <span>End opacity</span>
                <span className="text-white/40">{Math.round(endTransform.opacity * 100)}%</span>
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={endTransform.opacity}
                onChange={(e) => setEndTransform({ opacity: Number(e.target.value) })}
                className="w-full"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-white/60">
              <input
                type="checkbox"
                checked={!!endTransform.eased}
                onChange={(e) => setEndTransform({ eased: e.target.checked })}
              />
              Smooth easing (ease in/out instead of a constant glide)
            </label>
          </>
        )}
      </div>
    </div>
  );
}
