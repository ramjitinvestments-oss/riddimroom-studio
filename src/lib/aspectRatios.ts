/**
 * RiddimRoom Studio — the single source of truth for aspect ratio.
 *
 * "Final production fix" spec item 1: expose exactly four aspect-ratio
 * options, chosen once at project creation (`Dashboard.tsx`'s new-project
 * picker), and let everything downstream — the compositor, the live
 * preview's responsive sizing, the export renderer, and every position/
 * scale percentage calculation — derive from `Project.canvasWidth`/
 * `canvasHeight` alone. Those two fields already flow through the whole
 * render path (`compositor.ts`, `PreviewPane.tsx`, `canvas2dRenderer.ts`)
 * because positioning is percentage-based, not pixel-based — so this file
 * intentionally does NOT introduce a parallel "ratio" enum/state that
 * would need to be kept in sync with width/height. It's just the ordered
 * list of the four choices the picker shows, plus a lookup so any part of
 * the UI that wants to show a human name for an existing project's
 * dimensions (e.g. a "16:9 Landscape" label) can derive it from
 * width/height instead of guessing.
 */

export interface AspectRatioOption {
  /** Stable id, also usable as a React key. */
  id: '16:9' | '9:16' | '1:1' | '4:5';
  ratioLabel: string;
  name: string;
  useCases: string[];
  canvasWidth: number;
  canvasHeight: number;
}

export const ASPECT_RATIO_OPTIONS: AspectRatioOption[] = [
  {
    id: '16:9',
    ratioLabel: '16:9',
    name: 'Landscape',
    useCases: ['YouTube', 'Desktop video', 'Standard landscape advertising'],
    canvasWidth: 1920,
    canvasHeight: 1080,
  },
  {
    id: '9:16',
    ratioLabel: '9:16',
    name: 'Vertical',
    useCases: ['TikTok', 'Instagram Reels', 'YouTube Shorts', 'Mobile-first advertising'],
    canvasWidth: 1080,
    canvasHeight: 1920,
  },
  {
    id: '1:1',
    ratioLabel: '1:1',
    name: 'Square',
    useCases: ['Instagram / Facebook feed', 'Square promotional content'],
    canvasWidth: 1080,
    canvasHeight: 1080,
  },
  {
    id: '4:5',
    ratioLabel: '4:5',
    name: 'Portrait',
    useCases: ['Instagram / Facebook feed', 'High-performing vertical feed advertising'],
    canvasWidth: 1080,
    canvasHeight: 1350,
  },
];

/** The default when nothing else is specified (matches the app's historical default — 9:16 Vertical). */
export const DEFAULT_ASPECT_RATIO = ASPECT_RATIO_OPTIONS[1];

/**
 * Finds the matching preset for an existing project's dimensions, for
 * display purposes (e.g. a project-card label). Returns null for a
 * project whose dimensions don't exactly match one of the 4 presets
 * (possible for projects created before this feature existed, or via
 * direct Firestore edits) — callers should fall back to showing the raw
 * `W×H` in that case rather than guessing a nearest match.
 */
export function findAspectRatioOption(canvasWidth: number, canvasHeight: number): AspectRatioOption | null {
  return ASPECT_RATIO_OPTIONS.find((o) => o.canvasWidth === canvasWidth && o.canvasHeight === canvasHeight) ?? null;
}
