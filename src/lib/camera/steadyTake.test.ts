/**
 * R41 Step 3 Rung B — CFR normalisation tests.
 *
 * Two layers, matching the module:
 *   1. The PURE planner + sample retimer over synthetic timestamp
 *      series with known jitter — the same decision logic the
 *      offline proof runs over the owner's real clips' PTS series.
 *      Output timing is asserted exactly: every emitted timestamp
 *      sits on the target grid, so the output series measures 100%
 *      within tolerance by construction, and the properties that
 *      matter (duration preserved, holds fill misses, bursts thin,
 *      head stall held — never trimmed) are pinned individually.
 *   2. The container pipeline (`steadyCameraTake`) over an injected
 *      fake mediabunny: the never-lose-a-take contract (original
 *      returned on unsupported / unreadable / invalid / failure),
 *      the already-even honest skip, audio-track preservation, and
 *      the OPFS-first / buffer-second attempt cascade.
 */
import { describe, it, expect } from 'vitest';
import {
  STEADY_EVEN_THRESHOLD_PERCENT,
  assessFrameTiming,
  createCfrSampleRetimer,
  planCfrRetiming,
  planNeedsSteadying,
  steadyCameraTake,
  type CfrRetimableSample,
  type SteadyTakeDeps,
} from './steadyTake';

const FPS = 30;
const STEP = 1 / FPS;

/** An exactly-even series of `count` frames at `fps`, starting at `startSec`. */
function evenSeries(count: number, fps = FPS, startSec = 0): number[] {
  return Array.from({ length: count }, (_, i) => startSec + i / fps);
}

/**
 * The owner's measured defect shape, scaled down: a ~0.2s head stall
 * (one long first interval), discrete whole-frame misses mid-take,
 * and one catch-up burst (two frames inside one grid slot).
 */
function defectSeries(): number[] {
  const ts: number[] = [0];
  let t = 0;
  t += 0.2; // head stall — the first frame is held ~6 slots
  ts.push(t);
  for (let i = 0; i < 20; i += 1) {
    t += STEP;
    ts.push(t);
  }
  t += STEP * 3; // a whole-frame miss: one interval three slots wide
  ts.push(t);
  for (let i = 0; i < 20; i += 1) {
    t += STEP;
    ts.push(t);
  }
  t += STEP * 0.3; // catch-up burst: two frames inside one slot
  ts.push(t);
  t += STEP * 0.7;
  ts.push(t);
  for (let i = 0; i < 20; i += 1) {
    t += STEP;
    ts.push(t);
  }
  return ts;
}

describe('assessFrameTiming — the receipt-family timing measure', () => {
  it('an exactly-even 30fps series measures 100%', () => {
    const a = assessFrameTiming(evenSeries(90), FPS);
    expect(a.frameCount).toBe(90);
    expect(a.withinTolerancePercent).toBe(100);
    expect(a.longestGapMs).toBeCloseTo(STEP * 1000, 3);
  });

  it('the defect series measures BELOW the steady threshold (it NEEDS steadying)', () => {
    const ts = defectSeries();
    const a = assessFrameTiming(ts, FPS);
    expect(a.withinTolerancePercent).toBeLessThan(STEADY_EVEN_THRESHOLD_PERCENT);
    expect(a.longestGapMs).toBeGreaterThan(190);
    expect(planNeedsSteadying(planCfrRetiming(ts, FPS))).toBe(true);
  });

  it('junk input measures as empty, never as even', () => {
    expect(assessFrameTiming([], FPS).frameCount).toBe(0);
    expect(assessFrameTiming([Number.NaN, 1], FPS).frameCount).toBe(1);
    const noRate = assessFrameTiming(evenSeries(10), 0);
    expect(noRate.withinTolerancePercent).toBe(0); // an unusable rate never reads as even
  });
});

describe('planCfrRetiming — the pure re-timing decision', () => {
  it('an even series plans as itself: identity slots, no holds, no thins', () => {
    const ts = evenSeries(90);
    const plan = planCfrRetiming(ts, FPS);
    expect(plan).not.toBeNull();
    expect(plan!.frameCount).toBe(90);
    expect(plan!.duplicatedSlots).toBe(0);
    expect(plan!.thinnedSourceFrames).toBe(0);
    expect(plan!.sourceIndexForSlot.every((src, slot) => src === slot)).toBe(true);
    expect(planNeedsSteadying(plan)).toBe(false);
  });

  it('the head stall is HELD, never trimmed: the first source frame fills the stalled slots', () => {
    const plan = planCfrRetiming(defectSeries(), FPS)!;
    // Slots 0..5 sit before the second frame lands at 0.2s — all show source 0.
    for (let slot = 0; slot <= 5; slot += 1) expect(plan.sourceIndexForSlot[slot]).toBe(0);
    expect(plan.holdsPerSource[0]).toBe(6);
    expect(plan.startSec).toBe(0);
  });

  it('a whole-frame miss holds the prior frame; the burst loses exactly one frame', () => {
    const ts = defectSeries();
    const plan = planCfrRetiming(ts, FPS)!;
    expect(plan.duplicatedSlots).toBeGreaterThanOrEqual(5 + 2); // head stall (5 extra) + the miss (2 extra)
    expect(plan.thinnedSourceFrames).toBe(1);
    const thinned = ts.findIndex((_, i) => plan.firstSlotForSource[i] === -1);
    expect(thinned).toBeGreaterThan(0);
  });

  it('duration is preserved: the plan spans the source span plus one trailing frame, within a slot', () => {
    const ts = defectSeries();
    const plan = planCfrRetiming(ts, FPS)!;
    const sourceSpan = ts[ts.length - 1] - ts[0];
    expect(Math.abs(plan.durationSec - (sourceSpan + STEP))).toBeLessThanOrEqual(STEP + 1e-9);
    expect(plan.frameCount).toBe(Math.round(plan.durationSec * FPS));
  });

  it('every output slot time is exactly on the grid (the CFR guarantee)', () => {
    const plan = planCfrRetiming(defectSeries(), FPS)!;
    const outputSeries = Array.from({ length: plan.frameCount }, (_, k) => plan.startSec + k / FPS);
    const measured = assessFrameTiming(outputSeries, FPS);
    expect(measured.withinTolerancePercent).toBe(100);
    expect(measured.longestGapMs).toBeCloseTo(STEP * 1000, 6);
  });

  it('a late-starting series keeps its start (grid anchored at the first frame, not at zero)', () => {
    const plan = planCfrRetiming(evenSeries(30, FPS, 2.5), FPS)!;
    expect(plan.startSec).toBeCloseTo(2.5, 9);
    expect(plan.sourceIndexForSlot[0]).toBe(0);
  });
});

class FakeSample implements CfrRetimableSample {
  timestamp: number;
  duration: number;
  constructor(timestamp: number, duration = STEP) {
    this.timestamp = timestamp;
    this.duration = duration;
  }
  setTimestamp(t: number) {
    this.timestamp = t;
  }
  setDuration(d: number) {
    this.duration = d;
  }
  clone(): FakeSample {
    return new FakeSample(this.timestamp, this.duration);
  }
}

describe('createCfrSampleRetimer — the sample mapper the conversion runs', () => {
  it('emits every frame of an even series exactly once, stamped on the grid', () => {
    const ts = evenSeries(10);
    const plan = planCfrRetiming(ts, FPS)!;
    const retimer = createCfrSampleRetimer(plan);
    const out: FakeSample[] = [];
    ts.forEach((t, i) => {
      const mapped = retimer(new FakeSample(t));
      if (mapped) out.push(...(mapped as FakeSample[]));
    });
    expect(out).toHaveLength(10);
    out.forEach((s, k) => {
      expect(s.timestamp).toBeCloseTo(k * STEP, 9);
      expect(s.duration).toBeCloseTo(STEP, 9);
    });
  });

  it('holds via CLONES (the source sample is never reused) and thins via null', () => {
    const ts = defectSeries();
    const plan = planCfrRetiming(ts, FPS)!;
    const retimer = createCfrSampleRetimer(plan);
    const emitted: FakeSample[] = [];
    let nulls = 0;
    ts.forEach((t, i) => {
      const mapped = retimer(new FakeSample(t));
      if (mapped === null) {
        nulls += 1;
        return;
      }
      emitted.push(...(mapped as FakeSample[]));
    });
    expect(nulls).toBe(plan.thinnedSourceFrames);
    expect(emitted).toHaveLength(plan.frameCount);
    // All emitted samples are distinct objects (clones), and their
    // timestamps are exactly the grid — the CFR output timing.
    expect(new Set(emitted).size).toBe(emitted.length);
    emitted.forEach((s, k) => expect(s.timestamp).toBeCloseTo(plan.startSec + k / FPS, 9));
    const measured = assessFrameTiming(emitted.map((s) => s.timestamp), FPS);
    expect(measured.withinTolerancePercent).toBe(100);
  });
});

/* ------------------------------------------------------------------ */
/* The pipeline, over an injected fake mediabunny                      */
/* ------------------------------------------------------------------ */

const FAKE_OUT = new Uint8Array([0, 1, 2, 3]);

interface FakeWorld {
  mb: unknown;
  videoTrack: { codec: string };
  audioTrack: { codec: string } | null;
  conversionOptions: Record<string, unknown> | null;
  conversions: number;
  /** How many execute() calls should throw before one succeeds. */
  throwsRemaining: number;
  /** Timestamps of the samples the fake execute() fed through the retimer. */
  fedTimestamps: number[];
  /** Samples the retimer emitted during the fake execute(). */
  emitted: FakeSample[];
}

function fakeWorld(
  series: number[],
  opts: {
    audio?: boolean;
    valid?: boolean;
    dropVideo?: boolean;
    dropAudio?: boolean;
    executeThrows?: boolean;
    noVideoTrack?: boolean;
  } = {},
): FakeWorld {
  const world: FakeWorld = {
    mb: null,
    videoTrack: { codec: 'avc' },
    audioTrack: opts.audio === false ? null : { codec: 'aac' },
    conversionOptions: null,
    conversions: 0,
    throwsRemaining: 0,
    fedTimestamps: [],
    emitted: [],
  };
  const videoTrack = world.videoTrack;
  const audioTrack = world.audioTrack;

  class FakeInput {
    async getPrimaryVideoTrack() {
      return opts.noVideoTrack ? null : videoTrack;
    }
    async getPrimaryAudioTrack() {
      return audioTrack;
    }
    async getFormat() {
      return { name: 'MP4' };
    }
  }
  class FakeSink {
    constructor(private track: unknown) {
      void track;
    }
    async *packets() {
      for (const t of series) {
        yield { timestamp: t, data: new Uint8Array(64) };
      }
    }
  }
  class FakeBufferTarget {
    buffer: ArrayBuffer | null = FAKE_OUT.buffer as ArrayBuffer;
  }
  class FakeStreamTarget {
    constructor(public options: unknown) {}
  }
  class FakeOutput {
    constructor(public options: unknown) {}
  }
  class FakeMp4Format {
    constructor(public options: unknown) {}
  }
  class FakeWebMFormat {}
  const Conversion = {
    init: async (options: Record<string, unknown>) => {
      world.conversions += 1;
      world.conversionOptions = options;
      const videoOpts = options.video as { process?: unknown } | undefined;
      const processFn = videoOpts?.process as
        | ((s: FakeSample, i: number) => FakeSample[] | FakeSample | null)
        | undefined;
      return {
        isValid: opts.valid !== false,
        utilizedTracks: opts.dropVideo ? [] : [videoTrack],
        discardedTracks: [
          ...(opts.dropVideo ? [{ track: videoTrack, reason: 'test' }] : []),
          ...(opts.dropAudio && audioTrack ? [{ track: audioTrack, reason: 'test' }] : []),
        ],
        execute: async () => {
          if (opts.executeThrows || world.throwsRemaining > 0) {
            world.throwsRemaining = Math.max(0, world.throwsRemaining - 1);
            throw new Error('encode blew up');
          }
          if (processFn) {
            series.forEach((t, i) => {
              world.fedTimestamps.push(t);
              const mapped = processFn(new FakeSample(t), i);
              if (mapped) world.emitted.push(...([] as FakeSample[]).concat(mapped));
            });
          }
        },
      };
    },
  };
  world.mb = {
    Input: FakeInput,
    BlobSource: class {
      constructor(public blob: unknown) {}
    },
    ALL_FORMATS: [],
    EncodedPacketSink: FakeSink,
    Output: FakeOutput,
    Mp4OutputFormat: FakeMp4Format,
    WebMOutputFormat: FakeWebMFormat,
    BufferTarget: FakeBufferTarget,
    StreamTarget: FakeStreamTarget,
    Conversion,
  };
  return world;
}

type MediabunnyModule = Awaited<ReturnType<NonNullable<SteadyTakeDeps['loadMediabunny']>>>;

function depsFor(world: FakeWorld, overrides: Partial<SteadyTakeDeps> = {}): SteadyTakeDeps {
  return {
    webCodecsPresent: () => true,
    loadMediabunny: async () => world.mb as MediabunnyModule,
    openSink: async () => null,
    ...overrides,
  };
}

const TAKE = () => new Blob([new Uint8Array(1024)], { type: 'video/mp4' });

describe('steadyCameraTake — the never-lose-a-take pipeline', () => {
  it('no WebCodecs: the ORIGINAL take comes back, mediabunny never loads', async () => {
    const blob = TAKE();
    let loads = 0;
    const result = await steadyCameraTake(blob, { targetFps: 30 }, {
      webCodecsPresent: () => false,
      loadMediabunny: async () => {
        loads += 1;
        throw new Error('must not load');
      },
      openSink: async () => null,
    });
    expect(result.status).toBe('original');
    if (result.status === 'original') expect(result.reason).toBe('unsupported');
    expect(result.blob).toBe(blob);
    expect(loads).toBe(0);
  });

  it('a jittered take is steadied: conversion runs the retimer, output timing is exactly on-grid', async () => {
    const series = defectSeries();
    const world = fakeWorld(series);
    const blob = TAKE();
    const result = await steadyCameraTake(blob, { targetFps: 30 }, depsFor(world));
    expect(result.status).toBe('steadied');
    if (result.status !== 'steadied') return;
    expect(result.blob).not.toBe(blob);
    expect(result.blob.type).toBe('video/mp4');
    expect(result.plan.targetFps).toBe(30);
    // The conversion was asked to FORCE the transcode (so every
    // sample passes the retimer) with the input's own codec.
    const videoOpts = world.conversionOptions?.video as { forceTranscode?: boolean; codec?: string } | undefined;
    expect(videoOpts?.forceTranscode).toBe(true);
    expect(videoOpts?.codec).toBe('avc');
    // Every source sample was fed; the emitted series is the plan's
    // full grid — CFR by construction, 100% within tolerance.
    expect(world.fedTimestamps).toHaveLength(series.length);
    expect(world.emitted).toHaveLength(result.plan.frameCount);
    const measured = assessFrameTiming(world.emitted.map((s) => s.timestamp), FPS);
    expect(measured.withinTolerancePercent).toBe(100);
  });

  it('an already-even take skips conversion entirely and reports the honest original outcome', async () => {
    const world = fakeWorld(evenSeries(90));
    const blob = TAKE();
    const result = await steadyCameraTake(blob, { targetFps: 30 }, depsFor(world));
    expect(result.status).toBe('original');
    if (result.status === 'original') expect(result.reason).toBe('already-even');
    expect(result.blob).toBe(blob);
    expect(world.conversions).toBe(0);
  });

  it('no video track: unreadable, original kept', async () => {
    const world = fakeWorld(defectSeries(), { noVideoTrack: true });
    const blob = TAKE();
    const result = await steadyCameraTake(blob, undefined, depsFor(world));
    expect(result.status).toBe('original');
    if (result.status === 'original') expect(result.reason).toBe('unreadable');
    expect(result.blob).toBe(blob);
  });

  it('a conversion that would DISCARD the audio is refused — sound is never traded for steadiness', async () => {
    const world = fakeWorld(defectSeries(), { dropAudio: true });
    const blob = TAKE();
    const result = await steadyCameraTake(blob, { targetFps: 30 }, depsFor(world));
    expect(result.status).toBe('original');
    if (result.status === 'original') expect(result.reason).toBe('failed');
    expect(result.blob).toBe(blob);
  });

  it('an invalid conversion falls through both attempts to the original', async () => {
    const world = fakeWorld(defectSeries(), { valid: false });
    const blob = TAKE();
    const result = await steadyCameraTake(blob, { targetFps: 30 }, depsFor(world));
    expect(result.status).toBe('original');
    if (result.status === 'original') expect(result.reason).toBe('failed');
    expect(result.blob).toBe(blob);
  });

  it('the streaming sink is tried first; when it fails mid-run the buffer attempt still steadies', async () => {
    const series = defectSeries();
    const world = fakeWorld(series);
    world.throwsRemaining = 1; // the first (streaming) conversion dies mid-run
    let cleanups = 0;
    const result = await steadyCameraTake(TAKE(), { targetFps: 30 }, depsFor(world, {
      openSink: async (mb) => ({
        target: new mb.StreamTarget(
          new WritableStream() as unknown as WritableStream<import('mediabunny').StreamTargetChunk>,
        ),
        finish: async () => new Blob([FAKE_OUT], { type: 'video/mp4' }),
        cleanup: async () => {
          cleanups += 1;
        },
      }),
    }));
    expect(result.status).toBe('steadied');
    expect(world.conversions).toBe(2); // streaming attempt, then the buffer attempt
    expect(cleanups).toBe(1); // the failed streaming attempt cleaned up after itself
    expect(world.emitted).toHaveLength((result as { plan: { frameCount: number } }).plan.frameCount);
  });

  it('a webm take stays webm', async () => {
    const world = fakeWorld(defectSeries());
    const blob = new Blob([new Uint8Array(16)], { type: 'video/webm' });
    const result = await steadyCameraTake(blob, { targetFps: 30 }, depsFor(world));
    expect(result.status).toBe('steadied');
    if (result.status === 'steadied') expect(result.blob.type).toBe('video/webm');
  });

  it('an unknown granted rate is derived from the take itself (median interval)', async () => {
    const world = fakeWorld(defectSeries());
    const result = await steadyCameraTake(TAKE(), undefined, depsFor(world));
    expect(result.status).toBe('steadied');
    if (result.status === 'steadied') expect(result.plan.targetFps).toBe(30);
  });
});
