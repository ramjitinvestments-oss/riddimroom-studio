/**
 * The honest capture receipt (R32 Phase 1).
 *
 * After a recording stops, the review screen says what the device
 * ACTUALLY captured — negotiated resolution and frame rate from the
 * track's own settings, the recorder's real mimeType, the measured
 * file bitrate (blob size ÷ duration) and, when the frame-drop
 * tracker could measure it, the dropped-frame estimate. Never the
 * requested chip label alone: a phone that negotiated 720p says 720p.
 *
 * Pure builder + formatter, unit-tested; the component supplies the
 * raw facts and renders the formatted lines.
 *
 * The DEFAULT receipt surface is plain: the summary line plus a
 * plain details line (duration + file size, in MB). The precise
 * technical line is built separately by `formatTechnicalDetails`
 * and is rendered only inside a "Details" expander in the
 * component — never on the default surface.
 *
 * $0 rule: no dependencies.
 */

import { DROPPED_FRAMES_WARNING_TEXT, shouldWarnAboutDroppedFrames } from './frameDrops';

export interface CaptureReceipt {
  /** Actual negotiated width from the video track's settings (0 when unknown). */
  actualWidth: number;
  /** Actual negotiated height from the video track's settings (0 when unknown). */
  actualHeight: number;
  /** Actual negotiated frame rate, rounded (0 when unknown). */
  actualFps: number;
  /** The recorder's real mimeType ('' = browser default). */
  mimeType: string;
  /** Measured file bitrate: blob bits ÷ duration seconds (0 when unmeasurable). */
  videoBitrateBps: number;
  /** The recording file size in bytes (0 when unknown). */
  blobSizeBytes: number;
  /** The recording duration in seconds (0 when unknown). */
  durationSeconds: number;
  /** Estimated dropped frames — present only when actually measured. */
  droppedFramesEstimate?: number;
  /**
   * Frames the nominal rate predicted across the measured window —
   * the review warning's relative denominator (R32 Phase 3).
   * Present only alongside a measured dropped-frame estimate.
   */
  expectedFramesEstimate?: number;
  /**
   * R41 WS-B — the ASKED rung's short side (the two-stage
   * negotiation's stage-1 target), 0 when the take carried no ask
   * (dual pairings, which negotiate on their own ladder).
   */
  askedShortSide: number;
  /** R41 WS-B — the ASKED rung's frame rate (0 when no ask was recorded). */
  askedFps: number;
  /** R41 WS-B — true when the one exact-constraint retry ran for this take's stream. */
  exactRetryAttempted?: boolean;
  /** R41 WS-B — true when the exact retry's stream is the one that recorded. */
  exactRetryUsed?: boolean;
  /** R41 Step 3 Rung C — the ASKED rung's width (0 when the ask carried no width). */
  askedWidth: number;
  /** R41 Step 3 Rung C — the ASKED rung's height (0 when the ask carried no height). */
  askedHeight: number;
  /**
   * R41 Step 3 Rung C — true when the final grant's orientation
   * differed from the asked orientation (recorded by the negotiation
   * whatever the exact retry's outcome). Present only when the
   * take's negotiation recorded it.
   */
  orientationMismatch?: boolean;
  /**
   * R41 Step 3 Rung B — the frame-timing outcome of the take's save
   * into the project: 'steadied' when the saved file was re-timed
   * onto an even frame-rate grid, 'original' when the recorded
   * timing was kept (already even, or steadying unavailable/failed —
   * the take itself is never lost either way). Present only on
   * receipts for takes that passed through the save step.
   */
  timingOutcome?: 'steadied' | 'original';
  /** R41 Step 3 Rung B — the frame rate a steadied take was re-timed to (present only when timingOutcome is 'steadied'). */
  steadiedFps?: number;
  /**
   * FINAL FIX Part 2 — the capture engine that recorded this take,
   * present only when the single-camera path ran with the new
   * engine (test) selected. The standard engine's takes carry no
   * engine block: the receipt makes no claim it did not measure.
   */
  engine?: CaptureEngineInfo;
}

/**
 * FINAL FIX Part 2 — one take's engine record. `fellBack` is the
 * honest disclosure that the new engine (test) failed and the
 * standard engine recorded the take; the counts are the engine's
 * own ledger (frames it received, encoded, deliberately dropped at
 * its queue gate, and grid slots it filled), present only when the
 * engine itself reported them.
 */
export interface CaptureEngineInfo {
  kind: 'webcodecs';
  fellBack: boolean;
  framesReceived?: number;
  framesEncoded?: number;
  framesDroppedByQueue?: number;
  framesFilled?: number;
  /** False when the prototype take is video-only — a disclosed limitation, never hidden. */
  audioIncluded?: boolean;
}

export interface CaptureReceiptInput {
  trackSettings: { width?: number; height?: number; frameRate?: number } | null | undefined;
  mimeType: string;
  blobSize: number;
  durationSeconds: number;
  /** Pass null/undefined when the tracker could not measure — the field is then omitted, never invented. */
  droppedFramesEstimate?: number | null;
  /** The tracker's expected-frame count for the same window — omitted (like the estimate) when unmeasured. */
  expectedFramesEstimate?: number | null;
  /** R41 WS-B — the asked rung (short side + frame rate) this take's stream was negotiated from, when known. Rung C adds the asked width/height when the rung carried them. */
  asked?: { shortSide: number; frameRate: number; width?: number; height?: number } | null;
  /** R41 WS-B — the two-stage negotiation outcome for this take's stream, when known. */
  exactRetryAttempted?: boolean;
  exactRetryUsed?: boolean;
  /** R41 Step 3 Rung C — the negotiation's orientation verdict for this take's stream, when recorded. */
  orientationMismatch?: boolean;
  /** R41 Step 3 Rung B — the save step's frame-timing outcome for this take, when it ran. */
  timingOutcome?: 'steadied' | 'original';
  /** R41 Step 3 Rung B — the frame rate a steadied take was re-timed to. */
  steadiedFps?: number;
  /** FINAL FIX Part 2 — the engine record for this take, when the new engine (test) was selected. */
  engine?: CaptureEngineInfo | null;
}

/** Build a receipt from the raw facts of one finished recording. */
export function buildCaptureReceipt(input: CaptureReceiptInput): CaptureReceipt {
  const width = input.trackSettings?.width;
  const height = input.trackSettings?.height;
  const frameRate = input.trackSettings?.frameRate;
  const receipt: CaptureReceipt = {
    actualWidth: typeof width === 'number' && Number.isFinite(width) && width > 0 ? Math.round(width) : 0,
    actualHeight: typeof height === 'number' && Number.isFinite(height) && height > 0 ? Math.round(height) : 0,
    actualFps: typeof frameRate === 'number' && Number.isFinite(frameRate) && frameRate > 0 ? Math.round(frameRate) : 0,
    mimeType: typeof input.mimeType === 'string' ? input.mimeType : '',
    videoBitrateBps:
      typeof input.blobSize === 'number' &&
      Number.isFinite(input.blobSize) &&
      input.blobSize > 0 &&
      typeof input.durationSeconds === 'number' &&
      Number.isFinite(input.durationSeconds) &&
      input.durationSeconds > 0
        ? Math.round((input.blobSize * 8) / input.durationSeconds)
        : 0,
    blobSizeBytes:
      typeof input.blobSize === 'number' && Number.isFinite(input.blobSize) && input.blobSize > 0
        ? Math.round(input.blobSize)
        : 0,
    durationSeconds:
      typeof input.durationSeconds === 'number' && Number.isFinite(input.durationSeconds) && input.durationSeconds > 0
        ? input.durationSeconds
        : 0,
    askedShortSide:
      typeof input.asked?.shortSide === 'number' && Number.isFinite(input.asked.shortSide) && input.asked.shortSide > 0
        ? Math.round(input.asked.shortSide)
        : 0,
    askedFps:
      typeof input.asked?.frameRate === 'number' && Number.isFinite(input.asked.frameRate) && input.asked.frameRate > 0
        ? Math.round(input.asked.frameRate)
        : 0,
    askedWidth:
      typeof input.asked?.width === 'number' && Number.isFinite(input.asked.width) && input.asked.width > 0
        ? Math.round(input.asked.width)
        : 0,
    askedHeight:
      typeof input.asked?.height === 'number' && Number.isFinite(input.asked.height) && input.asked.height > 0
        ? Math.round(input.asked.height)
        : 0,
  };
  if (input.exactRetryAttempted) receipt.exactRetryAttempted = true;
  if (input.exactRetryUsed) receipt.exactRetryUsed = true;
  if (typeof input.orientationMismatch === 'boolean') receipt.orientationMismatch = input.orientationMismatch;
  if (input.timingOutcome === 'steadied' || input.timingOutcome === 'original') {
    receipt.timingOutcome = input.timingOutcome;
    if (
      input.timingOutcome === 'steadied' &&
      typeof input.steadiedFps === 'number' &&
      Number.isFinite(input.steadiedFps) &&
      input.steadiedFps > 0
    ) {
      receipt.steadiedFps = Math.round(input.steadiedFps);
    }
  }
  const dropped = input.droppedFramesEstimate;
  if (typeof dropped === 'number' && Number.isFinite(dropped) && dropped >= 0) {
    receipt.droppedFramesEstimate = Math.round(dropped);
    const expected = input.expectedFramesEstimate;
    if (typeof expected === 'number' && Number.isFinite(expected) && expected > 0) {
      receipt.expectedFramesEstimate = Math.round(expected);
    }
  }
  if (input.engine && input.engine.kind === 'webcodecs') {
    const count = (v: number | undefined): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
    const engine: CaptureEngineInfo = { kind: 'webcodecs', fellBack: input.engine.fellBack === true };
    const framesReceived = count(input.engine.framesReceived);
    if (framesReceived !== undefined) engine.framesReceived = framesReceived;
    const framesEncoded = count(input.engine.framesEncoded);
    if (framesEncoded !== undefined) engine.framesEncoded = framesEncoded;
    const framesDroppedByQueue = count(input.engine.framesDroppedByQueue);
    if (framesDroppedByQueue !== undefined) engine.framesDroppedByQueue = framesDroppedByQueue;
    const framesFilled = count(input.engine.framesFilled);
    if (framesFilled !== undefined) engine.framesFilled = framesFilled;
    if (typeof input.engine.audioIncluded === 'boolean') engine.audioIncluded = input.engine.audioIncluded;
    receipt.engine = engine;
  }
  return receipt;
}

/**
 * The plain quality word for an achieved short side. Honest bands:
 * a 720p capture is "standard", never dressed up as "high".
 */
export function qualityWordForShortSide(shortSide: number): 'ultra' | 'high' | 'standard' | 'low' {
  if (shortSide >= 2000) return 'ultra';
  if (shortSide >= 1000) return 'high';
  if (shortSide >= 720) return 'standard';
  return 'low';
}

/** Format a file size in plain units, e.g. "8.4 MB" (empty when unknown). */
export function formatFileSizeBytes(bytes: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${Math.round(bytes)} bytes`;
}

/** Format a duration in plain words, e.g. "12 seconds" (empty when unknown). */
export function formatDurationSeconds(durationSeconds: number): string {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return '';
  const total = Math.round(durationSeconds);
  if (total <= 0) return '';
  if (total < 60) return `${total} second${total === 1 ? '' : 's'}`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  const minutePart = `${minutes} minute${minutes === 1 ? '' : 's'}`;
  if (rest === 0) return minutePart;
  return `${minutePart} ${rest} second${rest === 1 ? '' : 's'}`;
}

/**
 * The plain details line for the DEFAULT receipt surface: duration
 * plus file size, plain units only, e.g. "12 seconds · 8.4 MB".
 * Unknown facts are left out rather than guessed; the line is empty
 * when neither fact was measured.
 */
export function formatPlainDetails(receipt: CaptureReceipt): string {
  const parts: string[] = [];
  const duration = formatDurationSeconds(receipt.durationSeconds);
  if (duration) parts.push(duration);
  const size = formatFileSizeBytes(receipt.blobSizeBytes);
  if (size) parts.push(size);
  return parts.join(' · ');
}

// BLOCKLIST-TECHNICAL-START — precise technical strings for the
// "Details" expander only. The copy blocklist strips this region
// when it scans this module for the DEFAULT surface (see
// src/copyBlocklist.test.ts): these strings are sanctioned
// expander content, never default-surface copy.
/** Short display name for a recorder mimeType's video codec. */
export function codecNameForMimeType(mimeType: string): string {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.includes('avc1') || mime.startsWith('video/mp4')) return 'H.264';
  if (mime.includes('vp9')) return 'VP9';
  if (mime.includes('vp8')) return 'VP8';
  if (mime.includes('av01')) return 'AV1';
  if (mime.startsWith('video/webm')) return 'WebM';
  return 'Browser default';
}

/** Format a bitrate for the technical line: "9.8 Mbps" / "850 Kbps" / "400 bps". */
export function formatBitrateBps(bps: number): string {
  if (typeof bps !== 'number' || !Number.isFinite(bps) || bps <= 0) return '';
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  if (bps >= 1_000) return `${Math.round(bps / 1_000)} Kbps`;
  return `${Math.round(bps)} bps`;
}

/**
 * The technical line for the "Details" expander only: the codec,
 * the measured bitrate and — only when it was really measured — the
 * dropped-frame estimate. Never rendered on the default surface.
 */
export function formatTechnicalDetails(receipt: CaptureReceipt): string {
  const detailParts: string[] = [codecNameForMimeType(receipt.mimeType)];
  const bitrate = formatBitrateBps(receipt.videoBitrateBps);
  if (bitrate) detailParts.push(bitrate);
  if (typeof receipt.droppedFramesEstimate === 'number') {
    detailParts.push(
      receipt.droppedFramesEstimate === 0
        ? 'no dropped frames spotted'
        : `about ${receipt.droppedFramesEstimate} dropped frames`,
    );
  }
  return detailParts.join(' · ');
}
// BLOCKLIST-TECHNICAL-END

/**
 * R41 WS-B — the plain resolution label for a short side: the 2160
 * class reads "4K" (the name the quality chips use); every other
 * class reads by its pixels. Empty when the side is unknown.
 */
export function resolutionLabelForShortSide(shortSide: number): string {
  if (typeof shortSide !== 'number' || !Number.isFinite(shortSide) || shortSide <= 0) return '';
  if (shortSide >= 2000) return '4K';
  return `${Math.round(shortSide)}p`;
}

/**
 * R41 WS-B — whether a receipt's final grant fell below what was
 * asked: granted short side below the asked short side, or granted
 * frame rate below the asked frame rate. A take with no recorded
 * ask, or no readable grant, is never called below — no comparison,
 * no claim.
 */
export function receiptGrantBelowAsked(receipt: CaptureReceipt): boolean {
  if (!receipt || receipt.askedShortSide <= 0) return false;
  const grantedShort =
    receipt.actualWidth > 0 && receipt.actualHeight > 0 ? Math.min(receipt.actualWidth, receipt.actualHeight) : 0;
  if (grantedShort <= 0) return false;
  if (grantedShort < receipt.askedShortSide) return true;
  if (receipt.askedFps > 0 && receipt.actualFps > 0 && receipt.actualFps < receipt.askedFps) return true;
  return false;
}

/**
 * R41 WS-B — the plain asked-vs-granted line, e.g.
 * "Asked: 4K · 60 — Phone gave: 4K · 60 ✓" when the phone delivered,
 * or "Asked: 4K · 60 — Phone gave: 1080p · 60 — that's this browser's
 * limit on this camera" when the final grant fell below the ask.
 * Null when either side cannot be stated honestly.
 */
export function askedVsGrantedLine(
  asked: { shortSide: number; frameRate: number } | null | undefined,
  granted: { shortSide: number; frameRate: number } | null | undefined,
): string | null {
  const askedLabel = resolutionLabelForShortSide(asked?.shortSide ?? 0);
  const grantedLabel = resolutionLabelForShortSide(granted?.shortSide ?? 0);
  if (!askedLabel || !grantedLabel) return null;
  const askedFps = typeof asked?.frameRate === 'number' && asked.frameRate > 0 ? Math.round(asked.frameRate) : 0;
  const grantedFps = typeof granted?.frameRate === 'number' && granted.frameRate > 0 ? Math.round(granted.frameRate) : 0;
  const askedPart = askedFps > 0 ? `${askedLabel} · ${askedFps}` : askedLabel;
  const grantedPart = grantedFps > 0 ? `${grantedLabel} · ${grantedFps}` : grantedLabel;
  const below =
    (granted?.shortSide ?? 0) < (asked?.shortSide ?? 0) ||
    (askedFps > 0 && grantedFps > 0 && grantedFps < askedFps);
  return below
    ? `Asked: ${askedPart} — Phone gave: ${grantedPart} — that's this browser's limit on this camera`
    : `Asked: ${askedPart} — Phone gave: ${grantedPart} ✓`;
}

/** The receipt's own asked-vs-granted line (null when the take carried no ask). */
export function captureReceiptAskedVsGranted(receipt: CaptureReceipt): string | null {
  const grantedShort =
    receipt.actualWidth > 0 && receipt.actualHeight > 0 ? Math.min(receipt.actualWidth, receipt.actualHeight) : 0;
  return askedVsGrantedLine(
    { shortSide: receipt.askedShortSide, frameRate: receipt.askedFps },
    { shortSide: grantedShort, frameRate: receipt.actualFps },
  );
}

/**
 * R41 Step 3 Rung B — the plain frame-timing line for the review
 * surface: "Steadied to an even 30fps" when the saved take was
 * re-timed onto an even grid, "Original timing kept" when it was
 * not (already even, or steadying unavailable — the take is kept
 * either way). Null when the take never passed through the save
 * step, so no claim is made for it.
 */
export function captureReceiptTimingLine(receipt: CaptureReceipt): string | null {
  if (!receipt || !receipt.timingOutcome) return null;
  if (receipt.timingOutcome === 'original') return 'Original timing kept';
  const fps = receipt.steadiedFps && receipt.steadiedFps > 0 ? receipt.steadiedFps : receipt.actualFps;
  return fps > 0 ? `Steadied to an even ${fps}fps` : 'Steadied to an even frame rate';
}

/**
 * R41 Step 3 Rung C — the plain orientation note for the review
 * surface, shown when the phone granted a differently-oriented
 * picture than the project asked for. Informing, never alarming:
 * the editor frames the take into the project's shape either way.
 * Null when the orientations matched or either is unknown.
 */
export function captureReceiptOrientationNote(receipt: CaptureReceipt): string | null {
  if (!receipt || receipt.orientationMismatch !== true) return null;
  if (!(receipt.actualWidth > 0 && receipt.actualHeight > 0)) return null;
  if (!(receipt.askedWidth > 0 && receipt.askedHeight > 0)) return null;
  const grantedLandscape = receipt.actualWidth > receipt.actualHeight;
  const grantedPortrait = receipt.actualHeight > receipt.actualWidth;
  const askedPortrait = receipt.askedHeight > receipt.askedWidth;
  if (grantedLandscape && askedPortrait) {
    return 'Phone gave a sideways (landscape) picture — your project will frame it upright';
  }
  if (grantedPortrait) return 'Phone gave an upright (portrait) picture — your project will frame it to fit';
  if (grantedLandscape) return 'Phone gave a sideways (landscape) picture — your project will frame it to fit';
  return null;
}

/**
 * FINAL FIX Part 2 — the plain engine line for the review surface.
 * A take that fell back says so plainly (the new engine hit a
 * problem; the standard engine recorded it). A take the new engine
 * recorded names it and reports its own ledger in plain words —
 * frames recorded, frames dropped on purpose at its queue gate,
 * gaps filled — and says "no sound recorded" whenever the take is
 * video-only, so a silent prototype take is never discovered later.
 * Null for standard-engine takes: no claim is made for them.
 */
export function captureReceiptEngineNote(receipt: CaptureReceipt): string | null {
  const engine = receipt?.engine;
  if (!engine) return null;
  if (engine.fellBack) {
    return 'The new engine (test) hit a problem, so this take used the standard engine';
  }
  let line = 'Recorded with the new engine (test)';
  if (typeof engine.framesEncoded === 'number') {
    line += ` — ${engine.framesEncoded} frames`;
    if (typeof engine.framesDroppedByQueue === 'number' && engine.framesDroppedByQueue > 0) {
      line += `, ${engine.framesDroppedByQueue} dropped on purpose`;
    }
    if (typeof engine.framesFilled === 'number' && engine.framesFilled > 0) {
      line += `, ${engine.framesFilled} gaps filled`;
    }
  }
  if (engine.audioIncluded === false) line += ' · no sound recorded';
  return line;
}

export interface FormattedCaptureReceipt {
  /** e.g. "Recorded: 1080p · 30fps · high quality" */
  summary: string;
  /** Plain line for the default surface, e.g. "12 seconds · 8.4 MB". */
  details: string;
  /** Technical line for the "Details" expander only. */
  technicalDetails: string;
  /**
   * R41 WS-B — the asked-vs-granted line for the review SUMMARY
   * area (never only inside Details); null when the take carried
   * no recorded ask.
   */
  askedVsGranted: string | null;
  /** R41 WS-B — true when the final grant fell below the user's selected quality. */
  grantBelowAsked: boolean;
  /** R41 Step 3 Rung B — the frame-timing line for the review summary area; null when the take never faced the save step. */
  timingLine: string | null;
  /** R41 Step 3 Rung C — the orientation note for the review summary area; null when the orientations matched or are unknown. */
  orientationNote: string | null;
  /** FINAL FIX Part 2 — the engine line for the review summary area; null for standard-engine takes. */
  engineNote: string | null;
}

/**
 * R36 WS-4 — the receipt's plain smoothness verdict, from the SAME
 * estimate and the SAME threshold as the drop advisory: a measured
 * take under the advisory threshold earns "Smooth take"; a measured
 * take over it earns null here because the advisory
 * (`captureReceiptDropWarning`) already stands in its place; and a
 * receipt that never measured drops earns null — no estimate, no
 * verdict, never fabricated.
 */
export function captureReceiptSmoothnessVerdict(receipt: CaptureReceipt): string | null {
  if (typeof receipt.droppedFramesEstimate !== 'number') return null;
  return shouldWarnAboutDroppedFrames(receipt.droppedFramesEstimate, receipt.expectedFramesEstimate)
    ? null
    : 'Smooth take';
}

/**
 * Format a receipt for the review screen. The summary names the
 * achieved size by its short side ("1080p" for 1080×1920), the
 * achieved frame rate and the honest quality word; the plain
 * details line carries duration + file size plus, when the take was
 * measured smooth, the plain "Smooth take" verdict. Unknown facts
 * are left out rather than guessed. The technical line is kept
 * separate in `technicalDetails` for the expander.
 */
export function formatCaptureReceipt(receipt: CaptureReceipt): FormattedCaptureReceipt {
  const shortSide =
    receipt.actualWidth > 0 && receipt.actualHeight > 0 ? Math.min(receipt.actualWidth, receipt.actualHeight) : 0;
  const parts: string[] = [];
  if (shortSide > 0) parts.push(`${shortSide}p`);
  if (receipt.actualFps > 0) parts.push(`${receipt.actualFps}fps`);
  if (shortSide > 0) parts.push(`${qualityWordForShortSide(shortSide)} quality`);
  const summary = parts.length > 0 ? `Recorded: ${parts.join(' · ')}` : 'Recorded';

  const plainDetails = formatPlainDetails(receipt);
  const verdict = captureReceiptSmoothnessVerdict(receipt);
  const details = verdict ? (plainDetails ? `${plainDetails} · ${verdict}` : verdict) : plainDetails;

  return {
    summary,
    details,
    technicalDetails: formatTechnicalDetails(receipt),
    askedVsGranted: captureReceiptAskedVsGranted(receipt),
    grantBelowAsked: receiptGrantBelowAsked(receipt),
    timingLine: captureReceiptTimingLine(receipt),
    orientationNote: captureReceiptOrientationNote(receipt),
    engineNote: captureReceiptEngineNote(receipt),
  };
}

/**
 * R32 Phase 3 — the review screen's dropped-frame advisory for a
 * receipt: the plain warning line when the measured drops pass the
 * `frameDrops` thresholds (>2% of expected frames, or >30 frames
 * absolute, whichever trips first), otherwise null. A receipt that
 * never measured drops can never warn — no measurement, no claim.
 * Advisory only; the take is kept either way.
 */
export function captureReceiptDropWarning(receipt: CaptureReceipt): string | null {
  if (typeof receipt.droppedFramesEstimate !== 'number') return null;
  return shouldWarnAboutDroppedFrames(receipt.droppedFramesEstimate, receipt.expectedFramesEstimate)
    ? DROPPED_FRAMES_WARNING_TEXT
    : null;
}
