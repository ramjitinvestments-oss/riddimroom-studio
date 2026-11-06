import { describe, it, expect } from 'vitest';
import {
  askedVsGrantedLine,
  buildCaptureReceipt,
  captureReceiptAskedVsGranted,
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
