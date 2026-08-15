/**
 * RiddimRoom Studio — export renderer abstraction (Phase 1 Step 12).
 *
 * Per the explicit requirement not to lock the product into one
 * irreversible rendering architecture: every export path implements this
 * interface. `Canvas2DRenderer` (client-side, browser Canvas2D +
 * MediaRecorder — the same technique all three legacy apps already used,
 * per the implementation roadmap) is the current practical implementation.
 * A future server-side Cloud Run renderer (the roadmap's "Risks" section
 * flags this as its own unmade architectural decision) would implement the
 * same interface — callers (`ExportPanel`) depend only on this contract,
 * never on Canvas2D/MediaRecorder specifics directly.
 */

import type { Project } from '../../types/timeline';

export interface RenderProgress {
  /** 0-1. */
  fraction: number;
  /** Seconds of output rendered so far. */
  renderedSeconds: number;
  /** Total seconds this export will produce. */
  totalSeconds: number;
}

export interface RenderOptions {
  onProgress?: (progress: RenderProgress) => void;
  signal?: AbortSignal;
}

export interface RenderResult {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
}

export interface Renderer {
  readonly name: string;
  render(project: Project, options?: RenderOptions): Promise<RenderResult>;
}

export class RenderAbortedError extends Error {
  constructor() {
    super('Export was cancelled.');
    this.name = 'RenderAbortedError';
  }
}
