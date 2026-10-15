import type { AnimationPreset } from '../types/timeline';

/**
 * "Final production fix" spec item 7 — the premium transitions catalog:
 * every entrance/exit preset `computeEntranceExit` (compositor.ts) gives
 * bespoke math to, grouped into the spec's 4 named categories, each with a
 * real display name and a sensible default duration (shorter/punchier for
 * "Modern/Social" and "Marketing/Advertising", longer/softer for
 * "Premium/Cinematic"). This is UI/catalog metadata only — the actual
 * per-frame motion lives in compositor.ts; `defaultDurationSeconds` is what
 * `computeEntranceExit` uses when an item hasn't been given its own
 * duration, and `TRANSITION_INTENSITY_*` bounds are what the inspector's
 * Intensity slider (item.animation.intensity) is clamped to.
 *
 * `typewriter`/`word-by-word`/`karaoke` (text-only kinetic reveals, driven
 * by `kineticRevealText` rather than `AnimatedAdjustment` motion) are
 * intentionally NOT in this catalog — they're a different mechanism (which
 * characters/words are drawn at all, not how the whole item moves) and stay
 * on their own `TEXT_ONLY_ANIMATION_OPTIONS` list in ItemInspector.tsx.
 */

export type TransitionCategory = 'clean' | 'modern' | 'cinematic' | 'marketing';

export interface TransitionCategoryInfo {
  id: TransitionCategory;
  label: string;
}

export const TRANSITION_CATEGORIES: TransitionCategoryInfo[] = [
  { id: 'clean', label: 'Clean / Professional' },
  { id: 'modern', label: 'Modern / Social' },
  { id: 'cinematic', label: 'Premium / Cinematic' },
  { id: 'marketing', label: 'Marketing / Advertising' },
];

export interface TransitionPresetInfo {
  id: AnimationPreset;
  label: string;
  category: TransitionCategory;
  /** Seconds — capped to half the item's own on-screen duration by computeEntranceExit, same as every existing preset. */
  defaultDurationSeconds: number;
}

export const TRANSITION_INTENSITY_MIN = 0.5;
export const TRANSITION_INTENSITY_MAX = 2;
export const TRANSITION_INTENSITY_DEFAULT = 1;

export const TRANSITION_PRESETS: TransitionPresetInfo[] = [
  // Clean / Professional — understated, works anywhere.
  { id: 'fade', label: 'Fade', category: 'clean', defaultDurationSeconds: 0.45 },
  { id: 'slide-up', label: 'Slide Up', category: 'clean', defaultDurationSeconds: 0.45 },
  { id: 'slide-down', label: 'Slide Down', category: 'clean', defaultDurationSeconds: 0.45 },
  { id: 'slide-left', label: 'Slide Left', category: 'clean', defaultDurationSeconds: 0.45 },
  { id: 'slide-right', label: 'Slide Right', category: 'clean', defaultDurationSeconds: 0.45 },
  { id: 'dip-to-black', label: 'Dip to Black', category: 'clean', defaultDurationSeconds: 0.5 },
  { id: 'dip-to-white', label: 'Dip to White', category: 'clean', defaultDurationSeconds: 0.5 },

  // Modern / Social — punchier, built for short-form.
  { id: 'pop', label: 'Pop', category: 'modern', defaultDurationSeconds: 0.35 },
  { id: 'zoom', label: 'Zoom', category: 'modern', defaultDurationSeconds: 0.4 },
  { id: 'bounce', label: 'Bounce', category: 'modern', defaultDurationSeconds: 0.5 },
  { id: 'shake', label: 'Shake', category: 'modern', defaultDurationSeconds: 0.35 },
  { id: 'glitch', label: 'Glitch', category: 'modern', defaultDurationSeconds: 0.3 },
  { id: 'skew', label: 'Skew', category: 'modern', defaultDurationSeconds: 0.35 },
  { id: 'flip', label: 'Flip', category: 'modern', defaultDurationSeconds: 0.4 },
  { id: 'smooth-spin', label: 'Smooth Spin', category: 'modern', defaultDurationSeconds: 0.55 },

  // Premium / Cinematic — slower, softer, filmic.
  { id: 'smoke', label: 'Smoke Dissolve', category: 'cinematic', defaultDurationSeconds: 0.8 },
  { id: 'elastic', label: 'Elastic', category: 'cinematic', defaultDurationSeconds: 0.7 },
  { id: 'light-leak', label: 'Light Leak', category: 'cinematic', defaultDurationSeconds: 0.65 },
  { id: 'film-dissolve', label: 'Film Dissolve', category: 'cinematic', defaultDurationSeconds: 0.85 },
  { id: 'lens-blur', label: 'Lens Blur', category: 'cinematic', defaultDurationSeconds: 0.6 },
  { id: 'whip-pan', label: 'Whip Pan', category: 'cinematic', defaultDurationSeconds: 0.3 },
  { id: 'spin', label: 'Spin', category: 'cinematic', defaultDurationSeconds: 0.6 },
  // Templates v3 — premium build-out. All six have bespoke math in
  // `computeEntranceExit`; preview and export share that one function
  // (via `drawFrame`), so a preset can never exist in one path only.
  { id: 'cross-zoom', label: 'Cross Zoom', category: 'cinematic', defaultDurationSeconds: 0.55 },
  { id: 'mask-reveal', label: 'Mask Reveal', category: 'cinematic', defaultDurationSeconds: 0.7 },
  { id: 'luma-fade', label: 'Luma Fade', category: 'cinematic', defaultDurationSeconds: 0.7 },
  { id: 'film-burn', label: 'Film Burn', category: 'cinematic', defaultDurationSeconds: 0.6 },

  // Marketing / Advertising — attention-grabbing, energetic.
  { id: 'fire', label: 'Fire Pulse', category: 'marketing', defaultDurationSeconds: 0.4 },
  { id: 'rainbow', label: 'Rainbow Sweep', category: 'marketing', defaultDurationSeconds: 0.55 },
  { id: 'heartbeat', label: 'Heartbeat', category: 'marketing', defaultDurationSeconds: 0.5 },
  { id: 'slideSplit', label: 'Slide Split', category: 'marketing', defaultDurationSeconds: 0.45 },
  { id: 'fadeup', label: 'Fade Up', category: 'marketing', defaultDurationSeconds: 0.4 },
  { id: 'snap-zoom', label: 'Snap Zoom', category: 'marketing', defaultDurationSeconds: 0.25 },
  { id: 'flash', label: 'Flash', category: 'marketing', defaultDurationSeconds: 0.3 },
  // Templates v3 (see the cinematic block above for the shared note).
  { id: 'dip-to-gold', label: 'Dip to Gold', category: 'marketing', defaultDurationSeconds: 0.5 },
];

export function findTransitionPreset(id: AnimationPreset | undefined): TransitionPresetInfo | undefined {
  return TRANSITION_PRESETS.find((p) => p.id === id);
}

export function transitionPresetsByCategory(category: TransitionCategory): TransitionPresetInfo[] {
  return TRANSITION_PRESETS.filter((p) => p.category === category);
}
