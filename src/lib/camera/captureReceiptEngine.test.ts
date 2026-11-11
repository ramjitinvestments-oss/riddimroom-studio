/**
 * FINAL FIX Part 2 — the capture receipt's engine record: the new
 * engine is named, its own ledger is carried, a fallback is
 * disclosed in plain words, a video-only take says it has no sound,
 * and a standard-engine take carries no engine claim at all.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCaptureReceipt,
  captureReceiptEngineNote,
  formatCaptureReceipt,
  type CaptureReceiptInput,
} from './captureReceipt';

const baseInput: CaptureReceiptInput = {
  trackSettings: { width: 3840, height: 2160, frameRate: 30 },
  mimeType: 'video/mp4',
  blobSize: 90_000_000,
  durationSeconds: 60,
};

describe('capture receipt — engine record', () => {
  it('a standard-engine take carries no engine block and no engine note', () => {
    const receipt = buildCaptureReceipt({ ...baseInput });
    expect(receipt.engine).toBeUndefined();
    expect(captureReceiptEngineNote(receipt)).toBeNull();
    expect(formatCaptureReceipt(receipt).engineNote).toBeNull();
  });

  it('a new-engine take names the engine and reports its ledger in plain words', () => {
    const receipt = buildCaptureReceipt({
      ...baseInput,
      engine: {
        kind: 'webcodecs',
        fellBack: false,
        framesReceived: 1804,
        framesEncoded: 1797,
        framesDroppedByQueue: 3,
        framesFilled: 12,
        audioIncluded: true,
      },
    });
    expect(receipt.engine).toEqual({
      kind: 'webcodecs',
      fellBack: false,
      framesReceived: 1804,
      framesEncoded: 1797,
      framesDroppedByQueue: 3,
      framesFilled: 12,
      audioIncluded: true,
    });
    expect(captureReceiptEngineNote(receipt)).toBe(
      'Recorded with the new engine — 1797 frames, 3 dropped on purpose, 12 gaps filled',
    );
  });

  it('zero drops and zero fills stay off the line (no noise claims)', () => {
    const receipt = buildCaptureReceipt({
      ...baseInput,
      engine: { kind: 'webcodecs', fellBack: false, framesEncoded: 1800, framesDroppedByQueue: 0, framesFilled: 0, audioIncluded: true },
    });
    expect(captureReceiptEngineNote(receipt)).toBe('Recorded with the new engine — 1800 frames');
  });

  it('a video-only new-engine take says it has no sound', () => {
    const receipt = buildCaptureReceipt({
      ...baseInput,
      engine: { kind: 'webcodecs', fellBack: false, framesEncoded: 1800, audioIncluded: false },
    });
    expect(captureReceiptEngineNote(receipt)).toContain('no sound recorded');
  });

  it('a fallback take discloses it plainly — the standard engine recorded it', () => {
    const receipt = buildCaptureReceipt({
      ...baseInput,
      engine: { kind: 'webcodecs', fellBack: true },
    });
    expect(receipt.engine?.fellBack).toBe(true);
    expect(captureReceiptEngineNote(receipt)).toBe(
      'The new engine hit a problem, so this take used the standard engine',
    );
    expect(formatCaptureReceipt(receipt).engineNote).toBe(
      'The new engine hit a problem, so this take used the standard engine',
    );
  });

  it('junk counts are sanitised away, never carried into the receipt', () => {
    const receipt = buildCaptureReceipt({
      ...baseInput,
      engine: {
        kind: 'webcodecs',
        fellBack: false,
        framesEncoded: Number.NaN,
        framesDroppedByQueue: -4,
        framesFilled: 12.6,
      },
    });
    expect(receipt.engine?.framesEncoded).toBeUndefined();
    expect(receipt.engine?.framesDroppedByQueue).toBeUndefined();
    expect(receipt.engine?.framesFilled).toBe(13);
  });
});
