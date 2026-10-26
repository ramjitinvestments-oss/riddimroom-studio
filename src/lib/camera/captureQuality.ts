/**
 * Pure capture-quality logic for the live camera (R24 WS-P1/P2/P4a).
 *
 * Kept separate from `CameraCapture.tsx` so the constraint ladder, the
 * MediaRecorder bitrate tiers, the preview-mirror decision and the zoom
 * capability parsing are unit-testable without a DOM or a real camera.
 * NOT to be confused with `src/lib/promo/camera.ts`, which is the promo
 * campaign camera-tour (Ken Burns) code — unrelated.
 *
 * $0 rule: no dependencies, only the platform `getUserMedia` /
 * `MediaRecorder` APIs the component already used.
 */

export type CaptureQualityChoice = 'auto' | '4k' | 'hd';
export type CaptureFpsChoice = 60 | 30;
export type CaptureFacingMode = 'user' | 'environment';

/** One rung of the getUserMedia ladder, in try-order. */
export interface CaptureAttempt {
  constraints: MediaStreamConstraints;
  /** Targeted short side (px) of this rung. */
  shortSide: number;
  /** Ideal frame rate of this rung. */
  frameRate: number;
  /** True for the final rung — the pre-R24 permissive ideal-1080 behaviour. */
  isFallback: boolean;
}

export const CAPTURE_AUDIO_BITS_PER_SECOND = 192_000;

/**
 * Dimensions targeting a given SHORT side for a project aspect ratio —
 * e.g. 16:9 at short side 1080 -> 1920x1080, 9:16 -> 1080x1920, 1:1 ->
 * 1080x1080, 4:5 -> 1080x1350.
 */
export function dimensionsForShortSide(
  canvasWidth: number,
  canvasHeight: number,
  shortSide: number,
): { width: number; height: number; ratio: number } {
  const ratio = canvasWidth > 0 && canvasHeight > 0 ? canvasWidth / canvasHeight : 9 / 16;
  if (ratio >= 1) {
    return { width: Math.round(shortSide * ratio), height: shortSide, ratio };
  }
  return { width: shortSide, height: Math.round(shortSide / ratio), ratio };
}

function attemptFor(
  canvasWidth: number,
  canvasHeight: number,
  facingMode: CaptureFacingMode,
  shortSide: number,
  frameRate: number,
  isFallback: boolean,
): CaptureAttempt {
  const dims = dimensionsForShortSide(canvasWidth, canvasHeight, shortSide);
  return {
    shortSide,
    frameRate,
    isFallback,
    constraints: {
      video: {
        facingMode,
        // "ideal", never "exact"/"min" — a device that can't hit a rung
        // negotiates its own closest match instead of rejecting outright.
        width: { ideal: dims.width },
        height: { ideal: dims.height },
        aspectRatio: { ideal: dims.ratio },
        frameRate: { ideal: frameRate },
      },
      audio: true,
    },
  };
}

/**
 * The getUserMedia constraint ladder, in try-order (R24 WS-P1).
 *
 * - 'auto' and '4k' both start at a 2160 short side and back off
 *   2160 -> 1440 -> 1080 at the chosen frame rate (Auto = the ladder;
 *   the 4K chip just makes the flagship intent explicit).
 * - 'hd' pins the ladder to 1080 — it never asks above HD.
 * - When 60fps is chosen, the ladder backs off to 30fps at 1080 as a
 *   later rung.
 * - The LAST rung is always 1080 @ 30fps with permissive `ideal`
 *   constraints — exactly the pre-R24 behaviour — so capture ends on
 *   the historically-proven request instead of hard-failing.
 */
export function buildCaptureAttempts(opts: {
  canvasWidth: number;
  canvasHeight: number;
  facingMode: CaptureFacingMode;
  quality: CaptureQualityChoice;
  frameRate: CaptureFpsChoice;
}): CaptureAttempt[] {
  const { canvasWidth, canvasHeight, facingMode, quality, frameRate } = opts;
  const rungs: Array<{ shortSide: number; frameRate: number }> = [];

  if (quality === 'hd') {
    rungs.push({ shortSide: 1080, frameRate });
  } else {
    rungs.push({ shortSide: 2160, frameRate });
    rungs.push({ shortSide: 1440, frameRate });
    rungs.push({ shortSide: 1080, frameRate });
  }
  // Frame-rate back-off: 60fps is not universally available at HD+
  // resolutions, so a 30fps HD rung follows the chosen-fps rungs.
  if (frameRate !== 30) {
    rungs.push({ shortSide: 1080, frameRate: 30 });
  }

  return rungs.map((rung, i) =>
    attemptFor(canvasWidth, canvasHeight, facingMode, rung.shortSide, rung.frameRate, i === rungs.length - 1),
  );
}

/** Errors that mean "this rung doesn't fit — try the next one". */
export function isLadderRetryableError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'OverconstrainedError' || name === 'NotFoundError';
}

export type RecorderBitrateTier = 'uhd' | 'qhd' | 'hd';

/** Recorder bitrates for one achieved tier (R24 WS-P1). */
export function recorderBitratesForShortSide(shortSide: number): {
  tier: RecorderBitrateTier;
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
} {
  if (shortSide > 1440) {
    return { tier: 'uhd', videoBitsPerSecond: 45_000_000, audioBitsPerSecond: CAPTURE_AUDIO_BITS_PER_SECOND };
  }
  if (shortSide > 1080) {
    return { tier: 'qhd', videoBitsPerSecond: 16_000_000, audioBitsPerSecond: CAPTURE_AUDIO_BITS_PER_SECOND };
  }
  return { tier: 'hd', videoBitsPerSecond: 10_000_000, audioBitsPerSecond: CAPTURE_AUDIO_BITS_PER_SECOND };
}

/**
 * MediaRecorder options for the stream actually negotiated. The tier
 * comes from the video track's reported settings (`getSettings()`),
 * i.e. what the device really gave us — not what we asked for. Unknown
 * dimensions (no settings yet) fall back to the HD tier.
 */
export function recorderOptionsForTrackSettings(
  settings: { width?: number; height?: number } | null | undefined,
  mimeType?: string,
): MediaRecorderOptions {
  const width = settings?.width ?? 0;
  const height = settings?.height ?? 0;
  const shortSide = width > 0 && height > 0 ? Math.min(width, height) : 0;
  const { videoBitsPerSecond, audioBitsPerSecond } = recorderBitratesForShortSide(shortSide);
  const options: MediaRecorderOptions = { videoBitsPerSecond, audioBitsPerSecond };
  if (mimeType) options.mimeType = mimeType;
  return options;
}

/**
 * Preview-mirror decision (R24 WS-P2): ONLY the front ('user') camera's
 * LIVE preview is mirrored, matching phone-camera convention so the
 * user's movement matches the screen. The recorded stream/file is never
 * transformed — the mirror is a CSS transform on the preview element
 * only — and the review screen shows the saved file as-is.
 */
export function isPreviewMirrored(facingMode: CaptureFacingMode): boolean {
  return facingMode === 'user';
}

export function previewMirrorTransform(facingMode: CaptureFacingMode): 'scaleX(-1)' | 'none' {
  return isPreviewMirrored(facingMode) ? 'scaleX(-1)' : 'none';
}

export interface ZoomCapability {
  min: number;
  max: number;
  step: number;
}

/**
 * Parse a track's `zoom` capability (R24 WS-P4a). Chrome/Android expose
 * `getCapabilities().zoom = { min, max, step }`; iOS Safari exposes no
 * track zoom at all — this returns null there (and for any malformed
 * shape), and the UI renders NO zoom control in that case.
 */
export function zoomCapabilityFromCapabilities(capabilities: unknown): ZoomCapability | null {
  if (!capabilities || typeof capabilities !== 'object') return null;
  const zoom = (capabilities as { zoom?: unknown }).zoom;
  if (!zoom || typeof zoom !== 'object') return null;
  const { min, max, step } = zoom as { min?: unknown; max?: unknown; step?: unknown };
  if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return null;
  }
  return { min, max, step: typeof step === 'number' && Number.isFinite(step) && step > 0 ? step : 0.1 };
}
