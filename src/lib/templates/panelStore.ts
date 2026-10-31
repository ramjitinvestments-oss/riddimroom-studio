/**
 * R40 Phase 2 (P-06) — ONE shared Templates-panel store.
 *
 * EditorShell mounts `TemplatesPanel` in two places (the Step-1 aside
 * and the Step-2 panel group) and renders steps conditionally, so the
 * Step-1 mount unmounts when the user moves to Step 2 and vice versa.
 * When every piece of panel state lived in the component, that unmount
 * lost the applied-template marker, any unfinished Adjust/Reframe
 * step, the focused card / chip / strip scroll, and the own-media
 * preview cache — previews were rendered (and waited for) twice.
 *
 * This module is the panel's memory, held OUTSIDE the component:
 * both mounts read and write the same store, and exactly one mount is
 * live at a time (as before — this is shared state, not a second
 * mount). The preview cache, scheduler and render jobs live here too,
 * so a preview rendered in Step 1 is the one Step 2 shows.
 *
 * Scoping: the store belongs to ONE project. `ensureTemplatesPanelProject`
 * resets it whenever a different project opens, so one project's
 * applied marker can never leak into another's editor.
 */
import type { Project } from '../../types/timeline';
import type { StudioTemplate } from '../templates';
import type { ShortenedClipInfo } from './apply';
import type { ReelChip } from './reelMeta';
import {
  createPreviewCache,
  createPreviewScheduler,
  type PreviewCache,
  type PreviewScheduler,
} from './reelPreview';

export interface TemplatesPanelState {
  /** The project this state belongs to (null = no editor bound yet). */
  projectId: string | null;
  /** The template the user applied most recently — shown as applied. */
  appliedId: string | null;
  chip: ReelChip;
  focusedId: string | null;
  /** Post-apply "Adjust clips" step (shortened videos), if open. */
  pendingAdjust: ShortenedClipInfo[] | null;
  adjustTargetId: string | null;
  /** Post-apply "Reframe clips" step (frame-cropped items), if open. */
  pendingFramed: ShortenedClipInfo[] | null;
  reframeTargetId: string | null;
  /** Id of the template whose frame-choice prompt is open, if any. */
  framePromptId: string | null;
  error: string | null;
  notice: string | null;
  /** Id of the template currently being applied, if any. */
  busyId: string | null;
}

export function initialTemplatesPanelState(projectId: string | null): TemplatesPanelState {
  return {
    projectId,
    appliedId: null,
    chip: 'all',
    focusedId: null,
    pendingAdjust: null,
    adjustTargetId: null,
    pendingFramed: null,
    reframeTargetId: null,
    framePromptId: null,
    error: null,
    notice: null,
    busyId: null,
  };
}

// ---------------------------------------------------------------------------
// Panel state (reactive — consumed via useSyncExternalStore)
// ---------------------------------------------------------------------------

let state: TemplatesPanelState = initialTemplatesPanelState(null);
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

export function getTemplatesPanelState(): TemplatesPanelState {
  return state;
}

export function subscribeTemplatesPanelState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function updateTemplatesPanelState(patch: Partial<TemplatesPanelState>): void {
  state = { ...state, ...patch };
  notify();
}

// ---------------------------------------------------------------------------
// Preview cache / scheduler / jobs (shared, so previews render once)
// ---------------------------------------------------------------------------

export interface PreviewJob {
  project: Project;
  template: StudioTemplate;
  currentTime: number;
}

let previewCache: PreviewCache<HTMLCanvasElement[]> = createPreviewCache<HTMLCanvasElement[]>(12);
let previewScheduler: PreviewScheduler<HTMLCanvasElement[]> | null = null;
let previewJobs = new Map<string, PreviewJob>();

export function getPreviewCache(): PreviewCache<HTMLCanvasElement[]> {
  return previewCache;
}

export function getPreviewJobs(): Map<string, PreviewJob> {
  return previewJobs;
}

/**
 * The one scheduler both mounts share. The render function is supplied
 * by the first mount that needs it; later mounts reuse the scheduler
 * (and its cache) instead of building their own.
 */
export function getOrCreatePreviewScheduler(
  render: (key: string) => Promise<HTMLCanvasElement[] | null>,
): PreviewScheduler<HTMLCanvasElement[]> {
  if (!previewScheduler) {
    previewScheduler = createPreviewScheduler<HTMLCanvasElement[]>(render, previewCache);
  }
  return previewScheduler;
}

// ---------------------------------------------------------------------------
// Strip scroll position (plain value — saved/restored by the mounts,
// deliberately NOT part of the reactive state: it changes on every
// scroll frame and no render depends on it)
// ---------------------------------------------------------------------------

let stripScrollLeft = 0;

export function getTemplatesPanelScrollLeft(): number {
  return stripScrollLeft;
}

export function setTemplatesPanelScrollLeft(value: number): void {
  stripScrollLeft = Number.isFinite(value) && value > 0 ? value : 0;
}

// ---------------------------------------------------------------------------
// Project scoping + test reset
// ---------------------------------------------------------------------------

/**
 * Binds the store to a project: same project = state untouched (this
 * is what makes a Step 1 → Step 2 round trip keep everything);
 * a different project = a clean store, cache included, so nothing
 * from the previous project can show up in this one's editor.
 */
export function ensureTemplatesPanelProject(projectId: string): void {
  if (state.projectId === projectId) return;
  state = initialTemplatesPanelState(projectId);
  previewCache = createPreviewCache<HTMLCanvasElement[]>(12);
  previewScheduler = null;
  previewJobs = new Map<string, PreviewJob>();
  stripScrollLeft = 0;
  notify();
}

/** Test helper: back to the never-opened state. */
export function resetTemplatesPanelStore(): void {
  state = initialTemplatesPanelState(null);
  previewCache = createPreviewCache<HTMLCanvasElement[]>(12);
  previewScheduler = null;
  previewJobs = new Map<string, PreviewJob>();
  stripScrollLeft = 0;
  notify();
}
