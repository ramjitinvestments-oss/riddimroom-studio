import React from 'react';
import { Blend, Check } from 'lucide-react';
import { useProject } from '../../context/ProjectContext';
import type { AnimationPreset, AnimationSettings, TimelineItem } from '../../types/timeline';
import {
  applyTransition,
  canApplyTransition,
  findAdjacentNextItem,
  getBoundaryTransition,
  updateItem,
} from '../../lib/timeline/utils';
import {
  TRANSITION_CATEGORIES,
  TRANSITION_PRESETS,
  findTransitionPreset,
  transitionPresetsByCategory,
} from '../../lib/transitions';

/**
 * Phase 2.1 — Transitions as a first-class panel (they previously lived
 * only as a select + Apply button buried in ItemInspector). One tap on a
 * preset card applies a REAL overlap-based transition between the
 * selected clip and the next clip on its track, through the same
 * `applyTransition` primitive the inspector uses — both clips draw
 * simultaneously during the overlap, in preview and export alike.
 *
 * Deliberately NO "None"/remove card: applying a transition shifts the
 * next clip earlier by the transition's duration and the pre-transition
 * gap is not recorded anywhere (see `getBoundaryTransition`'s doc
 * comment), so there is no safe remove primitive to wire a button to.
 * Picking a DIFFERENT preset while one is applied is supported — it swaps
 * the preset pair in place via `updateItem` without re-shifting the
 * clips. Undo is the way back from an apply.
 */
export function TransitionsPanel({ item }: { item: TimelineItem | null }) {
  const { project, mutate } = useProject();
  if (!project) return null;

  const header = (
    <h3 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-white/50">
      <Blend size={14} className="text-gold" /> Transitions
    </h3>
  );

  if (!item) {
    return (
      <div className="flex flex-col gap-2">
        {header}
        <p className="text-[11px] text-white/40">
          Select a clip on the timeline — a transition plays between the selected clip and the one after it.
        </p>
      </div>
    );
  }

  if (item.type !== 'video' && item.type !== 'image' && item.type !== 'text') {
    return (
      <div className="flex flex-col gap-2">
        {header}
        <p className="text-[11px] text-white/40">Transitions work on video, image, and text clips — select one of those.</p>
      </div>
    );
  }

  if (!canApplyTransition(project, item.id)) {
    return (
      <div className="flex flex-col gap-2">
        {header}
        <p className="text-[11px] text-white/40">
          Select a clip that has another clip after it on the same track — a transition needs two clips back to back.
        </p>
      </div>
    );
  }

  const applied = getBoundaryTransition(project, item.id);
  const appliedInfo = applied ? findTransitionPreset(applied.preset) : undefined;

  const handlePick = (preset: AnimationPreset) => {
    if (applied?.preset === preset) return; // already the active one — never re-apply (would re-shift)
    if (applied) {
      // A transition is already in place at this boundary (clips already
      // overlap): swap ONLY the preset pair, in place, so repeated picks
      // never cumulatively shift the next clip earlier.
      mutate((p) => {
        const current = p.items.find((i) => i.id === item.id);
        const next = findAdjacentNextItem(p, item.id);
        if (!current || !next) return p;
        const currentAnimation = (current as { animation?: AnimationSettings }).animation;
        const nextAnimation = (next as { animation?: AnimationSettings }).animation;
        let next_ = updateItem(p, current.id, { animation: { ...currentAnimation, exit: preset } });
        next_ = updateItem(next_, next.id, { animation: { ...nextAnimation, entrance: preset } });
        return next_;
      });
    } else {
      mutate((p) => applyTransition(p, item.id, preset));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {header}
      <p className="text-[11px] text-white/40">
        Plays between this clip and the next one. One tap applies it — the next clip shifts earlier so both overlap while it plays.
      </p>
      {applied && (
        <p className="text-[11px] text-gold flex items-center gap-1">
          <Check size={12} strokeWidth={3} /> Applied: {appliedInfo?.label ?? applied.preset} ({applied.durationSeconds.toFixed(2)}s)
        </p>
      )}
      {/* v9 mobile-first: one dropdown (grouped by category) instead of
          34 cards — same one-tap apply, a fifth of the scroll. */}
      <select
        aria-label="Transition preset"
        value={applied?.preset ?? ''}
        onChange={(e) => {
          if (e.target.value) handlePick(e.target.value as AnimationPreset);
        }}
        className="w-full min-h-11 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-gold/60"
      >
        <option value="" disabled>
          Choose a transition…
        </option>
        {TRANSITION_CATEGORIES.map((cat) => (
          <optgroup key={cat.id} label={cat.label}>
            {transitionPresetsByCategory(cat.id).map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label} · {preset.defaultDurationSeconds.toFixed(2)}s
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <p className="text-[10px] text-white/30">
        {TRANSITION_PRESETS.length} presets. Tip: Undo (Ctrl/Cmd+Z) removes a transition — it shifts the next clip, so there's no separate remove.
      </p>
    </div>
  );
}
