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

/* ------------------------------------------------------------------ */
/* R41 WS-B — two-stage negotiation (AUDIT F01)                        */
/*                                                                     */
/* Stage 1 is the existing ideal ask, byte-identical semantics. After  */
/* the stream settles, the granted track settings are read back; when */
/* the grant is BELOW the asked rung (short side or frame rate), ONE  */
/* exact-constraint retry of that same rung is attempted. The stage-1  */
/* stream is never stopped until a better-or-equal exact stream is in */
/* hand: if the exact attempt throws, or grants less, the exact       */
/* stream (if any) is discarded and the stage-1 stream is kept. At    */
/* most one exact retry per rung, only at stream setup — never during */
/* a recording (the R36 mid-take gating is untouched).                */
/* ------------------------------------------------------------------ */

/** The structural slice of a track's settings the negotiation reads. */
export interface GrantedTrackSettings {
  width?: number;
  height?: number;
  frameRate?: number;
}

/** The short side actually granted (0 when the settings carry no usable size). */
export function grantedShortSide(settings: GrantedTrackSettings | null | undefined): number {
  const width = settings?.width;
  const height = settings?.height;
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return 0;
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return 0;
  return Math.min(width, height);
}

/**
 * The frame rate actually granted, ROUNDED (0 when unknown). Rounding
 * is deliberate: a 59.94 grant against a 60 ask is a 60 grant, not a
 * shortfall worth an exact retry.
 */
export function grantedFps(settings: GrantedTrackSettings | null | undefined): number {
  const fps = settings?.frameRate;
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) return 0;
  return Math.round(fps);
}

export interface NegotiationDecision {
  /** True when the grant fell below the asked rung and the one exact retry should run. */
  needsExactRetry: boolean;
  grantedShortSide: number;
  grantedFps: number;
  /** Which dimensions fell below the ask ('resolution' and/or 'frameRate'); empty when the grant met the ask or could not be read. */
  belowOn: Array<'resolution' | 'frameRate'>;
}

/**
 * Decide, from one rung's asked target and the settings the browser
 * actually granted, whether the stage-2 exact retry runs. A grant
 * that cannot be read (no usable size) never triggers a retry — there
 * is nothing to compare, and disturbing a working stream on a guess
 * is exactly what this fix must not do.
 */
export function negotiationDecision(
  asked: { shortSide: number; frameRate: number },
  granted: GrantedTrackSettings | null | undefined,
): NegotiationDecision {
  const short = grantedShortSide(granted);
  const fps = grantedFps(granted);
  const belowOn: NegotiationDecision['belowOn'] = [];
  if (short > 0 && short < asked.shortSide) belowOn.push('resolution');
  if (fps > 0 && fps < asked.frameRate) belowOn.push('frameRate');
  return { needsExactRetry: belowOn.length > 0, grantedShortSide: short, grantedFps: fps, belowOn };
}

/** True when the grant is below the asked rung on resolution or frame rate (readable grants only). */
export function isGrantBelowAsk(
  asked: { shortSide: number; frameRate: number },
  granted: GrantedTrackSettings | null | undefined,
): boolean {
  return negotiationDecision(asked, granted).needsExactRetry;
}

/**
 * The stage-2 twin of one ladder rung: the SAME width/height/frame
 * rate the rung asked for ideally, now asked EXACTLY. Facing mode,
 * the project-aspect request and the audio flag are carried over
 * unchanged — only the three negotiated dimensions change form.
 */
export function buildExactAttempt(attempt: CaptureAttempt): CaptureAttempt {
  const video = (attempt.constraints.video ?? {}) as MediaTrackConstraints;
  const idealOf = (c: ConstrainDouble | undefined): number | undefined =>
    c && typeof c === 'object' && typeof (c as { ideal?: unknown }).ideal === 'number'
      ? ((c as { ideal: number }).ideal as number)
      : undefined;
  const width = idealOf(video.width as ConstrainDouble | undefined);
  const height = idealOf(video.height as ConstrainDouble | undefined);
  const exactVideo: MediaTrackConstraints = { frameRate: { exact: attempt.frameRate } };
  if (typeof video.facingMode === 'string' || (video.facingMode && typeof video.facingMode === 'object')) {
    exactVideo.facingMode = video.facingMode;
  }
  if (width !== undefined) exactVideo.width = { exact: width };
  if (height !== undefined) exactVideo.height = { exact: height };
  if (video.aspectRatio) exactVideo.aspectRatio = video.aspectRatio;
  return {
    shortSide: attempt.shortSide,
    frameRate: attempt.frameRate,
    isFallback: attempt.isFallback,
    constraints: { video: exactVideo, audio: attempt.constraints.audio },
  };
}

/**
 * Whether an exact retry's grant is WORSE than the stage-1 grant it
 * would replace. Compared resolution-first, then frame rate: a retry
 * that trades resolution away is worse even if its frame rate rose.
 * An unreadable exact grant counts as worse — never swap a known
 * stream for an unknown one.
 */
export function isExactGrantWorse(
  stage1Granted: GrantedTrackSettings | null | undefined,
  exactGranted: GrantedTrackSettings | null | undefined,
): boolean {
  const exactShort = grantedShortSide(exactGranted);
  if (exactShort <= 0) return true;
  const stage1Short = grantedShortSide(stage1Granted);
  if (exactShort !== stage1Short) return exactShort < stage1Short;
  return grantedFps(exactGranted) < grantedFps(stage1Granted);
}

export interface NegotiatedStream {
  /** The stream to use: the exact-retry stream when it won, otherwise the untouched stage-1 stream. */
  stream: MediaStream;
  /** The final granted settings (of whichever stream won). */
  grantedSettings: GrantedTrackSettings | null;
  /** The granted settings of the stage-1 (ideal) stream, before any retry. */
  stage1Settings: GrantedTrackSettings | null;
  /** True when the one exact retry was attempted (whether it won or not). */
  exactRetried: boolean;
  /** True when the returned stream IS the exact-retry stream. */
  usedExact: boolean;
  /** The platform error name of a failed exact attempt, when it threw. */
  exactErrorName?: string;
}

function stopStreamTracks(stream: MediaStream | null | undefined): void {
  try {
    stream?.getTracks().forEach((track) => track.stop());
  } catch {
    // Cleanup is best-effort — it must never mask the negotiation result.
  }
}

function defaultReadSettings(stream: MediaStream): GrantedTrackSettings | null {
  try {
    const track = stream.getVideoTracks()[0];
    if (!track?.getSettings) return null;
    const s = track.getSettings() as GrantedTrackSettings;
    return { width: s.width, height: s.height, frameRate: s.frameRate };
  } catch {
    return null;
  }
}

/**
 * Run the two-stage negotiation for ONE ladder rung, with the
 * platform calls behind injectable seams (the component passes the
 * real `getUserMedia`; tests pass fakes).
 *
 * - Stage 1: `getUserMedia(attempt.constraints)` — if THIS throws,
 *   the error propagates untouched so the caller's ladder walk keeps
 *   its existing retryable/fatal semantics.
 * - Read-back: granted settings via `readSettings` (default: the
 *   video track's `getSettings()`).
 * - Grant meets the ask → the stage-1 stream is returned, no retry.
 * - Grant below the ask → ONE exact retry. The stage-1 stream stays
 *   alive while the exact stream is opened; only a better-or-equal
 *   exact grant replaces it (the stage-1 tracks are then stopped).
 *   A throw, or a worse grant, keeps the stage-1 stream exactly as
 *   it was.
 */
export async function negotiateStreamAttempt(opts: {
  attempt: CaptureAttempt;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readSettings?: (stream: MediaStream) => GrantedTrackSettings | null;
}): Promise<NegotiatedStream> {
  const readSettings = opts.readSettings ?? defaultReadSettings;
  const stream = await opts.getUserMedia(opts.attempt.constraints);
  const stage1Settings = readSettings(stream);
  const decision = negotiationDecision(
    { shortSide: opts.attempt.shortSide, frameRate: opts.attempt.frameRate },
    stage1Settings,
  );
  if (!decision.needsExactRetry) {
    return { stream, grantedSettings: stage1Settings, stage1Settings, exactRetried: false, usedExact: false };
  }
  let exactStream: MediaStream;
  try {
    exactStream = await opts.getUserMedia(buildExactAttempt(opts.attempt).constraints);
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    return {
      stream,
      grantedSettings: stage1Settings,
      stage1Settings,
      exactRetried: true,
      usedExact: false,
      ...(name ? { exactErrorName: name } : {}),
    };
  }
  const exactSettings = readSettings(exactStream);
  if (isExactGrantWorse(stage1Settings, exactSettings)) {
    stopStreamTracks(exactStream);
    return { stream, grantedSettings: stage1Settings, stage1Settings, exactRetried: true, usedExact: false };
  }
  stopStreamTracks(stream);
  return { stream: exactStream, grantedSettings: exactSettings, stage1Settings, exactRetried: true, usedExact: true };
}

/* ------------------------------------------------------------------ */
/* R41 WS-A — census-shaped ladder                                     */
/*                                                                     */
/* When a per-facing capability census exists (deviceProfile), the    */
/* ladder's FIRST rung is shaped by what the phone was measured to    */
/* offer: the target stays 4K / the chosen frame rate, capped at the  */
/* census maximums, so the app stops opening with an ask this         */
/* browser has already proven it cannot grant. The remaining rungs    */
/* are the existing ladder's lower rungs. Without a census — and for  */
/* the user-pinned HD choice, which a census never overrides — the    */
/* ladder is the existing generic one, unchanged. No rung ever asks   */
/* above 2160 short side or above the chosen frame rate, and the      */
/* chosen frame rate is itself never raised.                          */
/* ------------------------------------------------------------------ */

/** The structural slice of a facing census the ladder shaping needs. */
export interface CensusRangeLike {
  widthMax: number;
  heightMax: number;
  frameRateMax: number;
}

/** The largest short side a census says this facing can grant (0 when unreadable). */
export function censusMaxShortSide(census: CensusRangeLike | null | undefined): number {
  if (!census) return 0;
  const w = census.widthMax;
  const h = census.heightMax;
  if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) return 0;
  if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0) return 0;
  return Math.min(w, h);
}

/**
 * The capture ladder shaped by a facing census (see the section
 * header). Returns the plain `buildCaptureAttempts` ladder unchanged
 * when there is no usable census, when the census does not cap the
 * opening rung, or when the user pinned HD.
 */
export function buildCensusAwareAttempts(
  opts: {
    canvasWidth: number;
    canvasHeight: number;
    facingMode: CaptureFacingMode;
    quality: CaptureQualityChoice;
    frameRate: CaptureFpsChoice;
  },
  census: CensusRangeLike | null | undefined,
): CaptureAttempt[] {
  const base = buildCaptureAttempts(opts);
  if (!census || opts.quality === 'hd') return base;
  const capShort = censusMaxShortSide(census);
  const capFps =
    typeof census.frameRateMax === 'number' && Number.isFinite(census.frameRateMax) && census.frameRateMax > 0
      ? Math.floor(census.frameRateMax)
      : 0;
  if (capShort <= 0 && capFps <= 0) return base;
  const first = base[0];
  if (!first) return base;
  const shapedShort = capShort > 0 ? Math.min(first.shortSide, capShort) : first.shortSide;
  const shapedFps = capFps > 0 ? Math.min(first.frameRate, capFps) : first.frameRate;
  if (shapedShort === first.shortSide && shapedFps === first.frameRate) return base;
  const shaped = attemptFor(opts.canvasWidth, opts.canvasHeight, opts.facingMode, shapedShort, shapedFps, false);
  const rest = base.filter(
    (rung) =>
      rung.shortSide < shapedShort || (rung.shortSide === shapedShort && rung.frameRate < shapedFps),
  );
  const rungs = [shaped, ...rest];
  return rungs.map((rung, i) => ({ ...rung, isFallback: i === rungs.length - 1 }));
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
