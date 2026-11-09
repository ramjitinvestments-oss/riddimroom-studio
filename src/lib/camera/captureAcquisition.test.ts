/**
 * R41 Step 3 (flip fix) — flip-proof stream acquisition.
 *
 * Behavioural tests for the walk in captureQuality.ts that replaced
 * CameraCapture's inline ladder loop after the owner's S25 Ultra
 * reported "Camera won't flip to rear camera": contention errors
 * (NotReadableError / AbortError) must fall through rungs instead of
 * aborting the ladder, a failed negotiated ladder must run bare, and
 * a plain facingMode-only ask must be the last resort before giving
 * up. All platform calls are fakes — no DOM, no real camera.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  acquireCameraStream,
  buildCaptureAttempts,
  buildPlainFacingAttempt,
  flipFailureNoticeText,
  isStreamFallthroughError,
  negotiateStreamAttempt,
  type CaptureAttempt,
  type CaptureFacingMode,
  type NegotiatedStream,
} from './captureQuality';

function namedError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

function fakeStream(settings: { width: number; height: number; frameRate: number }): MediaStream {
  return {
    getVideoTracks: () => [{ getSettings: () => settings, stop: () => {} }],
    getTracks: () => [],
  } as unknown as MediaStream;
}

function negotiatedWith(stream: MediaStream, over: Partial<NegotiatedStream> = {}): NegotiatedStream {
  return {
    stream,
    grantedSettings: { width: 1920, height: 1080, frameRate: 30 },
    stage1Settings: { width: 1920, height: 1080, frameRate: 30 },
    exactRetried: false,
    usedExact: false,
    ...over,
  };
}

const ladder = (facingMode: CaptureFacingMode = 'environment'): CaptureAttempt[] =>
  buildCaptureAttempts({ canvasWidth: 1080, canvasHeight: 1920, facingMode, quality: 'auto', frameRate: 60 });

describe('isStreamFallthroughError', () => {
  it('falls through on the constraint pair the ladder always allowed', () => {
    expect(isStreamFallthroughError(namedError('OverconstrainedError'))).toBe(true);
    expect(isStreamFallthroughError(namedError('NotFoundError'))).toBe(true);
  });

  it('falls through on the contention pair (busy / still-releasing camera, raced abort)', () => {
    expect(isStreamFallthroughError(namedError('NotReadableError'))).toBe(true);
    expect(isStreamFallthroughError(namedError('AbortError'))).toBe(true);
  });

  it('does NOT fall through on permission or unknown errors', () => {
    expect(isStreamFallthroughError(namedError('NotAllowedError'))).toBe(false);
    expect(isStreamFallthroughError(namedError('SecurityError'))).toBe(false);
    expect(isStreamFallthroughError(new Error('boom'))).toBe(false);
    expect(isStreamFallthroughError(null)).toBe(false);
    expect(isStreamFallthroughError(undefined)).toBe(false);
  });
});

describe('buildPlainFacingAttempt', () => {
  it('asks for the facing ONLY — no size, frame rate or aspect for the browser to fight', () => {
    const plain = buildPlainFacingAttempt('environment');
    expect(plain.constraints).toEqual({ video: { facingMode: 'environment' }, audio: true });
    expect(plain.shortSide).toBe(0);
    expect(plain.frameRate).toBe(0);
    expect(plain.isFallback).toBe(true);
  });

  it('carries the requested facing verbatim', () => {
    expect(buildPlainFacingAttempt('user').constraints).toEqual({ video: { facingMode: 'user' }, audio: true });
  });
});

describe('flipFailureNoticeText', () => {
  it('names the camera that failed and the one still showing, both directions', () => {
    expect(flipFailureNoticeText('environment', 'user')).toBe(
      "Couldn't switch to the back camera — you're still on the front camera.",
    );
    expect(flipFailureNoticeText('user', 'environment')).toBe(
      "Couldn't switch to the front camera — you're still on the back camera.",
    );
  });
});

describe('acquireCameraStream — pass 1 (negotiated ladder)', () => {
  it('returns the first rung’s negotiated stream and never touches the bare walk', async () => {
    const stream = fakeStream({ width: 3000, height: 2160, frameRate: 30 });
    const negotiate = vi.fn(async () => negotiatedWith(stream));
    const getUserMedia = vi.fn(async () => fakeStream({ width: 1, height: 1, frameRate: 1 }));
    const result = await acquireCameraStream({ attempts: ladder(), facingMode: 'environment', getUserMedia, negotiate });
    expect(result.pass).toBe(1);
    expect(result.stream).toBe(stream);
    expect(result.negotiated).not.toBeNull();
    expect(negotiate).toHaveBeenCalledTimes(1);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('falls through to the next rung on NotReadableError (the flip killer) instead of aborting', async () => {
    const stream = fakeStream({ width: 1920, height: 1080, frameRate: 30 });
    const negotiate = vi.fn(async (attempt: CaptureAttempt) => {
      if (attempt.shortSide === 2160) throw namedError('NotReadableError');
      return negotiatedWith(stream);
    });
    const result = await acquireCameraStream({
      attempts: ladder(),
      facingMode: 'environment',
      getUserMedia: vi.fn(async () => stream),
      negotiate,
    });
    expect(result.pass).toBe(1);
    expect(result.attempt.shortSide).toBe(1440);
    expect(negotiate).toHaveBeenCalledTimes(2);
  });

  it('aborts immediately on a fatal error — no further rungs, no plainer passes', async () => {
    const denied = namedError('NotAllowedError');
    const negotiate = vi.fn(async () => {
      throw denied;
    });
    const getUserMedia = vi.fn(async () => fakeStream({ width: 1, height: 1, frameRate: 1 }));
    await expect(
      acquireCameraStream({ attempts: ladder(), facingMode: 'environment', getUserMedia, negotiate }),
    ).rejects.toBe(denied);
    expect(negotiate).toHaveBeenCalledTimes(1);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('with the REAL negotiation: a stage-1 NotReadableError falls to the next rung, whose stream wins', async () => {
    // Settings meet the 1440@60 rung's ask exactly, so no exact retry muddies the assertion.
    const winner = fakeStream({ width: 1440, height: 2560, frameRate: 60 });
    const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
      const video = c.video as MediaTrackConstraints;
      const width = (video.width as { ideal?: number })?.ideal ?? 0;
      if (width >= 2000) throw namedError('NotReadableError'); // the 2160 rung's ask (2160 wide at 9:16)
      return winner;
    });
    const result = await acquireCameraStream({ attempts: ladder(), facingMode: 'environment', getUserMedia });
    expect(result.pass).toBe(1);
    expect(result.stream).toBe(winner);
    expect(result.negotiated?.usedExact).toBe(false);
  });

  it('with the REAL negotiation: a failed exact retry inside a rung is NOT a rung failure — stage 1 is kept', async () => {
    const stage1 = fakeStream({ width: 3000, height: 2160, frameRate: 30 });
    let calls = 0;
    const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
      calls += 1;
      const video = c.video as MediaTrackConstraints;
      const isExact = typeof (video.frameRate as { exact?: number })?.exact === 'number';
      if (isExact) throw namedError('NotReadableError'); // the second concurrent open contends — swallowed by negotiation
      return stage1;
    });
    const result = await acquireCameraStream({ attempts: ladder(), facingMode: 'environment', getUserMedia });
    expect(result.pass).toBe(1);
    expect(result.stream).toBe(stage1);
    expect(result.negotiated?.exactRetried).toBe(true);
    expect(result.negotiated?.usedExact).toBe(false);
    expect(calls).toBe(2); // stage 1 + the one exact attempt, no further rungs walked
  });
});

describe('acquireCameraStream — pass 2 (bare ladder, exact retry dropped)', () => {
  it('runs when every negotiated rung falls through, and reads the grant back from the track', async () => {
    const stream = fakeStream({ width: 1920, height: 1080, frameRate: 30 });
    const negotiate = vi.fn(async () => {
      throw namedError('AbortError');
    });
    const getUserMedia = vi.fn(async () => stream);
    const result = await acquireCameraStream({ attempts: ladder(), facingMode: 'environment', getUserMedia, negotiate });
    expect(result.pass).toBe(2);
    expect(result.stream).toBe(stream);
    expect(result.negotiated).toBeNull();
    expect(result.grantedSettings).toEqual({ width: 1920, height: 1080, frameRate: 30 });
    expect(negotiate).toHaveBeenCalledTimes(ladder().length);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    // The bare walk hands getUserMedia the rung's own ideal constraints.
    expect(getUserMedia).toHaveBeenCalledWith(ladder()[0].constraints);
  });

  it('falls through bare rungs on contention errors too', async () => {
    const stream = fakeStream({ width: 1280, height: 720, frameRate: 30 });
    const negotiate = vi.fn(async () => {
      throw namedError('NotReadableError');
    });
    let bareCalls = 0;
    const getUserMedia = vi.fn(async () => {
      bareCalls += 1;
      if (bareCalls < 3) throw namedError('NotReadableError');
      return stream;
    });
    const result = await acquireCameraStream({ attempts: ladder(), facingMode: 'environment', getUserMedia, negotiate });
    expect(result.pass).toBe(2);
    expect(result.attempt.shortSide).toBe(1080);
    expect(bareCalls).toBe(3);
  });
});

describe('acquireCameraStream — pass 3 (plain facing-only ask)', () => {
  it('is the last resort: exactly { facingMode } + audio, nothing else to refuse', async () => {
    const stream = fakeStream({ width: 1280, height: 720, frameRate: 30 });
    const negotiate = vi.fn(async () => {
      throw namedError('OverconstrainedError');
    });
    const seen: MediaStreamConstraints[] = [];
    const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
      seen.push(c);
      const video = c.video as MediaTrackConstraints;
      if (typeof video.facingMode === 'string' && video.width === undefined) return stream; // the plain ask
      throw namedError('NotReadableError');
    });
    const result = await acquireCameraStream({ attempts: ladder(), facingMode: 'environment', getUserMedia, negotiate });
    expect(result.pass).toBe(3);
    expect(result.stream).toBe(stream);
    expect(result.attempt.shortSide).toBe(0);
    expect(seen[seen.length - 1]).toEqual({ video: { facingMode: 'environment' }, audio: true });
  });

  it('rejects with the PLAIN ask’s error when every pass failed', async () => {
    const plainError = namedError('NotReadableError');
    const negotiate = vi.fn(async () => {
      throw namedError('AbortError');
    });
    const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
      const video = c.video as MediaTrackConstraints;
      if (video.width === undefined) throw plainError;
      throw namedError('OverconstrainedError');
    });
    await expect(
      acquireCameraStream({ attempts: ladder(), facingMode: 'environment', getUserMedia, negotiate }),
    ).rejects.toBe(plainError);
  });

  it('goes straight to the plain ask when the ladder is empty', async () => {
    const stream = fakeStream({ width: 640, height: 480, frameRate: 30 });
    const getUserMedia = vi.fn(async () => stream);
    const result = await acquireCameraStream({ attempts: [], facingMode: 'user', getUserMedia });
    expect(result.pass).toBe(3);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: 'user' }, audio: true });
  });
});

describe('negotiateStreamAttempt seam (unchanged behaviour the walk relies on)', () => {
  it('is the default negotiator when none is injected', async () => {
    const stream = fakeStream({ width: 3840, height: 2160, frameRate: 60 });
    const getUserMedia = vi.fn(async () => stream);
    const result = await acquireCameraStream({ attempts: ladder(), facingMode: 'environment', getUserMedia });
    expect(result.pass).toBe(1);
    expect(result.negotiated).not.toBeNull();
  });
});
