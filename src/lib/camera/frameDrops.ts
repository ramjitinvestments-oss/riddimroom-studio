/**
 * Pure frame-drop estimation for camera recordings (R32 Phase 1).
 *
 * The browser never reports "you dropped N frames" directly, but
 * `requestVideoFrameCallback` (rVFC) reports, for every presented
 * frame, the cumulative `presentedFrames` count and the
 * `expectedDisplayTime` the frame was due. Comparing how many frames
 * were actually presented across a window against how many the
 * track's frame rate says SHOULD have been presented in that window
 * gives an honest estimate of the drops.
 *
 * The maths is pure and unit-tested here; the small tracker at the
 * bottom is the only part that touches a real <video> element, and
 * when rVFC is unavailable it reports null — the estimate is OMITTED
 * from the capture receipt, never fabricated.
 *
 * $0 rule: no dependencies, only the platform rVFC API.
 */

/** One rVFC sample, reduced to the two fields the maths needs. */
export interface VideoFrameSample {
  /** Cumulative frames presented since the video started presenting. */
  presentedFrames: number;
  /** When the frame was expected to display, in milliseconds (the same clock as `performance.now()`). */
  expectedDisplayTime: number;
}

export interface FrameDropEstimate {
  /** Frames actually presented across the sampled window. */
  presentedFrames: number;
  /** Frames the nominal frame rate says should have been presented in the window. */
  expectedFrames: number;
  /** Estimated dropped frames: max(0, expected − presented). */
  droppedFramesEstimate: number;
}

/** Reduce a raw rVFC metadata object to a `VideoFrameSample` (null when malformed). */
export function sampleFromVideoFrameMetadata(metadata: unknown): VideoFrameSample | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const { presentedFrames, expectedDisplayTime } = metadata as {
    presentedFrames?: unknown;
    expectedDisplayTime?: unknown;
  };
  if (typeof presentedFrames !== 'number' || !Number.isFinite(presentedFrames)) return null;
  if (typeof expectedDisplayTime !== 'number' || !Number.isFinite(expectedDisplayTime)) return null;
  return { presentedFrames, expectedDisplayTime };
}

/**
 * Estimate dropped frames from a chronological sample sequence.
 *
 * Only the first and last samples matter (both counters are
 * cumulative), so a long recording costs two samples, not thousands.
 * Returns null — no estimate — when an honest one cannot be made:
 * fewer than two usable samples, an unusable frame rate, a window
 * with no elapsed time, or a presented counter that went backwards
 * (the element was reloaded / the counter reset mid-recording).
 * Presented ABOVE expected is not an error (the nominal fps is an
 * ideal and clocks are approximate): the drop estimate floors at 0.
 */
export function computeFrameDropEstimate(
  samples: readonly VideoFrameSample[],
  nominalFps: number,
): FrameDropEstimate | null {
  if (typeof nominalFps !== 'number' || !Number.isFinite(nominalFps) || nominalFps <= 0) return null;
  const usable = samples.filter(
    (s) =>
      s &&
      typeof s.presentedFrames === 'number' &&
      Number.isFinite(s.presentedFrames) &&
      typeof s.expectedDisplayTime === 'number' &&
      Number.isFinite(s.expectedDisplayTime),
  );
  if (usable.length < 2) return null;
  const first = usable[0];
  const last = usable[usable.length - 1];
  const presented = last.presentedFrames - first.presentedFrames;
  if (presented < 0) return null;
  const elapsedMs = last.expectedDisplayTime - first.expectedDisplayTime;
  if (elapsedMs <= 0) return null;
  const expected = Math.round((elapsedMs / 1000) * nominalFps);
  return {
    presentedFrames: presented,
    expectedFrames: expected,
    droppedFramesEstimate: Math.max(0, expected - presented),
  };
}

/* ------------------------------------------------------------------ */
/* Review warning (R32 Phase 3)                                        */
/* ------------------------------------------------------------------ */

/**
 * Warning thresholds for the review screen. A take earns the
 * advisory when its drops exceed EITHER arm — whichever trips
 * first:
 * - RELATIVE: more than 2% of the frames that should have been
 *   presented are missing. Below 2% the gaps sit under one frame
 *   in fifty — invisible in ordinary playback; above it, motion
 *   starts to judder visibly on pans.
 * - ABSOLUTE: more than 30 dropped frames. On a long take a small
 *   percentage is still a lot of missing pictures (30 = a full
 *   second at 30fps), and on a short take the relative arm alone
 *   would let a badly stuttering few seconds through unremarked
 *   only if its expected count were tiny — the absolute arm is
 *   the floor that keeps the warning honest at any length.
 * The warning is advisory only: the take is kept either way.
 */
export const DROPPED_FRAMES_WARNING_FRACTION = 0.02;
/** Absolute drop count above which the review warning shows. */
export const DROPPED_FRAMES_WARNING_ABSOLUTE = 30;
/** The review screen's exact advisory line for a dropped-frame take. */
export const DROPPED_FRAMES_WARNING_TEXT = 'This take dropped frames — a retake may look smoother';

/**
 * Whether a drop count earns the review warning. `expected` is the
 * count the nominal frame rate predicted (the relative arm's
 * denominator); without a usable expected count only the absolute
 * arm can judge. Non-finite or negative inputs never warn.
 */
export function shouldWarnAboutDroppedFrames(
  droppedFrames: number,
  expectedFrames?: number | null,
): boolean {
  if (typeof droppedFrames !== 'number' || !Number.isFinite(droppedFrames) || droppedFrames <= 0) {
    return false;
  }
  if (droppedFrames > DROPPED_FRAMES_WARNING_ABSOLUTE) return true;
  if (
    typeof expectedFrames === 'number' &&
    Number.isFinite(expectedFrames) &&
    expectedFrames > 0 &&
    droppedFrames / expectedFrames > DROPPED_FRAMES_WARNING_FRACTION
  ) {
    return true;
  }
  return false;
}

/** The warning line for a finished estimate — null when the take is clean enough or unmeasured. */
export function droppedFramesWarning(estimate: FrameDropEstimate | null | undefined): string | null {
  if (!estimate) return null;
  return shouldWarnAboutDroppedFrames(estimate.droppedFramesEstimate, estimate.expectedFrames)
    ? DROPPED_FRAMES_WARNING_TEXT
    : null;
}

/* ------------------------------------------------------------------ */
/* Tracker (the non-pure part)                                         */
/* ------------------------------------------------------------------ */

/** The structural slice of `HTMLVideoElement` the tracker needs. */
export interface VideoFrameCallbackHost {
  requestVideoFrameCallback?: (callback: (now: number, metadata: unknown) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

export interface FrameDropTracker {
  /** True when rVFC exists on the element and sampling is live. */
  readonly available: boolean;
  /** Begin sampling the element's presented frames. Safe to call once. */
  start: (video: VideoFrameCallbackHost) => void;
  /** Stop sampling and return the estimate — null when unavailable or unmeasurable. */
  stop: () => FrameDropEstimate | null;
}

/**
 * Create a frame-drop tracker for one recording at a known nominal
 * frame rate. The tracker retains only the first and last samples
 * (the maths needs nothing else). When the element has no rVFC,
 * `available` is false and `stop()` returns null.
 */
export function createFrameDropTracker(opts: { nominalFps: number }): FrameDropTracker {
  let host: VideoFrameCallbackHost | null = null;
  let handle: number | null = null;
  let first: VideoFrameSample | null = null;
  let last: VideoFrameSample | null = null;
  let live = false;

  const onFrame = (_now: number, metadata: unknown) => {
    const sample = sampleFromVideoFrameMetadata(metadata);
    if (sample) {
      if (!first) first = sample;
      last = sample;
    }
    if (live && host && typeof host.requestVideoFrameCallback === 'function') {
      handle = host.requestVideoFrameCallback(onFrame);
    }
  };

  return {
    get available() {
      return live;
    },
    start(video: VideoFrameCallbackHost) {
      if (live) return;
      if (!video || typeof video.requestVideoFrameCallback !== 'function') return;
      host = video;
      live = true;
      handle = video.requestVideoFrameCallback(onFrame);
    },
    stop() {
      if (!live || !host) return null;
      live = false;
      if (handle !== null && typeof host.cancelVideoFrameCallback === 'function') {
        try {
          host.cancelVideoFrameCallback(handle);
        } catch {
          // Best-effort detach only — the estimate still counts.
        }
      }
      handle = null;
      host = null;
      if (!first || !last) return null;
      return computeFrameDropEstimate([first, last], opts.nominalFps);
    },
  };
}
