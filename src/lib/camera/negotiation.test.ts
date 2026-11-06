import { describe, it, expect } from 'vitest';
import {
  buildCaptureAttempts,
  buildCensusAwareAttempts,
  buildExactAttempt,
  grantedFps,
  grantedShortSide,
  isExactGrantWorse,
  isGrantBelowAsk,
  negotiateStreamAttempt,
  negotiationDecision,
  type CaptureAttempt,
} from './captureQuality';

const ASK_4K60: CaptureAttempt = buildCaptureAttempts({
  canvasWidth: 1080,
  canvasHeight: 1920,
  facingMode: 'environment',
  quality: '4k',
  frameRate: 60,
})[0];

/** A fake MediaStream whose video track reports `settings`; stop calls are counted. */
function fakeStream(settings: { width: number; height: number; frameRate: number }) {
  let stops = 0;
  const track = {
    getSettings: () => ({ ...settings }),
    stop: () => {
      stops += 1;
    },
  };
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, stopCount: () => stops };
}

describe('granted read-back helpers', () => {
  it('reads the short side and the ROUNDED fps (59.94 is a 60 grant)', () => {
    expect(grantedShortSide({ width: 1080, height: 1920 })).toBe(1080);
    expect(grantedShortSide({ width: 3840, height: 2160 })).toBe(2160);
    expect(grantedShortSide(null)).toBe(0);
    expect(grantedShortSide({ width: 0, height: 1080 })).toBe(0);
    expect(grantedFps({ frameRate: 59.94 })).toBe(60);
    expect(grantedFps({ frameRate: 29.97 })).toBe(30);
    expect(grantedFps({})).toBe(0);
  });
});

describe('negotiationDecision — the three grant cases', () => {
  it('grant meets the ask → no retry', () => {
    const d = negotiationDecision({ shortSide: 2160, frameRate: 60 }, { width: 2160, height: 3840, frameRate: 60 });
    expect(d.needsExactRetry).toBe(false);
    expect(d.belowOn).toEqual([]);
    // A grant ABOVE the ask also needs no retry.
    expect(negotiationDecision({ shortSide: 1080, frameRate: 30 }, { width: 2160, height: 3840, frameRate: 60 }).needsExactRetry).toBe(false);
    // 59.94 against a 60 ask is a match, not a shortfall.
    expect(negotiationDecision({ shortSide: 2160, frameRate: 60 }, { width: 2160, height: 3840, frameRate: 59.94 }).needsExactRetry).toBe(false);
  });

  it('grant below on resolution → exactly the resolution arm', () => {
    const d = negotiationDecision({ shortSide: 2160, frameRate: 60 }, { width: 1080, height: 1920, frameRate: 60 });
    expect(d.needsExactRetry).toBe(true);
    expect(d.belowOn).toEqual(['resolution']);
    expect(d.grantedShortSide).toBe(1080);
  });

  it('grant below on frame rate (or both) → retry', () => {
    expect(negotiationDecision({ shortSide: 2160, frameRate: 60 }, { width: 2160, height: 3840, frameRate: 30 }).belowOn).toEqual(['frameRate']);
    expect(
      negotiationDecision({ shortSide: 2160, frameRate: 60 }, { width: 1080, height: 1920, frameRate: 30 }).belowOn,
    ).toEqual(['resolution', 'frameRate']);
    expect(isGrantBelowAsk({ shortSide: 2160, frameRate: 60 }, { width: 1080, height: 1920, frameRate: 60 })).toBe(true);
    expect(isGrantBelowAsk({ shortSide: 2160, frameRate: 60 }, { width: 2160, height: 3840, frameRate: 60 })).toBe(false);
  });

  it('an unreadable grant never triggers a retry (no disturbing a working stream on a guess)', () => {
    expect(negotiationDecision({ shortSide: 2160, frameRate: 60 }, null).needsExactRetry).toBe(false);
    expect(negotiationDecision({ shortSide: 2160, frameRate: 60 }, {}).needsExactRetry).toBe(false);
  });
});

describe('buildExactAttempt', () => {
  it('turns the rung ideal ask into exact width/height/frameRate, carrying facing + audio + aspect', () => {
    const exact = buildExactAttempt(ASK_4K60);
    const video = exact.constraints.video as MediaTrackConstraints;
    expect(video.width).toEqual({ exact: 2160 });
    expect(video.height).toEqual({ exact: 3840 });
    expect(video.frameRate).toEqual({ exact: 60 });
    expect(video.facingMode).toBe('environment');
    expect(video.aspectRatio).toEqual({ ideal: 9 / 16 });
    expect(exact.constraints.audio).toBe(true);
    expect(exact.shortSide).toBe(2160);
    expect(exact.frameRate).toBe(60);
    // Stage 1 is untouched: still ideal.
    const stage1Video = ASK_4K60.constraints.video as MediaTrackConstraints;
    expect(stage1Video.width).toEqual({ ideal: 2160 });
  });
});

describe('isExactGrantWorse', () => {
  it('compares resolution first, then frame rate; unreadable exact counts as worse', () => {
    const stage1 = { width: 1080, height: 1920, frameRate: 60 };
    expect(isExactGrantWorse(stage1, { width: 2160, height: 3840, frameRate: 30 })).toBe(false);
    expect(isExactGrantWorse(stage1, { width: 720, height: 1280, frameRate: 60 })).toBe(true);
    expect(isExactGrantWorse(stage1, { width: 1080, height: 1920, frameRate: 30 })).toBe(true);
    expect(isExactGrantWorse(stage1, { width: 1080, height: 1920, frameRate: 60 })).toBe(false);
    expect(isExactGrantWorse(stage1, null)).toBe(true);
    expect(isExactGrantWorse(stage1, {})).toBe(true);
  });
});

describe('negotiateStreamAttempt — orchestration with injected platform calls', () => {
  it('grant ≥ ask → no retry: ONE getUserMedia call, stage-1 stream returned untouched', async () => {
    const granted = fakeStream({ width: 2160, height: 3840, frameRate: 60 });
    let calls = 0;
    const result = await negotiateStreamAttempt({
      attempt: ASK_4K60,
      getUserMedia: async () => {
        calls += 1;
        return granted.stream;
      },
    });
    expect(calls).toBe(1);
    expect(result.stream).toBe(granted.stream);
    expect(result.exactRetried).toBe(false);
    expect(result.usedExact).toBe(false);
    expect(granted.stopCount()).toBe(0);
  });

  it('grant < ask → exactly ONE exact retry; a better exact grant wins and stage 1 is stopped', async () => {
    const stage1 = fakeStream({ width: 1080, height: 1920, frameRate: 60 });
    const exact = fakeStream({ width: 2160, height: 3840, frameRate: 60 });
    const seen: MediaStreamConstraints[] = [];
    const result = await negotiateStreamAttempt({
      attempt: ASK_4K60,
      getUserMedia: async (c) => {
        seen.push(c);
        return seen.length === 1 ? stage1.stream : exact.stream;
      },
    });
    expect(seen).toHaveLength(2);
    // The second call is the exact form of the SAME rung.
    const exactVideo = seen[1].video as MediaTrackConstraints;
    expect(exactVideo.width).toEqual({ exact: 2160 });
    expect(exactVideo.frameRate).toEqual({ exact: 60 });
    expect(result.stream).toBe(exact.stream);
    expect(result.usedExact).toBe(true);
    expect(result.exactRetried).toBe(true);
    expect(result.grantedSettings).toEqual({ width: 2160, height: 3840, frameRate: 60 });
    expect(stage1.stopCount()).toBe(1);
    expect(exact.stopCount()).toBe(0);
  });

  it('grant < ask and the exact attempt THROWS → the stage-1 stream is kept, never lost', async () => {
    const stage1 = fakeStream({ width: 1080, height: 1920, frameRate: 30 });
    let calls = 0;
    const result = await negotiateStreamAttempt({
      attempt: ASK_4K60,
      getUserMedia: async () => {
        calls += 1;
        if (calls === 2) {
          const err = new Error('nope');
          err.name = 'OverconstrainedError';
          throw err;
        }
        return stage1.stream;
      },
    });
    expect(calls).toBe(2);
    expect(result.stream).toBe(stage1.stream);
    expect(result.usedExact).toBe(false);
    expect(result.exactRetried).toBe(true);
    expect(result.exactErrorName).toBe('OverconstrainedError');
    expect(stage1.stopCount()).toBe(0);
  });

  it('grant < ask and the exact grant is WORSE → the exact stream is discarded, stage 1 kept', async () => {
    const stage1 = fakeStream({ width: 1080, height: 1920, frameRate: 60 });
    const exact = fakeStream({ width: 720, height: 1280, frameRate: 60 });
    let calls = 0;
    const result = await negotiateStreamAttempt({
      attempt: ASK_4K60,
      getUserMedia: async () => {
        calls += 1;
        return calls === 1 ? stage1.stream : exact.stream;
      },
    });
    expect(result.stream).toBe(stage1.stream);
    expect(result.usedExact).toBe(false);
    expect(exact.stopCount()).toBe(1);
    expect(stage1.stopCount()).toBe(0);
  });

  it('a better-but-still-below exact grant is kept (1080 exact beats a 720 stage-1 grant against a 4K ask)', async () => {
    const stage1 = fakeStream({ width: 720, height: 1280, frameRate: 60 });
    const exact = fakeStream({ width: 1080, height: 1920, frameRate: 60 });
    let calls = 0;
    const result = await negotiateStreamAttempt({
      attempt: ASK_4K60,
      getUserMedia: async () => {
        calls += 1;
        return calls === 1 ? stage1.stream : exact.stream;
      },
    });
    expect(result.stream).toBe(exact.stream);
    expect(result.usedExact).toBe(true);
  });

  it('a stage-1 throw propagates untouched (the caller ladder keeps its semantics) and no retry runs', async () => {
    let calls = 0;
    await expect(
      negotiateStreamAttempt({
        attempt: ASK_4K60,
        getUserMedia: async () => {
          calls += 1;
          const err = new Error('denied');
          err.name = 'NotAllowedError';
          throw err;
        },
      }),
    ).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(calls).toBe(1);
  });
});

describe('buildCensusAwareAttempts — census shapes the first rung only', () => {
  const baseOpts = { canvasWidth: 1080, canvasHeight: 1920, facingMode: 'environment' as const, quality: '4k' as const, frameRate: 60 as const };

  it('no census → the generic ladder, unchanged', () => {
    expect(buildCensusAwareAttempts(baseOpts, null)).toEqual(buildCaptureAttempts(baseOpts));
    expect(buildCensusAwareAttempts(baseOpts, undefined)).toEqual(buildCaptureAttempts(baseOpts));
  });

  it('a full 4K60 census leaves the ladder unchanged (the target already fits)', () => {
    const attempts = buildCensusAwareAttempts(baseOpts, { widthMax: 3840, heightMax: 2160, frameRateMax: 60 });
    expect(attempts.map((a) => [a.shortSide, a.frameRate])).toEqual([
      [2160, 60],
      [1440, 60],
      [1080, 60],
      [1080, 30],
    ]);
  });

  it('a measured 1080p30 ceiling shapes the first rung; lower rungs follow; nothing asks above the census', () => {
    const attempts = buildCensusAwareAttempts(baseOpts, { widthMax: 1920, heightMax: 1080, frameRateMax: 30 });
    expect(attempts[0].shortSide).toBe(1080);
    expect(attempts[0].frameRate).toBe(30);
    for (const a of attempts) {
      expect(a.shortSide).toBeLessThanOrEqual(1080);
      expect(a.frameRate).toBeLessThanOrEqual(30);
    }
    expect(attempts[attempts.length - 1].isFallback).toBe(true);
    expect(attempts.slice(0, -1).every((a) => !a.isFallback)).toBe(true);
  });

  it('never raises the chosen frame rate and never exceeds 2160', () => {
    const attempts = buildCensusAwareAttempts({ ...baseOpts, frameRate: 30 }, { widthMax: 7680, heightMax: 4320, frameRateMax: 120 });
    expect(attempts[0].shortSide).toBe(2160);
    expect(attempts[0].frameRate).toBe(30);
  });

  it('the user-pinned HD choice is never reshaped by a census', () => {
    const hdOpts = { ...baseOpts, quality: 'hd' as const };
    expect(buildCensusAwareAttempts(hdOpts, { widthMax: 1920, heightMax: 1080, frameRateMax: 30 })).toEqual(
      buildCaptureAttempts(hdOpts),
    );
  });
});
