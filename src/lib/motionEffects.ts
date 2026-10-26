/**
 * "Final production fix" spec item 8 — the Motion/Zoom Effects catalog
 * (Ken Burns family). Deliberately a separate catalog from
 * `lib/transitions.ts`: transitions play briefly at an item's entrance/exit,
 * motion effects run continuously across an item's entire on-screen
 * duration, and the spec explicitly asks for them to appear as a distinct
 * "Effects" section in the UI (see `MotionEffectPicker` in
 * `components/Editor/ItemInspector.tsx`) rather than folded into the
 * transitions picker.
 */

import type { MotionDirection, MotionEffectType } from '../types/timeline';

export interface MotionEffectInfo {
  id: MotionEffectType;
  label: string;
  /** Short description shown in the picker — what the effect actually does. */
  description: string;
  /** Whether this effect's picker should also show the direction control. */
  usesDirection: boolean;
}

export const MOTION_EFFECTS: MotionEffectInfo[] = [
  { id: 'ken-burns', label: 'Ken Burns', description: 'Classic slow pan + zoom across the whole clip.', usesDirection: true },
  { id: 'slow-zoom-in', label: 'Slow Zoom In', description: 'Gentle continuous zoom toward the center.', usesDirection: false },
  { id: 'slow-zoom-out', label: 'Slow Zoom Out', description: 'Starts zoomed in, eases back out.', usesDirection: false },
  { id: 'dynamic-zoom', label: 'Dynamic Zoom', description: 'Zooms in then back out over the clip.', usesDirection: false },
  { id: 'punch-zoom', label: 'Punch Zoom', description: 'A quick punch-in at the start that settles.', usesDirection: false },
  { id: 'product-focus', label: 'Product Focus', description: 'Very gentle zoom-in with a soft vignette to draw the eye to center.', usesDirection: false },
  { id: 'parallax', label: 'Parallax', description: 'A slow, wide drift across the frame, scaled up to avoid edge gaps.', usesDirection: true },
  { id: 'subtle-shake', label: 'Subtle Shake', description: 'A continuous light handheld-camera jitter.', usesDirection: false },
  { id: 'spotlight', label: 'Spotlight', description: 'Darkened edges with a bright, slowly-drifting highlight.', usesDirection: false },
  { id: 'vignette', label: 'Vignette', description: 'Softly darkened edges, framing the subject.', usesDirection: false },
  { id: 'flash', label: 'Flash', description: 'Periodic bright strobe pulses.', usesDirection: false },
  { id: 'light-sweep', label: 'Light Sweep', description: 'A bright band of light sweeping across the frame once.', usesDirection: false },
  { id: 'dolly-push', label: 'Dolly Push', description: 'A confident, eased push toward the subject — the cinematic standard.', usesDirection: false },
  { id: 'orbit-drift', label: 'Orbit Drift', description: 'A slow orbital sway that starts and ends at the home framing.', usesDirection: false },
  { id: 'focus-pull', label: 'Focus Pull', description: 'Starts soft and racks into sharp focus over the first third.', usesDirection: false },
];

export const MOTION_INTENSITY_MIN = 0.5;
export const MOTION_INTENSITY_MAX = 2;
export const MOTION_INTENSITY_DEFAULT = 1;

export function findMotionEffect(id: MotionEffectType | undefined): MotionEffectInfo | undefined {
  if (!id || id === 'none') return undefined;
  return MOTION_EFFECTS.find((e) => e.id === id);
}

export const MOTION_DIRECTIONS: { id: MotionDirection; label: string }[] = [
  { id: 'left', label: 'Left' },
  { id: 'right', label: 'Right' },
  { id: 'up', label: 'Up' },
  { id: 'down', label: 'Down' },
];
