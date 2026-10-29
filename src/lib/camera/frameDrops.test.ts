import { describe, it, expect } from 'vitest';
import {
  DROPPED_FRAMES_WARNING_TEXT,
  computeFrameDropEstimate,
  createFrameDropTracker,
  droppedFramesWarning,
  shouldWarnAboutDroppedFrames,
  sampleFromVideoFrameMetadata,
  type VideoFrameCallbackHost,
  type VideoFrameSample,
} from './frameDrops';

/** Samples as rVFC would deliver them: a steady cadence at `fps`, `count` frames. */
function steadySamples(fps: number, count: number, startAt = 1000): VideoFrameSample[] {
  const interval = 1000 / fps;
  return Array.from({ length: count }, (_, i) => ({
    presentedFrames: i + 1,
    expectedDisplayTime: startAt + i * interval,
  }));
}

describe('sampleFromVideoFrameMetadata', () => {
  it('reduces a well-formed rVFC metadata object to the two used fields', () => {
    expect(
      sampleFromVideoFrameMetadata({ presentedFrames: 42, expectedDisplayTime: 1234.5, mediaTime: 1.4, width: 1920 }),
    ).toEqual({ presentedFrames: 42, expectedDisplayTime: 1234.5 });
  });

  it('returns null for malformed metadata', () => {
    expect(sampleFromVideoFrameMetadata(null)).toBeNull();
    expect(sampleFromVideoFrameMetadata(undefined)).toBeNull();
    expect(sampleFromVideoFrameMetadata({})).toBeNull();
    expect(sampleFromVideoFrameMetadata({ presentedFrames: '3', expectedDisplayTime: 10 })).toBeNull();
    expect(sampleFromVideoFrameMetadata({ presentedFrames: 3, expectedDisplayTime: Number.NaN })).toBeNull();
  });
});

describe('computeFrameDropEstimate', () => {
  it('reports zero drops when every expected frame was presented (30fps, 3s)', () => {
    // 91 samples = first + 90 more over exactly 3s at 30fps.
    const estimate = computeFrameDropEstimate(steadySamples(30, 91), 30);
    expect(estimate).toEqual({ presentedFrames: 90, expectedFrames: 90, droppedFramesEstimate: 0 });
  });

  it('counts the gap when frames are missing across the window', () => {
    // 3 seconds at a nominal 30fps should present 90 frames; only 75 arrived.
    const samples: VideoFrameSample[] = [
      { presentedFrames: 10, expectedDisplayTime: 0 },
      { presentedFrames: 55, expectedDisplayTime: 1500 },
      { presentedFrames: 85, expectedDisplayTime: 3000 },
    ];
    expect(computeFrameDropEstimate(samples, 30)).toEqual({
      presentedFrames: 75,
      expectedFrames: 90,
      droppedFramesEstimate: 15,
    });
  });

  it('works at 60fps', () => {
    const estimate = computeFrameDropEstimate(steadySamples(60, 121), 60);
    expect(estimate).toEqual({ presentedFrames: 120, expectedFrames: 120, droppedFramesEstimate: 0 });
  });

  it('floors the drop estimate at 0 when more frames arrive than the nominal rate predicts', () => {
    const samples: VideoFrameSample[] = [
      { presentedFrames: 0, expectedDisplayTime: 0 },
      { presentedFrames: 100, expectedDisplayTime: 3000 },
    ];
    expect(computeFrameDropEstimate(samples, 30)?.droppedFramesEstimate).toBe(0);
  });

  it('returns null for fewer than two samples', () => {
    expect(computeFrameDropEstimate([], 30)).toBeNull();
    expect(computeFrameDropEstimate([{ presentedFrames: 1, expectedDisplayTime: 0 }], 30)).toBeNull();
  });

  it('returns null for an unusable nominal frame rate', () => {
    const samples = steadySamples(30, 10);
    expect(computeFrameDropEstimate(samples, 0)).toBeNull();
    expect(computeFrameDropEstimate(samples, -30)).toBeNull();
    expect(computeFrameDropEstimate(samples, Number.NaN)).toBeNull();
  });

  it('returns null when no time elapsed between the first and last sample', () => {
    const samples: VideoFrameSample[] = [
      { presentedFrames: 1, expectedDisplayTime: 500 },
      { presentedFrames: 2, expectedDisplayTime: 500 },
    ];
    expect(computeFrameDropEstimate(samples, 30)).toBeNull();
  });

  it('returns null when the presented counter goes backwards (element reset)', () => {
    const samples: VideoFrameSample[] = [
      { presentedFrames: 500, expectedDisplayTime: 0 },
      { presentedFrames: 12, expectedDisplayTime: 3000 },
    ];
    expect(computeFrameDropEstimate(samples, 30)).toBeNull();
  });

  it('ignores malformed samples and uses the usable first/last pair', () => {
    const samples = [
      { presentedFrames: Number.NaN, expectedDisplayTime: 0 },
      { presentedFrames: 0, expectedDisplayTime: 0 },
      { presentedFrames: 30, expectedDisplayTime: 1000 },
    ] as VideoFrameSample[];
    expect(computeFrameDropEstimate(samples, 30)).toEqual({
      presentedFrames: 30,
      expectedFrames: 30,
      droppedFramesEstimate: 0,
    });
  });
});

describe('createFrameDropTracker', () => {
  /** A fake video element whose rVFC the test drives by hand. */
  function fakeHost() {
    let callback: ((now: number, metadata: unknown) => void) | null = null;
    const cancelled: number[] = [];
    const host: VideoFrameCallbackHost = {
      requestVideoFrameCallback: (cb) => {
        callback = cb;
        return 7;
      },
      cancelVideoFrameCallback: (handle) => {
        cancelled.push(handle);
      },
    };
    const present = (presentedFrames: number, expectedDisplayTime: number) => {
      const cb = callback;
      callback = null;
      cb?.(expectedDisplayTime, { presentedFrames, expectedDisplayTime });
    };
    return { host, present, cancelled };
  }

  it('accumulates samples through rVFC and estimates on stop', () => {
    const { host, present, cancelled } = fakeHost();
    const tracker = createFrameDropTracker({ nominalFps: 30 });
    tracker.start(host);
    expect(tracker.available).toBe(true);
    present(1, 0);
    present(46, 1500);
    present(76, 3000); // 75 presented over 3s at 30fps → 15 dropped
    expect(tracker.stop()).toEqual({ presentedFrames: 75, expectedFrames: 90, droppedFramesEstimate: 15 });
    expect(cancelled).toEqual([7]);
  });

  it('returns null after stop when a second stop is attempted', () => {
    const { host, present } = fakeHost();
    const tracker = createFrameDropTracker({ nominalFps: 30 });
    tracker.start(host);
    present(1, 0);
    present(31, 1000);
    expect(tracker.stop()).not.toBeNull();
    expect(tracker.stop()).toBeNull();
    expect(tracker.available).toBe(false);
  });

  it('stays unavailable and returns null when the element has no rVFC — never fabricates', () => {
    const tracker = createFrameDropTracker({ nominalFps: 30 });
    tracker.start({});
    expect(tracker.available).toBe(false);
    expect(tracker.stop()).toBeNull();
  });

  it('returns null when no frame was ever presented', () => {
    const { host } = fakeHost();
    const tracker = createFrameDropTracker({ nominalFps: 30 });
    tracker.start(host);
    expect(tracker.stop()).toBeNull();
  });
});

describe('dropped-frame review warning (R32 Phase 3)', () => {
  it('stays silent for clean and near-clean takes', () => {
    expect(shouldWarnAboutDroppedFrames(0, 900)).toBe(false);
    // 18 of 900 = exactly 2% — the arm trips only ABOVE 2%.
    expect(shouldWarnAboutDroppedFrames(18, 900)).toBe(false);
    expect(shouldWarnAboutDroppedFrames(10, 900)).toBe(false);
  });

  it('trips on the relative arm above 2% of expected frames', () => {
    expect(shouldWarnAboutDroppedFrames(19, 900)).toBe(true);
    // Short take: 5 dropped of 100 expected = 5% — warns long before the absolute arm.
    expect(shouldWarnAboutDroppedFrames(5, 100)).toBe(true);
  });

  it('trips on the absolute arm above 30 frames even at a tiny percentage', () => {
    // 31 of 18,000 (a long 60fps take) is ~0.17% — still a full half-second of missing pictures.
    expect(shouldWarnAboutDroppedFrames(31, 18000)).toBe(true);
    expect(shouldWarnAboutDroppedFrames(30, 18000)).toBe(false);
  });

  it('judges by the absolute arm alone when no expected count exists', () => {
    expect(shouldWarnAboutDroppedFrames(31, null)).toBe(true);
    expect(shouldWarnAboutDroppedFrames(31, undefined)).toBe(true);
    expect(shouldWarnAboutDroppedFrames(12, null)).toBe(false);
  });

  it('never warns on unusable input', () => {
    expect(shouldWarnAboutDroppedFrames(Number.NaN, 900)).toBe(false);
    expect(shouldWarnAboutDroppedFrames(-4, 900)).toBe(false);
    expect(shouldWarnAboutDroppedFrames(50, Number.NaN)).toBe(true); // absolute arm still judges
  });

  it('maps a finished estimate to the exact advisory line, or null', () => {
    expect(
      droppedFramesWarning({ presentedFrames: 81, expectedFrames: 90, droppedFramesEstimate: 9 }),
    ).toBe(DROPPED_FRAMES_WARNING_TEXT);
    expect(DROPPED_FRAMES_WARNING_TEXT).toBe('This take dropped frames — a retake may look smoother');
    expect(
      droppedFramesWarning({ presentedFrames: 90, expectedFrames: 90, droppedFramesEstimate: 0 }),
    ).toBeNull();
    expect(droppedFramesWarning(null)).toBeNull();
    expect(droppedFramesWarning(undefined)).toBeNull();
  });
});
