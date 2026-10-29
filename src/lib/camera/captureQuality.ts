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

/**
 * Recorder bitrate table (R32 Phase 1 — fps-aware).
 *
 * `at30` is the EXACT R24 table, keyed by resolution short side only;
 * at 30fps (and below, and for any unusable fps value) the returned
 * values are byte-identical to R24, so 30fps behaviour never moves.
 * `at60` is the same tier at 60fps: roughly 1.75–1.8× the 30fps value
 * — 60fps carries twice the frames but inter-frame redundancy means
 * twice the bitrate is waste; ~1.75× is the sane premium point, and
 * the absolute values double as caps (nothing is offered above them).
 * Between 30 and 60 the bitrate interpolates linearly; above 60 it
 * stays at the 60fps cap.
 */
const RECORDER_BITRATE_TABLE: Record<RecorderBitrateTier, { at30: number; at60: number }> = {
  uhd: { at30: 45_000_000, at60: 80_000_000 },
  qhd: { at30: 16_000_000, at60: 28_000_000 },
  hd: { at30: 10_000_000, at60: 18_000_000 },
};

export function recorderTierForShortSide(shortSide: number): RecorderBitrateTier {
  if (shortSide > 1440) return 'uhd';
  if (shortSide > 1080) return 'qhd';
  return 'hd';
}

/** Recorder bitrates for one achieved tier at one frame rate. */
export function recorderBitratesForShortSide(
  shortSide: number,
  fps: number = 30,
): {
  tier: RecorderBitrateTier;
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
} {
  const tier = recorderTierForShortSide(shortSide);
  const { at30, at60 } = RECORDER_BITRATE_TABLE[tier];
  const usableFps = typeof fps === 'number' && Number.isFinite(fps) && fps > 0 ? fps : 30;
  const t = Math.min(Math.max((usableFps - 30) / 30, 0), 1);
  const videoBitsPerSecond = Math.round(at30 + (at60 - at30) * t);
  return { tier, videoBitsPerSecond, audioBitsPerSecond: CAPTURE_AUDIO_BITS_PER_SECOND };
}

/**
 * MediaRecorder options for the stream actually negotiated. The tier
 * comes from the video track's reported settings (`getSettings()`),
 * i.e. what the device really gave us — not what we asked for. Unknown
 * dimensions (no settings yet) fall back to the HD tier. The frame
 * rate likewise comes from the track's reported `frameRate` when the
 * settings carry one; an explicit `fps` argument wins over both.
 */
export function recorderOptionsForTrackSettings(
  settings: { width?: number; height?: number; frameRate?: number } | null | undefined,
  mimeType?: string,
  fps?: number,
): MediaRecorderOptions {
  const width = settings?.width ?? 0;
  const height = settings?.height ?? 0;
  const shortSide = width > 0 && height > 0 ? Math.min(width, height) : 0;
  const effectiveFps = fps ?? (typeof settings?.frameRate === 'number' ? settings.frameRate : undefined);
  const { videoBitsPerSecond, audioBitsPerSecond } = recorderBitratesForShortSide(shortSide, effectiveFps);
  const options: MediaRecorderOptions = { videoBitsPerSecond, audioBitsPerSecond };
  if (mimeType) options.mimeType = mimeType;
  return options;
}

/* ------------------------------------------------------------------ */
/* Codec ladder (R32 Phase 1)                                          */
/* ------------------------------------------------------------------ */

/**
 * The MediaRecorder mimeType preference ladder, in try-order.
 *
 * MP4/H.264 comes FIRST: on Android (the owner's device class) H.264
 * is encoded in hardware, which means smoother capture and fewer
 * dropped frames at the same resolution than a software VP9 encode
 * competing with the camera pipeline for CPU. VP9 WebM follows (best
 * WebM quality where the device can sustain it), then VP8 WebM (the
 * widely-supported software fallback), then bare WebM, then `''` —
 * the browser's own default, used when nothing above is supported.
 */
export const RECORDER_MIME_LADDER: readonly string[] = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  '',
];

/**
 * Pick the best recorder mimeType the platform supports, walking
 * `RECORDER_MIME_LADDER` in order. `isTypeSupported` is injected so
 * the ladder is unit-testable with a fake predicate. A predicate that
 * throws on a candidate counts as "not supported" for that candidate.
 * Returns `''` (browser default) when no explicit type is supported.
 */
export function pickRecorderMimeType(isTypeSupported: (mimeType: string) => boolean): string {
  for (const candidate of RECORDER_MIME_LADDER) {
    if (candidate === '') return '';
    let supported = false;
    try {
      supported = isTypeSupported(candidate);
    } catch {
      supported = false;
    }
    if (supported) return candidate;
  }
  return '';
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
