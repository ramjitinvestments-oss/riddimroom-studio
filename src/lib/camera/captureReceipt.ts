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
  };
  const dropped = input.droppedFramesEstimate;
  if (typeof dropped === 'number' && Number.isFinite(dropped) && dropped >= 0) {
    receipt.droppedFramesEstimate = Math.round(dropped);
    const expected = input.expectedFramesEstimate;
    if (typeof expected === 'number' && Number.isFinite(expected) && expected > 0) {
      receipt.expectedFramesEstimate = Math.round(expected);
    }
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

export interface FormattedCaptureReceipt {
  /** e.g. "Recorded: 1080p · 30fps · high quality" */
  summary: string;
  /** Plain line for the default surface, e.g. "12 seconds · 8.4 MB". */
  details: string;
  /** Technical line for the "Details" expander only. */
  technicalDetails: string;
}

/**
 * Format a receipt for the review screen. The summary names the
 * achieved size by its short side ("1080p" for 1080×1920), the
 * achieved frame rate and the honest quality word; the plain
 * details line carries duration + file size. Unknown facts are
 * left out rather than guessed. The technical line is kept
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

  return { summary, details: formatPlainDetails(receipt), technicalDetails: formatTechnicalDetails(receipt) };
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
