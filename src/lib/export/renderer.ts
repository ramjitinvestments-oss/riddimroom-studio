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
import type { ResolvedExportSettings } from './quality';

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
  /**
   * Resolved export-quality settings (see lib/export/quality.ts). When
   * present, the renderer honors them exactly: canvas/output dimensions,
   * capture-stream frame rate, and recorder bitrates. When absent, the
   * renderer falls back to the project's own canvas size and frame rate
   * with browser-default recorder bitrates — the pre-picker behavior.
   */
  output?: ResolvedExportSettings;
}

/**
 * Optional facts about how a render was produced, when the renderer
 * knows them (Pre-live build 2). Purely additive: renderers that have
 * nothing to report omit it, and callers must not require it.
 */
export interface RenderResultMetadata {
  /** Engine that produced the file ('ffmpeg' pipeline stage vs 'mediabunny'). */
  engine?: string;
  /** Container-level video codec family actually encoded (e.g. 'avc'). */
  videoCodec?: string;
  /** Full WebCodecs codec string the encoder negotiated (e.g. 'avc1.640028'). */
  videoCodecString?: string;
  /** Audio codec actually encoded (e.g. 'aac', 'opus'), or null when the output has no audio track. */
  audioCodec?: string | null;
  /** Full WebCodecs codec string for the audio encoder (e.g. 'mp4a.40.2', 'opus'). */
  audioCodecString?: string;
}

export interface RenderResult {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
  metadata?: RenderResultMetadata;
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
