import { describe, it, expect } from 'vitest';
import { createRawFrameSeriesRecorder, type VideoFrameCallbackHost } from './frameDrops';

describe('createRawFrameSeriesRecorder (R41 WS-A) — VIEWFINDER frame series', () => {
  function fakeHost() {
    let callback: ((now: number, metadata: unknown) => void) | null = null;
    const cancelled: number[] = [];
    const host: VideoFrameCallbackHost = {
      requestVideoFrameCallback: (cb) => {
        callback = cb;
        return 9;
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

  it('records EVERY presented frame timestamp + counter, in order', () => {
    const { host, present, cancelled } = fakeHost();
    const recorder = createRawFrameSeriesRecorder();
    recorder.start(host);
    expect(recorder.available).toBe(true);
    present(1, 1000);
    present(2, 1016.7);
    present(3, 1050);
    const series = recorder.stop();
    expect(series.timestampsMs).toEqual([1000, 1016.7, 1050]);
    expect(series.presentedFrames).toEqual([1, 2, 3]);
    expect(cancelled).toEqual([9]);
    expect(recorder.available).toBe(false);
  });

  it('the returned series is a copy — later mutation cannot rewrite the evidence', () => {
    const { host, present } = fakeHost();
    const recorder = createRawFrameSeriesRecorder();
    recorder.start(host);
    present(1, 0);
    present(2, 33);
    const a = recorder.stop();
    a.timestampsMs.push(99999);
    expect(recorder.series().timestampsMs).toEqual([0, 33]);
  });

  it('no rVFC → an EMPTY series and unavailable, never fabricated', () => {
    const recorder = createRawFrameSeriesRecorder();
    recorder.start({});
    expect(recorder.available).toBe(false);
    expect(recorder.stop()).toEqual({ timestampsMs: [], presentedFrames: [] });
  });

  it('stop is idempotent and a mid-recording snapshot is available', () => {
    const { host, present } = fakeHost();
    const recorder = createRawFrameSeriesRecorder();
    recorder.start(host);
    present(1, 0);
    expect(recorder.series().timestampsMs).toEqual([0]);
    present(2, 16.7);
    expect(recorder.stop().timestampsMs).toEqual([0, 16.7]);
    expect(recorder.stop().timestampsMs).toEqual([0, 16.7]);
  });
});
