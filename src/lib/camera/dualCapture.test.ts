import { describe, it, expect } from 'vitest';
import { buildCaptureAttempts, recorderOptionsForTrackSettings } from './captureQuality';
import {
  DUAL_UNAVAILABLE_MESSAGE,
  buildDualFrontAttempts,
  buildDualRearAttempts,
  dualAlignmentTrims,
  dualStartDeltaMs,
  probeDualCamera,
  stepDownCaptureAttempts,
} from './dualCapture';
import type { CaptureAttempt } from './captureQuality';

function videoOf(attempt: CaptureAttempt): MediaTrackConstraints {
  return attempt.constraints.video as MediaTrackConstraints;
}

interface FakeTrack {
  kind: string;
  readyState: string;
  muted: boolean;
  stopped: boolean;
  stop: () => void;
}

function makeFakeStream(opts: { readyState?: string; muted?: boolean } = {}): {
  stream: MediaStream;
  track: FakeTrack;
} {
  const track: FakeTrack = {
    kind: 'video',
    readyState: opts.readyState ?? 'live',
    muted: opts.muted ?? false,
    stopped: false,
    stop() {
      this.stopped = true;
      this.readyState = 'ended';
    },
  };
  const stream = {
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
    getTracks: () => [track],
  };
  return { stream: stream as unknown as MediaStream, track };
}

const CANVAS = { canvasWidth: 1080, canvasHeight: 1920 };

function rearAttempts() {
  return buildDualRearAttempts({ ...CANVAS, quality: 'auto', frameRate: 60 });
}

function frontAttempts() {
  return buildDualFrontAttempts(CANVAS);
}

describe('DUAL_UNAVAILABLE_MESSAGE', () => {
  it('is the exact fallback wording', () => {
    expect(DUAL_UNAVAILABLE_MESSAGE).toBe(
      "This phone can't run both cameras at once in the browser — recording with one camera instead",
    );
  });
});

describe('stepDownCaptureAttempts', () => {
  it('steps the auto/60 ladder down one tier, dedupes, and flags only the last rung as fallback', () => {
    const input = buildCaptureAttempts({
      canvasWidth: 1080,
      canvasHeight: 1920,
      facingMode: 'user',
      quality: 'auto',
      frameRate: 60,
    });
    const result = stepDownCaptureAttempts(input, 1080, 1920);
    expect(result.map((a) => a.shortSide)).toEqual([1440, 1080, 1080]);
    expect(result.map((a) => a.frameRate)).toEqual([60, 60, 30]);
    expect(result.slice(0, -1).every((a) => !a.isFallback)).toBe(true);
    expect(result[result.length - 1].isFallback).toBe(true);
    // Audio flag and facing mode are preserved in the rebuilt constraints.
    for (const attempt of result) {
      expect(attempt.constraints.audio).toBe(true);
      expect(videoOf(attempt).facingMode).toBe('user');
    }
  });

  it('keeps the hd ladder at [1080@60, 1080@30] (the floor)', () => {
    const input = buildCaptureAttempts({
      canvasWidth: 1920,
      canvasHeight: 1080,
      facingMode: 'environment',
      quality: 'hd',
      frameRate: 60,
    });
    const result = stepDownCaptureAttempts(input, 1920, 1080);
    expect(result.map((a) => [a.shortSide, a.frameRate])).toEqual([
      [1080, 60],
      [1080, 30],
    ]);
    expect(result[result.length - 1].isFallback).toBe(true);
    expect(result[0].isFallback).toBe(false);
  });

  it('never returns an empty array', () => {
    expect(stepDownCaptureAttempts([], 1080, 1920).length).toBeGreaterThan(0);
  });
});

describe('buildDualRearAttempts', () => {
  it('faces the environment camera, keeps audio, and starts at or below 1440 for auto', () => {
    const attempts = buildDualRearAttempts({ ...CANVAS, quality: 'auto', frameRate: 60 });
    expect(attempts.length).toBeGreaterThan(0);
    for (const attempt of attempts) {
      expect(videoOf(attempt).facingMode).toBe('environment');
      expect(attempt.constraints.audio).toBe(true);
    }
    expect(attempts[0].shortSide).toBeLessThanOrEqual(1440);
  });
});

describe('buildDualFrontAttempts', () => {
  it('is video-only, user-facing, 30fps, with 1080 then 720 rungs', () => {
    const attempts = buildDualFrontAttempts(CANVAS);
    expect(attempts.map((a) => a.shortSide)).toEqual([1080, 720]);
    expect(attempts.map((a) => a.isFallback)).toEqual([false, true]);
    for (const attempt of attempts) {
      expect(attempt.constraints.audio).toBe(false);
      expect(videoOf(attempt).facingMode).toBe('user');
      expect(attempt.frameRate).toBe(30);
      expect(videoOf(attempt).frameRate).toEqual({ ideal: 30 });
    }
  });
});

describe('probeDualCamera', () => {
  it('returns both streams when both tracks stay live, opening rear (environment) before front (user)', async () => {
    const rear = makeFakeStream();
    const front = makeFakeStream();
    const calls: MediaStreamConstraints[] = [];
    const getUserMedia = async (c: MediaStreamConstraints) => {
      calls.push(c);
      return calls.length === 1 ? rear.stream : front.stream;
    };
    const result = await probeDualCamera({ getUserMedia }, rearAttempts(), frontAttempts());
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.rearStream).toBe(rear.stream);
      expect(result.frontStream).toBe(front.stream);
    }
    expect(calls).toHaveLength(2);
    expect((calls[0].video as MediaTrackConstraints).facingMode).toBe('environment');
    expect((calls[1].video as MediaTrackConstraints).facingMode).toBe('user');
    expect(rear.track.stopped).toBe(false);
    expect(front.track.stopped).toBe(false);
  });

  it('front failure stops the rear stream and reports front-failed', async () => {
    const rear = makeFakeStream();
    let call = 0;
    const getUserMedia = async () => {
      call += 1;
      if (call === 1) return rear.stream;
      throw { name: 'NotReadableError' };
    };
    const result = await probeDualCamera({ getUserMedia }, rearAttempts(), frontAttempts());
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe('front-failed');
    expect(rear.track.stopped).toBe(true);
  });

  it('a rear track ended by the front opening reports rear-ended and stops both', async () => {
    const rear = makeFakeStream({ readyState: 'ended' });
    const front = makeFakeStream();
    let call = 0;
    const getUserMedia = async () => {
      call += 1;
      return call === 1 ? rear.stream : front.stream;
    };
    const result = await probeDualCamera({ getUserMedia }, rearAttempts(), frontAttempts());
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe('rear-ended');
    expect(rear.track.stopped).toBe(true);
    expect(front.track.stopped).toBe(true);
  });

  it('a rear track muted by the front opening also reports rear-ended', async () => {
    const rear = makeFakeStream({ muted: true });
    const front = makeFakeStream();
    let call = 0;
    const getUserMedia = async () => {
      call += 1;
      return call === 1 ? rear.stream : front.stream;
    };
    const result = await probeDualCamera({ getUserMedia }, rearAttempts(), frontAttempts());
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe('rear-ended');
    expect(rear.track.stopped).toBe(true);
    expect(front.track.stopped).toBe(true);
  });

  it('a non-retryable rear error fails immediately with exactly one call', async () => {
    let calls = 0;
    const getUserMedia = async () => {
      calls += 1;
      throw { name: 'NotAllowedError' };
    };
    const result = await probeDualCamera({ getUserMedia }, rearAttempts(), frontAttempts());
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe('rear-failed');
    expect(calls).toBe(1);
  });

  it('reports unsupported when there is no getUserMedia', async () => {
    const result = await probeDualCamera({ getUserMedia: null }, rearAttempts(), frontAttempts());
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe('unsupported');
  });
});

describe('dual start alignment', () => {
  it('dualStartDeltaMs is front start minus rear start', () => {
    expect(dualStartDeltaMs(1000, 1120)).toBe(120);
  });

  it('trims the earlier-started (rear) file when the front started second', () => {
    expect(dualAlignmentTrims(120)).toEqual({ rearTrimStartSeconds: 0.12, frontTrimStartSeconds: 0 });
  });

  it('trims the earlier-started (front) file when the rear started second', () => {
    expect(dualAlignmentTrims(-80)).toEqual({ rearTrimStartSeconds: 0, frontTrimStartSeconds: 0.08 });
  });

  it('trims nothing when the recorders started together', () => {
    expect(dualAlignmentTrims(0)).toEqual({ rearTrimStartSeconds: 0, frontTrimStartSeconds: 0 });
  });
});

describe('recorder config for the dual front stream (documentation)', () => {
  it('the front stream at its 1080 cap records at the 10 Mbps HD tier', () => {
    expect(recorderOptionsForTrackSettings({ width: 1920, height: 1080 }).videoBitsPerSecond).toBe(10_000_000);
  });
});
