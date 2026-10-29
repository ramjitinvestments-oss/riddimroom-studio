import { describe, it, expect } from 'vitest';
import {
  buildCaptureReceipt,
  captureReceiptDropWarning,
  codecNameForMimeType,
  formatBitrateBps,
  formatCaptureReceipt,
  formatDurationSeconds,
  formatFileSizeBytes,
  formatPlainDetails,
  formatTechnicalDetails,
  qualityWordForShortSide,
} from './captureReceipt';

describe('buildCaptureReceipt', () => {
  it('builds from track settings + recorder mime + measured blob bitrate', () => {
    const receipt = buildCaptureReceipt({
      trackSettings: { width: 1080, height: 1920, frameRate: 30 },
      mimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2',
      blobSize: 12_250_000, // bytes
      durationSeconds: 10,
    });
    expect(receipt.actualWidth).toBe(1080);
    expect(receipt.actualHeight).toBe(1920);
    expect(receipt.actualFps).toBe(30);
    expect(receipt.mimeType).toBe('video/mp4;codecs=avc1.640028,mp4a.40.2');
    // 12.25 MB over 10s = 9.8 Mbps measured — not the requested tier.
    expect(receipt.videoBitrateBps).toBe(9_800_000);
    expect(receipt.blobSizeBytes).toBe(12_250_000);
    expect(receipt.durationSeconds).toBe(10);
    expect(receipt.droppedFramesEstimate).toBeUndefined();
  });

  it('rounds the negotiated frame rate (29.97 reads as 30)', () => {
    const receipt = buildCaptureReceipt({
      trackSettings: { width: 1920, height: 1080, frameRate: 29.97 },
      mimeType: 'video/webm',
      blobSize: 1000,
      durationSeconds: 1,
    });
    expect(receipt.actualFps).toBe(30);
  });

  it('includes the dropped-frame estimate only when one was measured', () => {
    const base = {
      trackSettings: { width: 1920, height: 1080, frameRate: 30 },
      mimeType: 'video/webm',
      blobSize: 1000,
      durationSeconds: 1,
    };
    expect(buildCaptureReceipt({ ...base, droppedFramesEstimate: 12 }).droppedFramesEstimate).toBe(12);
    expect(buildCaptureReceipt({ ...base, droppedFramesEstimate: 0 }).droppedFramesEstimate).toBe(0);
    expect(buildCaptureReceipt({ ...base, droppedFramesEstimate: null }).droppedFramesEstimate).toBeUndefined();
    expect(buildCaptureReceipt({ ...base, droppedFramesEstimate: -3 }).droppedFramesEstimate).toBeUndefined();
  });

  it('reports 0 bitrate and 0 size when the facts are unmeasurable — never guesses', () => {
    const receipt = buildCaptureReceipt({
      trackSettings: null,
      mimeType: '',
      blobSize: 5000,
      durationSeconds: 0,
    });
    expect(receipt.actualWidth).toBe(0);
    expect(receipt.actualHeight).toBe(0);
    expect(receipt.actualFps).toBe(0);
    expect(receipt.videoBitrateBps).toBe(0);
    expect(receipt.blobSizeBytes).toBe(5000);
    expect(receipt.durationSeconds).toBe(0);
  });
});

describe('formatFileSizeBytes / formatDurationSeconds (plain surface)', () => {
  it('formats file size in plain MB units', () => {
    expect(formatFileSizeBytes(8_400_000)).toBe('8.4 MB');
    expect(formatFileSizeBytes(12_250_000)).toBe('12.3 MB');
    expect(formatFileSizeBytes(850_000)).toBe('850 KB');
    expect(formatFileSizeBytes(0)).toBe('');
  });

  it('formats duration in plain seconds / minutes', () => {
    expect(formatDurationSeconds(12)).toBe('12 seconds');
    expect(formatDurationSeconds(1)).toBe('1 second');
    expect(formatDurationSeconds(65)).toBe('1 minute 5 seconds');
    expect(formatDurationSeconds(0)).toBe('');
  });
});

describe('qualityWordForShortSide', () => {
  it('maps the honest bands', () => {
    expect(qualityWordForShortSide(2160)).toBe('ultra');
    expect(qualityWordForShortSide(2000)).toBe('ultra');
    expect(qualityWordForShortSide(1440)).toBe('high');
    expect(qualityWordForShortSide(1080)).toBe('high');
    expect(qualityWordForShortSide(1000)).toBe('high');
    expect(qualityWordForShortSide(999)).toBe('standard');
    expect(qualityWordForShortSide(720)).toBe('standard');
    expect(qualityWordForShortSide(719)).toBe('low');
    expect(qualityWordForShortSide(480)).toBe('low');
  });
});

describe('codecNameForMimeType', () => {
  it('names the common recorder codecs in plain form', () => {
    expect(codecNameForMimeType('video/mp4;codecs=avc1.640028,mp4a.40.2')).toBe('H.264');
    expect(codecNameForMimeType('video/mp4')).toBe('H.264');
    expect(codecNameForMimeType('video/webm;codecs=vp9,opus')).toBe('VP9');
    expect(codecNameForMimeType('video/webm;codecs=vp8,opus')).toBe('VP8');
    expect(codecNameForMimeType('video/webm')).toBe('WebM');
    expect(codecNameForMimeType('')).toBe('Browser default');
  });
});

describe('formatBitrateBps', () => {
  it('formats Mbps with one decimal, Kbps whole, and empty for unmeasurable', () => {
    expect(formatBitrateBps(9_800_000)).toBe('9.8 Mbps');
    expect(formatBitrateBps(45_000_000)).toBe('45.0 Mbps');
    expect(formatBitrateBps(850_000)).toBe('850 Kbps');
    expect(formatBitrateBps(400)).toBe('400 bps');
    expect(formatBitrateBps(0)).toBe('');
  });
});

describe('formatCaptureReceipt — plain default surface (R34 UX-34)', () => {
  it('formats the headline receipt: size by short side, fps, honest quality word', () => {
    const formatted = formatCaptureReceipt(
      buildCaptureReceipt({
        trackSettings: { width: 1080, height: 1920, frameRate: 30 },
        mimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2',
        blobSize: 12_250_000,
        durationSeconds: 10,
      }),
    );
    expect(formatted.summary).toBe('Recorded: 1080p · 30fps · high quality');
    expect(formatted.details).toBe('10 seconds · 12.3 MB');
    expect(formatted.technicalDetails).toBe('H.264 · 9.8 Mbps');
  });

  it('portrait and landscape of the same class read the same', () => {
    const formatted = formatCaptureReceipt(
      buildCaptureReceipt({
        trackSettings: { width: 3840, height: 2160, frameRate: 60 },
        mimeType: 'video/webm;codecs=vp9,opus',
        blobSize: 100_000_000,
        durationSeconds: 10,
      }),
    );
    expect(formatted.summary).toBe('Recorded: 2160p · 60fps · ultra quality');
    expect(formatted.details).toBe('10 seconds · 100.0 MB');
    expect(formatted.technicalDetails).toBe('VP9 · 80.0 Mbps');
  });

  it('a 720p capture honestly reads standard quality', () => {
    const formatted = formatCaptureReceipt(
      buildCaptureReceipt({
        trackSettings: { width: 720, height: 1280, frameRate: 30 },
        mimeType: 'video/webm;codecs=vp8,opus',
        blobSize: 3_000_000,
        durationSeconds: 5,
      }),
    );
    expect(formatted.summary).toBe('Recorded: 720p · 30fps · standard quality');
    expect(formatted.details).toBe('5 seconds · 3.0 MB');
    expect(formatted.technicalDetails).toBe('VP8 · 4.8 Mbps');
  });

  it('the plain surface (summary + details) is free of codec / bitrate tokens', () => {
    const banned = ['H.264', 'Mbps', 'Kbps', 'VP9', 'VP8', 'AV1', 'bps'];
    const samples = [
      buildCaptureReceipt({
        trackSettings: { width: 1080, height: 1920, frameRate: 30 },
        mimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2',
        blobSize: 12_250_000,
        durationSeconds: 10,
        droppedFramesEstimate: 14,
      }),
      buildCaptureReceipt({
        trackSettings: { width: 3840, height: 2160, frameRate: 60 },
        mimeType: 'video/webm;codecs=vp9,opus',
        blobSize: 100_000_000,
        durationSeconds: 10,
      }),
      buildCaptureReceipt({
        trackSettings: { width: 720, height: 1280, frameRate: 30 },
        mimeType: 'video/webm;codecs=vp8,opus',
        blobSize: 3_000_000,
        durationSeconds: 5,
      }),
    ];
    for (const receipt of samples) {
      const formatted = formatCaptureReceipt(receipt);
      const plainSurface = `${formatted.summary} ${formatted.details} ${formatPlainDetails(receipt)}`;
      for (const token of banned) {
        expect(plainSurface, `plain surface must not contain "${token}"`).not.toContain(token);
      }
    }
  });

  it('omits unknown facts instead of guessing them', () => {
    const formatted = formatCaptureReceipt(
      buildCaptureReceipt({ trackSettings: null, mimeType: '', blobSize: 0, durationSeconds: 0 }),
    );
    expect(formatted.summary).toBe('Recorded');
    expect(formatted.details).toBe('');
    expect(formatted.technicalDetails).toBe('Browser default');
  });
});

describe('formatTechnicalDetails — expander only, tested separately', () => {
  it('adds the dropped-frames segment only when measured, and says so plainly at zero', () => {
    const withDrops = formatTechnicalDetails(
      buildCaptureReceipt({
        trackSettings: { width: 1920, height: 1080, frameRate: 30 },
        mimeType: 'video/mp4',
        blobSize: 12_250_000,
        durationSeconds: 10,
        droppedFramesEstimate: 14,
      }),
    );
    expect(withDrops).toBe('H.264 · 9.8 Mbps · about 14 dropped frames');
    const noDrops = formatTechnicalDetails(
      buildCaptureReceipt({
        trackSettings: { width: 1920, height: 1080, frameRate: 30 },
        mimeType: 'video/mp4',
        blobSize: 12_250_000,
        durationSeconds: 10,
        droppedFramesEstimate: 0,
      }),
    );
    expect(noDrops).toBe('H.264 · 9.8 Mbps · no dropped frames spotted');
    // No measurement -> no dropped-frames segment at all (never fabricated).
    const unmeasured = formatTechnicalDetails(
      buildCaptureReceipt({
        trackSettings: { width: 1920, height: 1080, frameRate: 30 },
        mimeType: 'video/mp4',
        blobSize: 12_250_000,
        durationSeconds: 10,
      }),
    );
    expect(unmeasured).toBe('H.264 · 9.8 Mbps');
  });
});

describe('expected frames + drop warning (R32 Phase 3)', () => {
  const base = {
    trackSettings: { width: 1920, height: 1080, frameRate: 30 },
    mimeType: 'video/mp4',
    blobSize: 1_000_000,
    durationSeconds: 10,
  };

  it('carries the expected count only alongside a measured drop estimate', () => {
    const withBoth = buildCaptureReceipt({ ...base, droppedFramesEstimate: 9, expectedFramesEstimate: 90 });
    expect(withBoth.droppedFramesEstimate).toBe(9);
    expect(withBoth.expectedFramesEstimate).toBe(90);
    const droppedOnly = buildCaptureReceipt({ ...base, droppedFramesEstimate: 9 });
    expect(droppedOnly.expectedFramesEstimate).toBeUndefined();
    const expectedOnly = buildCaptureReceipt({ ...base, expectedFramesEstimate: 90 });
    expect(expectedOnly.droppedFramesEstimate).toBeUndefined();
    expect(expectedOnly.expectedFramesEstimate).toBeUndefined();
  });

  it('warns from the receipt when drops pass either threshold', () => {
    // 9 of 90 = 10% — relative arm.
    expect(
      captureReceiptDropWarning(buildCaptureReceipt({ ...base, droppedFramesEstimate: 9, expectedFramesEstimate: 90 })),
    ).toBe('This take dropped frames — a retake may look smoother');
    // 40 of 100,000 — absolute arm, no meaningful percentage.
    expect(
      captureReceiptDropWarning(
        buildCaptureReceipt({ ...base, droppedFramesEstimate: 40, expectedFramesEstimate: 100000 }),
      ),
    ).not.toBeNull();
  });

  it('stays silent for a clean take and for a receipt that never measured drops', () => {
    expect(
      captureReceiptDropWarning(buildCaptureReceipt({ ...base, droppedFramesEstimate: 0, expectedFramesEstimate: 90 })),
    ).toBeNull();
    expect(captureReceiptDropWarning(buildCaptureReceipt({ ...base }))).toBeNull();
  });
});
