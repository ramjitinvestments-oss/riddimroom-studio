import { describe, it, expect } from 'vitest';
import {
  askedVsGrantedLine,
  buildCaptureReceipt,
  captureReceiptAskedVsGranted,
  captureReceiptOrientationNote,
  captureReceiptTimingLine,
  formatCaptureReceipt,
  receiptGrantBelowAsked,
  resolutionLabelForShortSide,
} from './captureReceipt';

const base = { mimeType: 'video/mp4', blobSize: 1_000_000, durationSeconds: 10 };

describe('resolutionLabelForShortSide', () => {
  it('the 2160 class reads 4K; other classes read by pixels; unknown reads empty', () => {
    expect(resolutionLabelForShortSide(2160)).toBe('4K');
    expect(resolutionLabelForShortSide(3840)).toBe('4K');
    expect(resolutionLabelForShortSide(1440)).toBe('1440p');
    expect(resolutionLabelForShortSide(1080)).toBe('1080p');
    expect(resolutionLabelForShortSide(720)).toBe('720p');
    expect(resolutionLabelForShortSide(0)).toBe('');
  });
});

describe('askedVsGrantedLine — the plain receipt line (R41 WS-B)', () => {
  it('match: "Asked: 4K · 60 — Phone gave: 4K · 60 ✓"', () => {
    expect(askedVsGrantedLine({ shortSide: 2160, frameRate: 60 }, { shortSide: 2160, frameRate: 60 })).toBe(
      'Asked: 4K · 60 — Phone gave: 4K · 60 ✓',
    );
  });

  it('below: names the browser limit plainly', () => {
    expect(askedVsGrantedLine({ shortSide: 2160, frameRate: 60 }, { shortSide: 1080, frameRate: 60 })).toBe(
      "Asked: 4K · 60 — Phone gave: 1080p · 60 — that's this browser's limit on this camera",
    );
    // Below on frame rate alone also reads below.
    expect(askedVsGrantedLine({ shortSide: 2160, frameRate: 60 }, { shortSide: 2160, frameRate: 30 })).toContain(
      "that's this browser's limit",
    );
  });

  it('null when either side cannot be stated honestly', () => {
    expect(askedVsGrantedLine(null, { shortSide: 1080, frameRate: 60 })).toBeNull();
    expect(askedVsGrantedLine({ shortSide: 2160, frameRate: 60 }, { shortSide: 0, frameRate: 0 })).toBeNull();
    expect(askedVsGrantedLine({ shortSide: 0, frameRate: 0 }, null)).toBeNull();
  });
});

describe('receipt asked-vs-granted (R41 WS-B)', () => {
  it('carries the ask + negotiation outcome, compatibly with the existing shape', () => {
    const receipt = buildCaptureReceipt({
      ...base,
      trackSettings: { width: 1080, height: 1920, frameRate: 60 },
      asked: { shortSide: 2160, frameRate: 60 },
      exactRetryAttempted: true,
      exactRetryUsed: false,
    });
    expect(receipt.askedShortSide).toBe(2160);
    expect(receipt.askedFps).toBe(60);
    expect(receipt.exactRetryAttempted).toBe(true);
    expect(receipt.exactRetryUsed).toBeUndefined();
    // Existing fields are untouched.
    expect(receipt.actualWidth).toBe(1080);
    expect(receipt.actualFps).toBe(60);
    expect(captureReceiptAskedVsGranted(receipt)).toBe(
      "Asked: 4K · 60 — Phone gave: 1080p · 60 — that's this browser's limit on this camera",
    );
    expect(receiptGrantBelowAsked(receipt)).toBe(true);
    const formatted = formatCaptureReceipt(receipt);
    expect(formatted.askedVsGranted).toBe(captureReceiptAskedVsGranted(receipt));
    expect(formatted.grantBelowAsked).toBe(true);
    // The summary + details surfaces stay exactly as before.
    expect(formatted.summary).toBe('Recorded: 1080p · 60fps · high quality');
  });

  it('a matching grant formats with the tick and no below flag', () => {
    const receipt = buildCaptureReceipt({
      ...base,
      trackSettings: { width: 2160, height: 3840, frameRate: 60 },
      asked: { shortSide: 2160, frameRate: 60 },
    });
    expect(formatCaptureReceipt(receipt).askedVsGranted).toBe('Asked: 4K · 60 — Phone gave: 4K · 60 ✓');
    expect(formatCaptureReceipt(receipt).grantBelowAsked).toBe(false);
    expect(receiptGrantBelowAsked(receipt)).toBe(false);
  });

  it('a take with no recorded ask (the pre-R41 / dual shape) gets no line and no below flag', () => {
    const receipt = buildCaptureReceipt({ ...base, trackSettings: { width: 1080, height: 1920, frameRate: 30 } });
    expect(receipt.askedShortSide).toBe(0);
    expect(receipt.askedFps).toBe(0);
    expect(formatCaptureReceipt(receipt).askedVsGranted).toBeNull();
    expect(formatCaptureReceipt(receipt).grantBelowAsked).toBe(false);
  });

  it('an unusable ask is stored as 0, never guessed', () => {
    const receipt = buildCaptureReceipt({
      ...base,
      trackSettings: { width: 1080, height: 1920, frameRate: 30 },
      asked: { shortSide: Number.NaN, frameRate: -5 },
    });
    expect(receipt.askedShortSide).toBe(0);
    expect(receipt.askedFps).toBe(0);
  });
});

describe('R41 Step 3 Rung C — the orientation note on the receipt', () => {
  it('the phone\'s normal shape: a portrait ask granted landscape reads the upright-framing line', () => {
    const receipt = buildCaptureReceipt({
      ...base,
      trackSettings: { width: 3060, height: 2160, frameRate: 30 },
      asked: { shortSide: 2160, frameRate: 30, width: 2160, height: 3840 },
      orientationMismatch: true,
    });
    expect(receipt.askedWidth).toBe(2160);
    expect(receipt.askedHeight).toBe(3840);
    expect(receipt.orientationMismatch).toBe(true);
    expect(captureReceiptOrientationNote(receipt)).toBe(
      'Phone gave a sideways (landscape) picture — your project will frame it upright',
    );
    expect(formatCaptureReceipt(receipt).orientationNote).toBe(
      'Phone gave a sideways (landscape) picture — your project will frame it upright',
    );
  });

  it('a landscape ask granted portrait reads the mirrored line', () => {
    const receipt = buildCaptureReceipt({
      ...base,
      trackSettings: { width: 1080, height: 1920, frameRate: 30 },
      asked: { shortSide: 1080, frameRate: 30, width: 1920, height: 1080 },
      orientationMismatch: true,
    });
    expect(captureReceiptOrientationNote(receipt)).toBe(
      'Phone gave an upright (portrait) picture — your project will frame it to fit',
    );
  });

  it('no mismatch (or none recorded) reads no note — matched takes stay quiet', () => {
    const matched = buildCaptureReceipt({
      ...base,
      trackSettings: { width: 2160, height: 3840, frameRate: 30 },
      asked: { shortSide: 2160, frameRate: 30, width: 2160, height: 3840 },
      orientationMismatch: false,
    });
    expect(captureReceiptOrientationNote(matched)).toBeNull();
    const unrecorded = buildCaptureReceipt({
      ...base,
      trackSettings: { width: 3060, height: 2160, frameRate: 30 },
    });
    expect(unrecorded.orientationMismatch).toBeUndefined();
    expect(captureReceiptOrientationNote(unrecorded)).toBeNull();
    expect(formatCaptureReceipt(unrecorded).orientationNote).toBeNull();
  });

  it('a mismatch with unknown asked dimensions stays silent rather than guessing', () => {
    const receipt = buildCaptureReceipt({
      ...base,
      trackSettings: { width: 3060, height: 2160, frameRate: 30 },
      orientationMismatch: true,
    });
    expect(captureReceiptOrientationNote(receipt)).toBeNull();
  });
});

describe('R41 Step 3 Rung B — the timing line on the receipt', () => {
  it('a steadied take reads "Steadied to an even 30fps" (the granted rate)', () => {
    const receipt = buildCaptureReceipt({
      ...base,
      trackSettings: { width: 3000, height: 2160, frameRate: 30 },
      timingOutcome: 'steadied',
    });
    expect(captureReceiptTimingLine(receipt)).toBe('Steadied to an even 30fps');
    expect(formatCaptureReceipt(receipt).timingLine).toBe('Steadied to an even 30fps');
  });

  it('the steadied rate wins over the recorded rate when both exist', () => {
    const receipt = buildCaptureReceipt({
      ...base,
      trackSettings: { width: 3000, height: 2160, frameRate: 30 },
      timingOutcome: 'steadied',
      steadiedFps: 60,
    });
    expect(captureReceiptTimingLine(receipt)).toBe('Steadied to an even 60fps');
  });

  it('a kept original reads "Original timing kept" — whatever the reason', () => {
    const receipt = buildCaptureReceipt({
      ...base,
      trackSettings: { width: 3000, height: 2160, frameRate: 30 },
      timingOutcome: 'original',
    });
    expect(captureReceiptTimingLine(receipt)).toBe('Original timing kept');
  });

  it('a take with no recorded outcome (older receipts) reads no timing line', () => {
    const receipt = buildCaptureReceipt({
      ...base,
      trackSettings: { width: 3000, height: 2160, frameRate: 30 },
    });
    expect(receipt.timingOutcome).toBeUndefined();
    expect(captureReceiptTimingLine(receipt)).toBeNull();
    expect(formatCaptureReceipt(receipt).timingLine).toBeNull();
  });
});
