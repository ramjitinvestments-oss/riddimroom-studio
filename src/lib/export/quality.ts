/**
 * RiddimRoom Studio — export quality settings (Phase 2.1).
 *
 * The user-facing Export picker (Resolution / Frame rate / Quality) is
 * resolved here — purely, no DOM — into the concrete numbers the two
 * export stages actually consume:
 *
 *  - `Canvas2DRenderer`: canvas width/height (it draws in project
 *    coordinates under a base scale transform, so these are the real
 *    output pixel dimensions), `captureStream(frameRate)`, and
 *    MediaRecorder's `videoBitsPerSecond` / `audioBitsPerSecond`.
 *  - `transcodeWebmToMp4` (ffmpeg.wasm): the same frame rate (`-r`), a
 *    CRF for libx264, and the AAC audio bitrate.
 *
 * Nothing here is decorative: every resolved value is passed to a real
 * encoder knob in one of those two stages. Defaults reproduce the
 * pre-picker behavior — native project dimensions, the project's own
 * frame rate, and the "high" tier, whose CRF (20) and audio bitrate
 * (192k) are exactly what the transcoder used before this picker existed.
 */

export type ExportResolutionId = 'native' | '1080p' | '720p' | '480p';
export type ExportQualityTier = 'high' | 'medium' | 'low';

export interface ExportSettingsSelection {
  resolution: ExportResolutionId;
  /** Frames per second — the project's own rate is the default (see ExportPanel). */
  frameRate: number;
  quality: ExportQualityTier;
}

export interface ResolvedExportSettings {
  width: number;
  height: number;
  frameRate: number;
  /** MediaRecorder video bitrate (bits/second) for the recording stage. */
  videoBitsPerSecond: number;
  /** Audio bitrate (bits/second) — MediaRecorder stage and, /1000, the AAC `-b:a` in the MP4 stage. */
  audioBitsPerSecond: number;
  /** libx264 CRF for the MP4 transcode stage (lower = higher quality). */
  crf: number;
}

export const EXPORT_RESOLUTIONS: { id: ExportResolutionId; label: string }[] = [
  { id: 'native', label: 'Native' },
  { id: '1080p', label: '1080p' },
  { id: '720p', label: '720p' },
  { id: '480p', label: '480p' },
];

export const EXPORT_FRAME_RATES: number[] = [24, 30, 60];

export const EXPORT_QUALITY_TIERS: { id: ExportQualityTier; label: string; description: string }[] = [
  { id: 'high', label: 'High', description: 'Best picture, larger file' },
  { id: 'medium', label: 'Medium', description: 'Balanced size and quality' },
  { id: 'low', label: 'Low', description: 'Smallest file, softer picture' },
];

/** Short-edge pixel target per non-native resolution ('1080p' = a 1080px short edge, either orientation). */
const RESOLUTION_SHORT_EDGE: Record<Exclude<ExportResolutionId, 'native'>, number> = {
  '1080p': 1080,
  '720p': 720,
  '480p': 480,
};

interface QualityTierSpec {
  crf: number;
  audioBitrateKbps: number;
  /** Video bitrate (Mbps) for a 1080p30-equivalent pixel/frame load; scaled by load below. */
  baseVideoMbps: number;
}

const QUALITY_TIER_SPECS: Record<ExportQualityTier, QualityTierSpec> = {
  // crf 20 / 192k are the exact values the MP4 transcoder hardcoded
  // before this picker existed — "High" is the old behavior, not a new
  // invention.
  high: { crf: 20, audioBitrateKbps: 192, baseVideoMbps: 12 },
  medium: { crf: 24, audioBitrateKbps: 128, baseVideoMbps: 7.5 },
  low: { crf: 28, audioBitrateKbps: 96, baseVideoMbps: 4 },
};

const REFERENCE_PIXELS = 1920 * 1080;
const REFERENCE_FPS = 30;

function evenDimension(n: number): number {
  // H.264 + yuv420p (the MP4 stage) requires even dimensions.
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * Output dimensions for a resolution choice. Non-native resolutions scale
 * the project so its SHORT edge matches the preset (1080p of a 9:16
 * project is 1080×1920, of a 16:9 project 1920×1080) and NEVER upscale —
 * asking for 1080p from a 720p project yields the native size, which the
 * picker surfaces by disabling that option rather than pretending.
 */
export function resolveExportDimensions(
  canvasWidth: number,
  canvasHeight: number,
  resolution: ExportResolutionId,
): { width: number; height: number } {
  if (resolution === 'native') return { width: canvasWidth, height: canvasHeight };
  const target = RESOLUTION_SHORT_EDGE[resolution];
  const shortEdge = Math.min(canvasWidth, canvasHeight);
  const scale = Math.min(1, target / shortEdge);
  if (scale >= 1) return { width: canvasWidth, height: canvasHeight };
  return { width: evenDimension(canvasWidth * scale), height: evenDimension(canvasHeight * scale) };
}

export function resolveExportSettings(
  canvasWidth: number,
  canvasHeight: number,
  selection: ExportSettingsSelection,
): ResolvedExportSettings {
  const { width, height } = resolveExportDimensions(canvasWidth, canvasHeight, selection.resolution);
  const spec = QUALITY_TIER_SPECS[selection.quality];
  const fps = Number.isFinite(selection.frameRate) && selection.frameRate > 0 ? Math.round(selection.frameRate) : 30;

  const pixelLoad = (width * height) / REFERENCE_PIXELS;
  const fpsLoad = Math.min(2, Math.max(0.75, fps / REFERENCE_FPS));
  const rawBits = spec.baseVideoMbps * 1_000_000 * pixelLoad * fpsLoad;
  const videoBitsPerSecond = Math.min(20_000_000, Math.max(500_000, Math.round(rawBits / 100_000) * 100_000));

  return {
    width,
    height,
    frameRate: fps,
    videoBitsPerSecond,
    audioBitsPerSecond: spec.audioBitrateKbps * 1000,
    crf: spec.crf,
  };
}
