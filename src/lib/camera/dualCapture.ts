/**
 * Pure dual-camera capture logic — one-button recording with BOTH
 * cameras at once (rear/main + front PiP). R29 shipped the first
 * version; R30 is the probe-v2 fix after R29 failed on the owner's
 * Android with the honest fallback banner.
 *
 * Kept separate from the capture component so the pairing ladder, the
 * dual-camera availability probe and the start-alignment maths are
 * unit-testable without a DOM or real cameras — same split as
 * `captureQuality.ts` (R24), which this module builds on and never
 * duplicates. Everything here is scoped to the DUAL path: nothing in
 * this module is used by single-camera capture, whose behaviour is
 * byte-identical to before.
 *
 * WHAT R29 GOT WRONG (root causes, from the AOSP concurrent-streaming
 * guarantees + the shipped code):
 * 1. Android only GUARANTEES concurrent camera streams at modest
 *    sizes — the mandatory concurrent combinations cap a pair at
 *    roughly 720p + 1440p, and only on devices that advertise
 *    concurrent support at all. R29's ladders floored at 1080 for
 *    BOTH cameras and preserved 60fps rungs — outside the envelope.
 * 2. A camera-HAL rejection of an oversized concurrent combo
 *    surfaces as `NotReadableError`, which the single-camera ladder
 *    predicate treats as FATAL — so R29's probe died on its first
 *    too-big ask instead of stepping down to a pairing that works.
 * 3. R29 judged the rear track's `muted` flag in the same tick the
 *    front camera opened. Phones commonly mute/pause the first track
 *    briefly while the second camera configures, then recover — a
 *    false 'rear-ended' on hardware that was about to work.
 * 4. The mic rode inside the big rear `getUserMedia` call
 *    (`audio: true`); under concurrency the combined audio+video
 *    configuration can be rejected wholesale, killing both cameras
 *    for the microphone's sake.
 * 5. `facingMode` alone can pair the wrong physical sensor on
 *    multi-rear-lens phones; exact `deviceId` pairing is reliable
 *    once permission has revealed the device labels.
 *
 * THE R30 SHAPE: both cameras open VIDEO-ONLY, low-first, inside the
 * guaranteed envelope (rear 1080p + front 720p, descending), all at
 * 30fps. HAL rejections step DOWN the pairing ladder instead of
 * dying. Liveness is judged AFTER a settle window by FRAME FLOW, not
 * by the muted flag alone. The microphone is fetched LAST, on its own
 * audio-only call, and merged onto the rear stream — if the mic call
 * fails, dual video proceeds silently rather than not at all. And a
 * failed probe reports a plain-words `details` line (reason + error
 * name + pairing last tried) so the next field report is precise.
 *
 * $0 rule: no dependencies, only the platform `getUserMedia` API the
 * capture component already used.
 */

import { dimensionsForShortSide } from './captureQuality';

/**
 * Shown when dual capture is not available on this device/browser and
 * recording falls back to a single camera. Wording is plain and says
 * what happened AND what happens instead — the user tapped "both
 * cameras", so silence or a technical error would read as a bug.
 * (Unchanged from R29 — the banner's main sentence does not move.)
 */
export const DUAL_UNAVAILABLE_MESSAGE =
  "This phone can't run both cameras at once in the browser — recording with one camera instead";

/**
 * Shown (in dual mode) when both cameras work but the separate
 * microphone call failed: dual recording proceeds WITHOUT sound, and
 * the user is told so before they rely on the audio.
 */
export const DUAL_MIC_UNAVAILABLE_MESSAGE =
  'Microphone unavailable — recording both cameras without sound';

/* ------------------------------------------------------------------ */
/* Device pairing (exact deviceIds)                                    */
/* ------------------------------------------------------------------ */

/** The structural slice of `MediaDeviceInfo` the pairing logic needs. */
export type DualDeviceInfo = Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>;

/** An exact front/back camera pair, by `deviceId`. */
export interface DualDevicePair {
  rearId: string;
  frontId: string;
}

const REAR_LABEL_HINT = /back|rear|environment/i;
const FRONT_LABEL_HINT = /front|user|selfie/i;

function usableVideoInputs(devices: DualDeviceInfo[]): DualDeviceInfo[] {
  return devices.filter((d) => d.kind === 'videoinput' && !!d.deviceId);
}

/**
 * Pair the cameras by their LABELS only (Android Chrome labels read
 * like "Back Camera" / "Front Camera" once permission is granted).
 * Returns null when the labels identify neither side — pre-permission
 * enumerations carry blank labels, and guessing from a half-labelled
 * list is still better than guessing blind: when exactly one side is
 * labelled, the other side is the first remaining camera.
 */
export function pairFromLabels(devices: DualDeviceInfo[]): DualDevicePair | null {
  const vids = usableVideoInputs(devices);
  if (vids.length < 2) return null;
  const rear = vids.find((d) => REAR_LABEL_HINT.test(d.label ?? ''));
  const front = vids.find((d) => d !== rear && FRONT_LABEL_HINT.test(d.label ?? ''));
  if (rear && front) return { rearId: rear.deviceId, frontId: front.deviceId };
  if (rear) {
    const other = vids.find((d) => d !== rear);
    if (other) return { rearId: rear.deviceId, frontId: other.deviceId };
  }
  if (front) {
    const other = vids.find((d) => d !== front);
    if (other) return { rearId: other.deviceId, frontId: front.deviceId };
  }
  return null;
}

/**
 * The deviceId pair to try: label pairing when the labels say
 * anything, otherwise the first two cameras (the desktop case — two
 * webcams rarely label themselves front/back, and R29's pairing
 * behaved exactly this way). Null when fewer than two usable cameras
 * exist.
 */
export function selectDualDevicePair(devices: DualDeviceInfo[]): DualDevicePair | null {
  const vids = usableVideoInputs(devices);
  if (vids.length < 2) return null;
  return pairFromLabels(vids) ?? { rearId: vids[0].deviceId, frontId: vids[1].deviceId };
}

/* ------------------------------------------------------------------ */
/* Pairing ladder (low-first, video-only, 30fps)                       */
/* ------------------------------------------------------------------ */

/** One rung of the dual ladder: a rear/front size pairing + its constraints. */
export interface DualPairing {
  /** Plain-words description for diagnostics, e.g. "rear 1080p + front 720p". */
  label: string;
  rearShortSide: number;
  frontShortSide: number;
  /** VIDEO-ONLY constraints (`audio: false` — the mic is fetched separately, last). */
  rearConstraints: MediaStreamConstraints;
  frontConstraints: MediaStreamConstraints;
}

/**
 * The dual pairings, in try-order — all inside (then below) the
 * concurrent-stream envelope Android guarantees, all 30fps (60fps
 * concurrent pairings are essentially never guaranteed). Descending:
 * if the phone refuses a pairing, the next one asks for less.
 */
const DUAL_PAIRING_SIZES: ReadonlyArray<{ rear: number; front: number }> = [
  { rear: 1080, front: 720 },
  { rear: 720, front: 720 },
  { rear: 720, front: 480 },
];

function dualVideoOnlyConstraints(
  selector: { deviceId: string } | { facingMode: 'user' | 'environment' },
  canvasWidth: number,
  canvasHeight: number,
  shortSide: number,
): MediaStreamConstraints {
  const dims = dimensionsForShortSide(canvasWidth, canvasHeight, shortSide);
  const video: MediaTrackConstraints = {
    // "ideal", never "exact"/"min" — a device that can't hit a rung
    // negotiates its closest match instead of rejecting outright.
    width: { ideal: dims.width },
    height: { ideal: dims.height },
    aspectRatio: { ideal: dims.ratio },
    frameRate: { ideal: 30 },
  };
  if ('deviceId' in selector) {
    video.deviceId = { exact: selector.deviceId };
  } else {
    video.facingMode = selector.facingMode;
  }
  return { video, audio: false };
}

/**
 * Build the pairing ladder. Without a device pair, cameras are
 * selected by `facingMode` (the only option before permission reveals
 * labels/ids); with a pair, both constraints name the exact
 * `deviceId` — the reliable route on multi-lens phones and desktops.
 */
export function buildDualPairings(
  opts: { canvasWidth: number; canvasHeight: number },
  pair?: DualDevicePair | null,
): DualPairing[] {
  return DUAL_PAIRING_SIZES.map(({ rear, front }) => ({
    label: `rear ${rear}p + front ${front}p`,
    rearShortSide: rear,
    frontShortSide: front,
    rearConstraints: dualVideoOnlyConstraints(
      pair ? { deviceId: pair.rearId } : { facingMode: 'environment' },
      opts.canvasWidth,
      opts.canvasHeight,
      rear,
    ),
    frontConstraints: dualVideoOnlyConstraints(
      pair ? { deviceId: pair.frontId } : { facingMode: 'user' },
      opts.canvasWidth,
      opts.canvasHeight,
      front,
    ),
  }));
}

/* ------------------------------------------------------------------ */
/* Errors + failure details                                            */
/* ------------------------------------------------------------------ */

/**
 * Errors that mean "this pairing doesn't fit — step down", on the
 * DUAL path only. Deliberately wider than the single-camera
 * predicate (`isLadderRetryableError`, untouched): a HAL rejection
 * of a concurrent combo arrives as `NotReadableError`, and a raced
 * camera-service abort as `AbortError` — both can succeed at a
 * smaller pairing. `NotAllowedError` (permission) stays fatal:
 * no pairing fixes a denial.
 */
export function isDualRetryableError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return (
    name === 'OverconstrainedError' ||
    name === 'NotFoundError' ||
    name === 'NotReadableError' ||
    name === 'AbortError'
  );
}

export type DualProbeFailureReason = 'unsupported' | 'rear-failed' | 'front-failed' | 'rear-ended';

export interface DualProbeFailure {
  reason: DualProbeFailureReason;
  error?: unknown;
  /** Label of the pairing being tried when the failure settled, e.g. "rear 720p + front 480p". */
  pairingLabel?: string;
}

/**
 * Compose the plain-words details line for a failed probe — the
 * banner's small print and the console log carry the same string.
 * Names WHAT failed, the platform error name when there is one, and
 * the pairing last tried, so a field report ("it failed again")
 * becomes a diagnosis instead of a shrug.
 */
export function dualFailureDetails(failure: DualProbeFailure): string {
  const errName = (failure.error as { name?: string } | null | undefined)?.name;
  const errPart = errName ? ` (${errName})` : '';
  const atPart = failure.pairingLabel ? ` at ${failure.pairingLabel}` : '';
  switch (failure.reason) {
    case 'unsupported':
      return 'this browser does not provide camera access';
    case 'rear-failed':
      return `the main camera could not be opened${errPart}${atPart}`;
    case 'front-failed':
      return `the second camera was refused by the phone${errPart}${atPart}`;
    case 'rear-ended':
      return `the main camera stopped when the second camera opened${atPart}`;
  }
}

/* ------------------------------------------------------------------ */
/* The probe                                                           */
/* ------------------------------------------------------------------ */

export type DualProbeResult =
  | { available: true; rearStream: MediaStream; frontStream: MediaStream; pairingLabel: string }
  | {
      available: false;
      reason: DualProbeFailureReason;
      error?: unknown;
      pairingLabel?: string;
      /** Plain-words diagnosis — see `dualFailureDetails`. */
      details: string;
    };

export interface DualProbeDeps {
  getUserMedia: ((c: MediaStreamConstraints) => Promise<MediaStream>) | null | undefined;
  /** Optional — enables exact deviceId pairing (labels / desktop fallback). */
  enumerateDevices?: (() => Promise<MediaDeviceInfo[]>) | null | undefined;
  /** Injectable for tests; defaults to a real timer. */
  delay?: (ms: number) => Promise<void>;
  /**
   * Injectable FRAME-FLOW check: resolves true when the stream's
   * video is actually presenting frames. The component supplies a
   * `requestVideoFrameCallback`-based implementation. When absent
   * (or if it throws), liveness falls back to readyState + the muted
   * flag — evaluated AFTER the settle window, never in the same tick
   * the second camera opened (the R29 false-negative).
   */
  framesFlowing?: ((stream: MediaStream) => Promise<boolean>) | null | undefined;
  /** How long to let both cameras settle before judging liveness. Default 1000ms. */
  settleMs?: number;
  /** Pause between pairing rungs after a retryable rejection. Default 300ms. */
  backoffMs?: number;
}

function stopStream(stream: MediaStream): void {
  try {
    stream.getTracks().forEach((track) => track.stop());
  } catch {
    // Stopping is best-effort cleanup — a track that throws on stop
    // must not mask the probe result that triggered the cleanup.
  }
}

function failureResult(failure: DualProbeFailure): DualProbeResult {
  return {
    available: false,
    reason: failure.reason,
    error: failure.error,
    pairingLabel: failure.pairingLabel,
    details: dualFailureDetails(failure),
  };
}

/**
 * Probe whether this device/browser can really run both cameras at
 * once, opening the streams the recording will use if it can.
 *
 * Flow: select by label-exact deviceIds when an enumeration already
 * reveals them, else by `facingMode`. Walk the pairing ladder
 * (low-first); a retryable rejection steps down with a short backoff
 * instead of failing. After the first successful rear open
 * (permission now exists, so labels are readable), refine the
 * selectors to the label-exact pair — reopening the rear only if it
 * turns out to be the wrong physical camera. Once both streams are
 * open, WAIT out the settle window, then judge liveness by frame
 * flow: ended or zero-frames fails; live-with-frames passes even if
 * the track still flags muted. If the whole facingMode ladder fails
 * without a permission denial and 2+ cameras exist, retry the ladder
 * once with first-two deviceId pairing (the desktop route). On
 * success the streams are NOT stopped — ownership passes to the
 * caller. On failure every opened track is stopped.
 */
export async function probeDualCamera(
  deps: DualProbeDeps,
  opts: { canvasWidth: number; canvasHeight: number },
): Promise<DualProbeResult> {
  const getUserMedia = deps.getUserMedia;
  if (!getUserMedia) {
    return failureResult({ reason: 'unsupported' });
  }
  const delay = deps.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const settleMs = deps.settleMs ?? 1000;
  const backoffMs = deps.backoffMs ?? 300;
  const framesFlowing = deps.framesFlowing ?? null;

  const tryEnumerate = async (): Promise<MediaDeviceInfo[] | null> => {
    if (!deps.enumerateDevices) return null;
    try {
      return await deps.enumerateDevices();
    } catch {
      return null;
    }
  };

  const trackAlive = async (stream: MediaStream): Promise<boolean> => {
    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') return false;
    if (framesFlowing) {
      try {
        return await framesFlowing(stream);
      } catch {
        // A broken frame probe must not convict a live camera — fall
        // through to the post-settle muted check.
      }
    }
    return track.muted === false;
  };

  /**
   * Run the pairing ladder with one selector strategy.
   * `allowRefine` lets the ladder upgrade itself to label-exact
   * deviceIds after the first rear open (see the flow notes above).
   */
  const runPairingLadder = async (
    initialPair: DualDevicePair | null,
    allowRefine: boolean,
  ): Promise<DualProbeResult> => {
    let pair = initialPair;
    let pairings = buildDualPairings(opts, pair);
    let refined = !allowRefine;
    let lastFailure: DualProbeFailure = { reason: 'rear-failed' };
    let idx = 0;
    while (idx < pairings.length) {
      // REAR (main) first — it is the primary picture.
      let rearStream: MediaStream;
      try {
        rearStream = await getUserMedia(pairings[idx].rearConstraints);
      } catch (err) {
        lastFailure = { reason: 'rear-failed', error: err, pairingLabel: pairings[idx].label };
        if (!isDualRetryableError(err)) return failureResult(lastFailure);
        idx += 1;
        if (idx < pairings.length) await delay(backoffMs);
        continue;
      }

      // Permission exists now: labels are readable. If we opened by
      // facingMode and a label-exact pair emerges, adopt it — for the
      // front immediately, and for the rear by reopening ONLY when
      // the stream we got is a different physical camera.
      if (!refined) {
        refined = true;
        if (!pair) {
          const fresh = await tryEnumerate();
          const labelPair = fresh ? pairFromLabels(fresh) : null;
          if (labelPair) {
            pair = labelPair;
            pairings = buildDualPairings(opts, pair);
            const actualRearId = rearStream.getVideoTracks()[0]?.getSettings?.().deviceId;
            if (actualRearId !== labelPair.rearId) {
              stopStream(rearStream);
              idx = 0;
              continue;
            }
          }
        }
      }

      // FRONT (PiP) second, without closing the rear.
      let frontStream: MediaStream;
      try {
        frontStream = await getUserMedia(pairings[idx].frontConstraints);
      } catch (err) {
        stopStream(rearStream);
        lastFailure = { reason: 'front-failed', error: err, pairingLabel: pairings[idx].label };
        if (!isDualRetryableError(err)) return failureResult(lastFailure);
        idx += 1;
        if (idx < pairings.length) await delay(backoffMs);
        continue;
      }

      // SETTLE, then judge by frame flow — never in the opening tick.
      await delay(settleMs);
      if (!(await trackAlive(rearStream))) {
        // The classic single-camera-at-a-time behaviour: opening the
        // front camera ended the rear one (or it never produced a
        // frame). A smaller pairing may still revive it — step down.
        stopStream(rearStream);
        stopStream(frontStream);
        lastFailure = { reason: 'rear-ended', pairingLabel: pairings[idx].label };
        idx += 1;
        if (idx < pairings.length) await delay(backoffMs);
        continue;
      }
      if (!(await trackAlive(frontStream))) {
        stopStream(rearStream);
        stopStream(frontStream);
        lastFailure = { reason: 'front-failed', pairingLabel: pairings[idx].label };
        idx += 1;
        if (idx < pairings.length) await delay(backoffMs);
        continue;
      }

      return { available: true, rearStream, frontStream, pairingLabel: pairings[idx].label };
    }
    return failureResult(lastFailure);
  };

  const initialDevices = await tryEnumerate();
  const labelPair = initialDevices ? pairFromLabels(initialDevices) : null;
  const first = await runPairingLadder(labelPair, !labelPair);
  if (first.available) return first;

  // Desktop fallback: the facingMode ladder failed (but NOT on a
  // permission denial — retrying cannot fix that) and the device has
  // 2+ cameras: pair the first two by exact deviceId and run the
  // ladder once more.
  if (!labelPair && deps.enumerateDevices) {
    const errName = (first.error as { name?: string } | null | undefined)?.name;
    if (errName !== 'NotAllowedError') {
      const devices = await tryEnumerate();
      const pair = devices ? selectDualDevicePair(devices) : null;
      if (pair) {
        const second = await runPairingLadder(pair, false);
        if (second.available) return second;
        return second;
      }
    }
  }
  return first;
}

/* ------------------------------------------------------------------ */
/* Mic (last, separate) + best-effort rear raise                       */
/* ------------------------------------------------------------------ */

/**
 * Fetch the microphone on its OWN audio-only call and merge its
 * track onto the (video-only) rear stream, so the rear MediaRecorder
 * captures picture + sound exactly as a single merged stream. Never
 * throws: on any failure the caller proceeds with silent dual video
 * and shows `DUAL_MIC_UNAVAILABLE_MESSAGE`.
 */
export async function attachMicrophone(
  getUserMedia: ((c: MediaStreamConstraints) => Promise<MediaStream>) | null | undefined,
  rearStream: MediaStream,
): Promise<{ ok: boolean; error?: unknown }> {
  if (!getUserMedia) return { ok: false };
  try {
    const micStream = await getUserMedia({ audio: true });
    const tracks = micStream.getAudioTracks();
    const track = tracks[0];
    if (!track) return { ok: false };
    rearStream.addTrack(track);
    // The mic stream is a donor — any extra tracks stay stopped so
    // nothing is left capturing unnoticed.
    tracks.slice(1).forEach((extra) => {
      try {
        extra.stop();
      } catch {
        // Best-effort cleanup only.
      }
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/**
 * ONE best-effort raise of the rear camera toward 1440p, attempted
 * once both streams are proven live and recording is about to start
 * (the guaranteed concurrent envelope tops out around 1440p for the
 * larger stream). Any failure — no `applyConstraints`, a HAL that
 * refuses mid-flight — is swallowed: the negotiated 1080p (or lower)
 * stream simply records as-is. Never throws.
 */
export async function tryRaiseRearResolution(
  rearStream: MediaStream,
  canvasWidth: number,
  canvasHeight: number,
): Promise<boolean> {
  try {
    const track = rearStream.getVideoTracks()[0];
    if (!track?.applyConstraints) return false;
    const dims = dimensionsForShortSide(canvasWidth, canvasHeight, 1440);
    await track.applyConstraints({
      width: { ideal: dims.width },
      height: { ideal: dims.height },
      aspectRatio: { ideal: dims.ratio },
    });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Start alignment (unchanged from R29)                                */
/* ------------------------------------------------------------------ */

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
