import React from 'react';
import { Check, Sparkles } from 'lucide-react';
import { useProject } from '../../context/ProjectContext';
import type { MotionDirection, MotionEffectType, MotionSettings, TimelineItem } from '../../types/timeline';
import { updateItemMotion } from '../../lib/timeline/utils';
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
    </div>
  );
}
