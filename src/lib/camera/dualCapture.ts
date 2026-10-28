/**
 * Pure dual-camera capture logic for R29 — one-button recording with
 * BOTH cameras at once (rear/main + front PiP).
 *
 * Kept separate from the capture component so the stepped-down
 * constraint ladders, the dual-camera availability probe and the
 * start-alignment maths are unit-testable without a DOM or real
 * cameras — same split as `captureQuality.ts` (R24), which this
 * module builds on and never duplicates.
 *
 * WHY dual capture needs its own ladders: running two camera streams
 * at once is the most demanding thing `getUserMedia` can be asked to
 * do. A phone that happily gives a single camera 4K may refuse, kill
 * or silently mute one stream when a second camera opens — especially
 * at high resolution / frame rate. So dual capture deliberately asks
 * for LESS than single capture: every rear rung is stepped one
 * resolution tier down from the R24 ladder, and the front camera
 * (a small PiP overlay, where detail matters least) is capped at
 * 1080 with a 720 fallback and carries NO audio — the microphone is
 * recorded once, on the rear/main stream only, so the two files can
 * never carry competing / echoing soundtracks.
 *
 * WHY a probe at all: some platforms (notably older/single-camera-at-
 * a-time hardware paths) let the second `getUserMedia` succeed while
 * quietly ending or muting the FIRST stream. Opening both and then
 * checking the first track is still live is the only reliable way to
 * know dual capture really worked — see `probeDualCamera`.
 *
 * $0 rule: no dependencies, only the platform `getUserMedia` API the
 * capture component already used.
 */

import {
  buildCaptureAttempts,
  dimensionsForShortSide,
  isLadderRetryableError,
} from './captureQuality';
import type { CaptureAttempt, CaptureFpsChoice, CaptureQualityChoice } from './captureQuality';

/**
 * Shown when dual capture is not available on this device/browser and
 * recording falls back to a single camera. Wording is plain and says
 * what happened AND what happens instead — the user tapped "both
 * cameras", so silence or a technical error would read as a bug.
 */
export const DUAL_UNAVAILABLE_MESSAGE =
  "This phone can't run both cameras at once in the browser — recording with one camera instead";

/**
 * One resolution tier below `shortSide`, floored at 1080: 2160 steps
 * to 1440, 1440 steps to 1080, and 1080 (or anything lower) stays at
 * the 1080 floor — dual capture never asks a rung below HD, and never
 * keeps a flagship rung the hardware would struggle to sustain twice.
 */
function steppedDownShortSide(shortSide: number): number {
  if (shortSide > 1440) return 1440;
  if (shortSide > 1080) return 1080;
  return 1080;
}

/**
 * Build one attempt with constraints shaped exactly like
 * `captureQuality`'s internal `attemptFor` (width/height/aspectRatio/
 * frameRate all `{ ideal }`, never exact/min — a device that can't hit
 * a rung negotiates its closest match instead of rejecting outright),
 * but with an explicit audio flag: the rear ladder keeps the mic, the
 * front ladder must not ask for it.
 */
function dualAttemptFor(
  canvasWidth: number,
  canvasHeight: number,
  facingMode: 'user' | 'environment',
  shortSide: number,
  frameRate: number,
  isFallback: boolean,
  audio: boolean,
): CaptureAttempt {
  const dims = dimensionsForShortSide(canvasWidth, canvasHeight, shortSide);
  return {
    shortSide,
    frameRate,
    isFallback,
    constraints: {
      video: {
        facingMode,
        width: { ideal: dims.width },
        height: { ideal: dims.height },
        aspectRatio: { ideal: dims.ratio },
        frameRate: { ideal: frameRate },
      },
      audio,
    },
  };
}

/**
 * Rebuild each attempt one resolution tier lower (see
 * `steppedDownShortSide`), preserving the attempt's facing mode, frame
 * rate and audio flag.
 *
 * Stepping down can make neighbouring rungs identical — e.g. the
 * single-camera 1440@60 and 1080@60 rungs both become 1080@60. Asking
 * `getUserMedia` the exact same question twice wastes a (possibly
 * slow, permission-prompting) call and gains nothing, so consecutive
 * duplicates (same short side AND frame rate as the previous kept
 * attempt) are dropped. After dedupe, exactly the LAST kept attempt
 * is flagged `isFallback` — the fallback flag describes position in
 * THIS ladder, not the source ladder.
 *
 * Never returns an empty array: an empty input still yields one
 * permissive 1080@30 fallback rung, so a caller walking the ladder
 * always has something to try.
 */
export function stepDownCaptureAttempts(
  attempts: CaptureAttempt[],
  canvasWidth: number,
  canvasHeight: number,
): CaptureAttempt[] {
  if (attempts.length === 0) {
    return [dualAttemptFor(canvasWidth, canvasHeight, 'environment', 1080, 30, true, true)];
  }
  const kept: CaptureAttempt[] = [];
  for (const attempt of attempts) {
    const video = attempt.constraints.video;
    const facingMode =
      video && typeof video === 'object' ? (video as MediaTrackConstraints).facingMode : undefined;
    const facing: 'user' | 'environment' = facingMode === 'user' ? 'user' : 'environment';
    const newShortSide = steppedDownShortSide(attempt.shortSide);
    const previous = kept[kept.length - 1];
    if (previous && previous.shortSide === newShortSide && previous.frameRate === attempt.frameRate) {
      continue;
    }
    kept.push(
      dualAttemptFor(
        canvasWidth,
        canvasHeight,
        facing,
        newShortSide,
        attempt.frameRate,
        false,
        attempt.constraints.audio === true,
      ),
    );
  }
  // `kept` cannot be empty here (the first attempt is always kept),
  // but guard anyway so the never-empty contract holds by construction.
  if (kept.length === 0) {
    return [dualAttemptFor(canvasWidth, canvasHeight, 'environment', 1080, 30, true, true)];
  }
  kept[kept.length - 1].isFallback = true;
  return kept;
}

/**
 * The REAR (main) camera ladder for dual capture: the user's chosen
 * single-camera quality/fps ladder (R24), stepped one tier down, on
 * the `environment` camera. Audio stays true — this stream carries
 * THE microphone for the whole dual recording.
 */
export function buildDualRearAttempts(opts: {
  canvasWidth: number;
  canvasHeight: number;
  quality: CaptureQualityChoice;
  frameRate: CaptureFpsChoice;
}): CaptureAttempt[] {
  return stepDownCaptureAttempts(
    buildCaptureAttempts({ ...opts, facingMode: 'environment' }),
    opts.canvasWidth,
    opts.canvasHeight,
  );
}

/**
 * The FRONT (PiP) camera ladder for dual capture: VIDEO ONLY on every
 * rung (`audio: false` — the mic lives on the rear stream), `user`
 * facing, 30fps, 1080 short side then a 720 fallback. The front clip
 * plays as a small overlay, so resolution buys little here — asking
 * for less is what makes room (bandwidth, encoder, thermals) for the
 * main camera to hold its own stream.
 */
export function buildDualFrontAttempts(opts: {
  canvasWidth: number;
  canvasHeight: number;
}): CaptureAttempt[] {
  return [
    dualAttemptFor(opts.canvasWidth, opts.canvasHeight, 'user', 1080, 30, false, false),
    dualAttemptFor(opts.canvasWidth, opts.canvasHeight, 'user', 720, 30, true, false),
  ];
}

export type DualProbeResult =
  | { available: true; rearStream: MediaStream; frontStream: MediaStream }
  | {
      available: false;
      reason: 'unsupported' | 'rear-failed' | 'front-failed' | 'rear-ended';
      error?: unknown;
    };

function stopStream(stream: MediaStream): void {
  try {
    stream.getTracks().forEach((track) => track.stop());
  } catch {
    // Stopping is best-effort cleanup — a track that throws on stop
    // must not mask the probe result that triggered the cleanup.
  }
}

function isTrackLive(track: MediaStreamTrack | undefined): boolean {
  return !!track && track.readyState === 'live' && track.muted === false;
}

/**
 * Walk one ladder: try each rung in order, moving to the next rung
 * ONLY on a ladder-retryable error (this rung doesn't fit — see
 * `isLadderRetryableError`). Any other error (permission denied, no
 * such camera, device busy…) fails immediately — retrying a different
 * resolution cannot fix it, and extra calls just burn time and calls
 * the tests/users can observe. Throws the last / fatal error.
 */
async function openLadder(
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>,
  attempts: CaptureAttempt[],
): Promise<MediaStream> {
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      return await getUserMedia(attempt.constraints);
    } catch (err) {
      lastError = err;
      if (!isLadderRetryableError(err)) throw err;
    }
  }
  throw lastError;
}

/**
 * Probe whether this device/browser can really run both cameras at
 * once, opening the streams the recording will use if it can.
 *
 * Order matters: the REAR stream opens first (it is the main picture
 * and the mic owner), then the FRONT. If the front cannot open, the
 * rear stream is stopped before returning — a failed probe must never
 * leak a live camera. After both are open, both video tracks are
 * checked for liveness: on single-camera-at-a-time platforms the
 * front opening silently ends/mutes the rear track, which is reported
 * as 'rear-ended' (distinct from the front simply failing) and BOTH
 * streams are stopped. On success the streams are NOT stopped —
 * ownership passes to the caller, which records from them directly
 * (re-opening would re-run the very race the probe just settled).
 */
export async function probeDualCamera(
  deps: {
    getUserMedia: ((c: MediaStreamConstraints) => Promise<MediaStream>) | null | undefined;
  },
  rearAttempts: CaptureAttempt[],
  frontAttempts: CaptureAttempt[],
): Promise<DualProbeResult> {
  const getUserMedia = deps.getUserMedia;
  if (!getUserMedia) {
    return { available: false, reason: 'unsupported' };
  }

  let rearStream: MediaStream;
  try {
    rearStream = await openLadder(getUserMedia, rearAttempts);
  } catch (err) {
    return { available: false, reason: 'rear-failed', error: err };
  }

  let frontStream: MediaStream;
  try {
    frontStream = await openLadder(getUserMedia, frontAttempts);
  } catch (err) {
    stopStream(rearStream);
    return { available: false, reason: 'front-failed', error: err };
  }

  const rearLive = isTrackLive(rearStream.getVideoTracks()[0]);
  const frontLive = isTrackLive(frontStream.getVideoTracks()[0]);
  if (!rearLive) {
    // The classic single-camera-at-a-time behaviour: opening the
    // front camera killed (ended or muted) the rear one.
    stopStream(rearStream);
    stopStream(frontStream);
    return { available: false, reason: 'rear-ended' };
  }
  if (!frontLive) {
    stopStream(rearStream);
    stopStream(frontStream);
    return { available: false, reason: 'front-failed' };
  }

  return { available: true, rearStream, frontStream };
}

/**
 * How far apart the two recorders actually started, in milliseconds:
 * front start minus rear start (the same sign convention
 * `dualAlignmentTrims` consumes). The recorders are started back-to-
 * back on one anchor, but "back-to-back" in code is still tens to
 * hundreds of milliseconds apart on a real phone — this measures it
 * instead of assuming it.
 */
export function dualStartDeltaMs(rearStartMs: number, frontStartMs: number): number {
  return frontStartMs - rearStartMs;
}

/**
 * Head trims that line the two recordings up. The two recorders start
 * back-to-back on one anchor, so the FIRST-started recorder's file
 * holds extra head content the other camera never captured — the
 * moment before the second recorder began exists in only one file.
 * Trimming that head off the earlier file (by |delta|) puts both
 * files' first frames at the same real-world instant; the later-
 * starting clip keeps its head untouched (it has nothing extra).
 * Delta > 0 means the front started second, so the REAR is trimmed;
 * delta < 0 the reverse; 0 needs no trim.
 */
export function dualAlignmentTrims(startDeltaMs: number): {
  rearTrimStartSeconds: number;
  frontTrimStartSeconds: number;
} {
  if (startDeltaMs > 0) {
    return { rearTrimStartSeconds: startDeltaMs / 1000, frontTrimStartSeconds: 0 };
  }
  if (startDeltaMs < 0) {
    return { rearTrimStartSeconds: 0, frontTrimStartSeconds: Math.abs(startDeltaMs) / 1000 };
  }
  return { rearTrimStartSeconds: 0, frontTrimStartSeconds: 0 };
}
