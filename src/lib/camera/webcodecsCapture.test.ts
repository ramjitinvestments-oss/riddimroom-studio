/**
 * FINAL FIX Part 2 — the WebCodecs capture prototype's pure logic,
 * probe decisions, and recorder adapter (against a fake worker).
 * The real encode pipeline runs only in a browser worker; what is
 * pinned here is everything that decides and counts: the CFR grid
 * math, the counted-drop gate, the config ladder, the capability
 * probe's verdicts, the adapter's event contract (data → stop on
 * success, error exactly once on failure — the component's fallback
 * depends on it), and the Rung B interplay: a by-construction-CFR
 * take must assess as already-even so steadying skips it honestly.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  CfrSlotStamper,
  WebcodecsTakeRecorder,
  buildWebcodecsAudioConfig,
  buildWebcodecsVideoConfigCandidates,
  createWebcodecsTakeRecorder,
  emptyCaptureEngineTelemetry,
  frameDurationUs,
  loadCaptureEngineChoice,
  parseCaptureEngineChoice,
  probeWebcodecsCaptureWith,
  saveCaptureEngineChoice,
  serializeCaptureEngineChoice,
  shouldDropFrameForQueue,
  slotForTimestampUs,
  type WebcodecsTakeRecorderDeps,
  type WebcodecsWorkerLike,
} from './webcodecsCapture';
import { planCfrRetiming, planNeedsSteadying } from './steadyTake';

describe('engine choice persistence', () => {
  it('round-trips both choices and defaults anything unknown to standard', () => {
    expect(serializeCaptureEngineChoice('webcodecs')).toBe('webcodecs');
    expect(serializeCaptureEngineChoice('standard')).toBe('standard');
    expect(parseCaptureEngineChoice('webcodecs')).toBe('webcodecs');
    expect(parseCaptureEngineChoice('standard')).toBe('standard');
    expect(parseCaptureEngineChoice('banana')).toBe('standard');
    expect(parseCaptureEngineChoice(null)).toBe('standard');
    expect(parseCaptureEngineChoice(undefined)).toBe('standard');
  });

  it('loads and saves through a storage seam; a throwing storage costs nothing', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(loadCaptureEngineChoice(storage)).toBe('standard');
    saveCaptureEngineChoice(storage, 'webcodecs');
    expect(loadCaptureEngineChoice(storage)).toBe('webcodecs');
    saveCaptureEngineChoice(storage, 'standard');
    expect(loadCaptureEngineChoice(storage)).toBe('standard');
    const broken = {
      getItem: () => {
        throw new Error('nope');
      },
      setItem: () => {
        throw new Error('nope');
      },
    };
    expect(loadCaptureEngineChoice(broken)).toBe('standard');
    expect(() => saveCaptureEngineChoice(broken, 'webcodecs')).not.toThrow();
  });
});

describe('encoder config candidates', () => {
  it('tries hardware, then no-preference, then software — all quality-latency AVC', () => {
    const candidates = buildWebcodecsVideoConfigCandidates({
      width: 3840,
      height: 2160,
      fps: 30,
      bitrate: 45_000_000,
    });
    expect(candidates.map((c) => c.hardwareAcceleration)).toEqual([
      'prefer-hardware',
      'no-preference',
      'prefer-software',
    ]);
    for (const c of candidates) {
      expect(c.codec).toMatch(/^avc1\./);
      expect(c.width).toBe(3840);
      expect(c.height).toBe(2160);
      expect(c.bitrate).toBe(45_000_000);
      expect(c.framerate).toBe(30);
      expect(c.latencyMode).toBe('quality');
      expect(c.avc).toEqual({ format: 'avc' });
    }
  });

  it('derives the codec level from the take shape (4K needs a higher level than 1080p)', () => {
    const uhd = buildWebcodecsVideoConfigCandidates({ width: 3840, height: 2160, fps: 30, bitrate: 45_000_000 })[0];
    const hd = buildWebcodecsVideoConfigCandidates({ width: 1920, height: 1080, fps: 30, bitrate: 16_000_000 })[0];
    expect(uhd.codec).not.toBe(hd.codec);
  });
});

describe('audio config', () => {
  it('defaults to 48kHz stereo AAC at 192kbps and honours a mono mic', () => {
    const def = buildWebcodecsAudioConfig({});
    expect(def.codec).toBe('mp4a.40.2');
    expect(def.sampleRate).toBe(48_000);
    expect(def.numberOfChannels).toBe(2);
    expect(def.bitrate).toBe(192_000);
    const mono = buildWebcodecsAudioConfig({ sampleRate: 44_100, channelCount: 1 });
    expect(mono.sampleRate).toBe(44_100);
    expect(mono.numberOfChannels).toBe(1);
    // An absurd channel count never reaches the encoder.
    expect(buildWebcodecsAudioConfig({ channelCount: 6 }).numberOfChannels).toBe(2);
  });
});

describe('the CFR grid', () => {
  it('computes slot durations and slots on the granted-fps grid', () => {
    expect(frameDurationUs(30)).toBeCloseTo(33_333.33, 1);
    expect(frameDurationUs(0)).toBeCloseTo(33_333.33, 1); // defensive default
    const t0 = 1_000_000;
    expect(slotForTimestampUs(t0, t0, 30)).toBe(0);
    expect(slotForTimestampUs(t0 + 33_000, t0, 30)).toBe(1);
    expect(slotForTimestampUs(t0 + 66_900, t0, 30)).toBe(2);
    expect(slotForTimestampUs(t0 - 5_000, t0, 30)).toBe(0); // never negative
  });

  it('the stamper anchors on the first packet, counts gaps as fills, never rewinds', () => {
    const stamper = new CfrSlotStamper(30);
    expect(stamper.stampFor(500_000)).toEqual({ slot: 0, fillsBefore: 0 });
    expect(stamper.anchorUs).toBe(500_000);
    expect(stamper.stampFor(500_000 + 33_333)).toEqual({ slot: 1, fillsBefore: 0 });
    // A 3-slot jump: slots 2 and 3 stand empty, to be filled.
    expect(stamper.stampFor(500_000 + 4 * 33_333)).toEqual({ slot: 4, fillsBefore: 2 });
    // A late out-of-order packet keeps its own slot and does not rewind the ledger.
    expect(stamper.stampFor(500_000 + 2 * 33_333)).toEqual({ slot: 2, fillsBefore: 0 });
    expect(stamper.stampFor(500_000 + 5 * 33_333)).toEqual({ slot: 5, fillsBefore: 0 });
    const timing = stamper.slotTiming(3);
    expect(timing.timestampSec).toBeCloseTo(0.1, 6);
    expect(timing.durationSec).toBeCloseTo(1 / 30, 6);
  });
});

describe('the counted-drop gate', () => {
  it('drops only when more than two frames already wait in the encoder', () => {
    expect(shouldDropFrameForQueue(0)).toBe(false);
    expect(shouldDropFrameForQueue(2)).toBe(false);
    expect(shouldDropFrameForQueue(3)).toBe(true);
    expect(shouldDropFrameForQueue(40)).toBe(true);
  });
});

describe('the capability probe', () => {
  const dims = { width: 3840, height: 2160, fps: 30, bitrate: 45_000_000 };

  it('refuses without the track processor or the encoder, each with its reason', async () => {
    const noMstp = await probeWebcodecsCaptureWith(
      { hasTrackProcessor: () => false, hasVideoEncoder: () => true, isConfigSupported: async () => ({ supported: true }) },
      dims,
    );
    expect(noMstp).toEqual({ supported: false, reason: 'track-processor', config: null });
    const noEncoder = await probeWebcodecsCaptureWith(
      { hasTrackProcessor: () => true, hasVideoEncoder: () => false, isConfigSupported: async () => ({ supported: true }) },
      dims,
    );
    expect(noEncoder).toEqual({ supported: false, reason: 'encoder', config: null });
  });

  it('walks the candidate ladder and returns the first supported config', async () => {
    const tried: VideoEncoderConfig[] = [];
    const result = await probeWebcodecsCaptureWith(
      {
        hasTrackProcessor: () => true,
        hasVideoEncoder: () => true,
        isConfigSupported: async (config) => {
          tried.push(config);
          return { supported: config.hardwareAcceleration === 'prefer-software' };
        },
      },
      dims,
    );
    expect(tried.map((c) => c.hardwareAcceleration)).toEqual(['prefer-hardware', 'no-preference', 'prefer-software']);
    expect(result.supported).toBe(true);
    expect(result.config?.hardwareAcceleration).toBe('prefer-software');
  });

  it('a throwing probe is a declined config, not a dead end; all declined = unsupported', async () => {
    const recovered = await probeWebcodecsCaptureWith(
      {
        hasTrackProcessor: () => true,
        hasVideoEncoder: () => true,
        isConfigSupported: async (config) => {
          if (config.hardwareAcceleration === 'prefer-hardware') throw new Error('boom');
          return { supported: true };
        },
      },
      dims,
    );
    expect(recovered.supported).toBe(true);
    const none = await probeWebcodecsCaptureWith(
      { hasTrackProcessor: () => true, hasVideoEncoder: () => true, isConfigSupported: async () => ({ supported: false }) },
      dims,
    );
    expect(none).toEqual({ supported: false, reason: 'config', config: null });
  });
});

/* ------------------------------------------------------------------ */
/* The adapter against a fake worker                                   */
/* ------------------------------------------------------------------ */

class FakeWorker implements WebcodecsWorkerLike {
  readonly sent: Array<{ message: unknown; transfer?: Transferable[] }> = [];
  terminated = false;
  private readonly messageListeners = new Set<(event: { data?: unknown }) => void>();
  private readonly errorListeners = new Set<(event: { data?: unknown }) => void>();

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.sent.push({ message, transfer });
  }
  addEventListener(type: 'message' | 'error', listener: (event: { data?: unknown }) => void): void {
    (type === 'message' ? this.messageListeners : this.errorListeners).add(listener);
  }
  removeEventListener(type: 'message' | 'error', listener: (event: { data?: unknown }) => void): void {
    (type === 'message' ? this.messageListeners : this.errorListeners).delete(listener);
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(data: unknown): void {
    for (const listener of [...this.messageListeners]) listener({ data });
  }
  listenerCount(): number {
    return this.messageListeners.size + this.errorListeners.size;
  }
}

function fakeStream(withAudio = true): MediaStream {
  const videoTrack = {
    kind: 'video',
    getSettings: () => ({ width: 3840, height: 2160, frameRate: 30 }),
  };
  const audioTrack = {
    kind: 'audio',
    getSettings: () => ({ sampleRate: 48_000, channelCount: 2 }),
  };
  return {
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => (withAudio ? [audioTrack] : []),
  } as unknown as MediaStream;
}

function fakeDeps(worker: FakeWorker, overrides: Partial<WebcodecsTakeRecorderDeps> = {}): WebcodecsTakeRecorderDeps {
  return {
    createWorker: () => worker,
    createTrackProcessor: (track) => ({
      readable: { fakeStreamFor: (track as unknown as { kind: string }).kind } as unknown as ReadableStream<unknown>,
    }),
    collectOutputFile: async () => new Blob(['fake-mp4-bytes'], { type: 'video/mp4' }),
    ...overrides,
  };
}

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('the take recorder adapter', () => {
  it('starts the worker with the config ladder, both streams transferred, and a temp file name', () => {
    const worker = new FakeWorker();
    const recorder = new WebcodecsTakeRecorder(
      fakeStream(),
      { targetFps: 30, videoBitrate: 45_000_000, audioBitrate: 192_000 },
      fakeDeps(worker),
    );
    expect(recorder.mimeType).toBe('video/mp4');
    expect(recorder.videoBitsPerSecond).toBe(45_000_000);
    expect(recorder.audioBitsPerSecond).toBe(192_000);
    recorder.start(250);
    expect(worker.sent).toHaveLength(1);
    const start = worker.sent[0].message as {
      type: string;
      videoConfigs: VideoEncoderConfig[];
      audioConfig: AudioEncoderConfig | null;
      targetFps: number;
      fileName: string;
    };
    expect(start.type).toBe('start');
    expect(start.videoConfigs).toHaveLength(3);
    expect(start.audioConfig?.codec).toBe('mp4a.40.2');
    expect(start.targetFps).toBe(30);
    expect(start.fileName).toMatch(/^riddimroom-webcap-.*\.mp4$/);
    expect(worker.sent[0].transfer).toHaveLength(2); // video + audio readables
    recorder.dispose();
  });

  it('delivers telemetry, then the whole file as one data event, then stop — in that order', async () => {
    const worker = new FakeWorker();
    const events: string[] = [];
    const telemetry = { ...emptyCaptureEngineTelemetry(), framesReceived: 1800, framesEncoded: 1797, framesDroppedByQueue: 3, framesFilled: 12, audioIncluded: true, encoderCodec: 'avc1.640033' };
    const recorder = new WebcodecsTakeRecorder(
      fakeStream(),
      {
        targetFps: 30,
        videoBitrate: 45_000_000,
        audioBitrate: 192_000,
        onTelemetry: (t) => {
          events.push('telemetry');
          expect(t).toEqual(telemetry);
        },
      },
      fakeDeps(worker),
    );
    let dataBlob: Blob | null = null;
    recorder.ondataavailable = (e) => {
      events.push('data');
      dataBlob = e.data;
    };
    recorder.onstop = () => events.push('stop');
    recorder.onerror = () => events.push('error');
    recorder.start();
    recorder.stop();
    expect(worker.sent.map((s) => (s.message as { type: string }).type)).toEqual(['start', 'stop']);
    worker.emit({ type: 'finished', telemetry, fileName: 'riddimroom-webcap-x.mp4' });
    await flushAsync();
    expect(events).toEqual(['telemetry', 'data', 'stop']);
    expect(dataBlob).not.toBeNull();
    expect((dataBlob as unknown as Blob).type).toBe('video/mp4');
    expect(worker.terminated).toBe(true);
  });

  it('a worker error fires onerror exactly once and never a data/stop pair', async () => {
    const worker = new FakeWorker();
    const recorder = new WebcodecsTakeRecorder(
      fakeStream(),
      { targetFps: 30, videoBitrate: 45_000_000, audioBitrate: 192_000 },
      fakeDeps(worker),
    );
    const onError = vi.fn();
    const onData = vi.fn();
    const onStop = vi.fn();
    recorder.onerror = onError;
    recorder.ondataavailable = onData;
    recorder.onstop = onStop;
    recorder.start();
    worker.emit({ type: 'error', message: 'encoder refused' });
    worker.emit({ type: 'error', message: 'again' });
    await flushAsync();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onData).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
    expect(worker.terminated).toBe(true);
  });

  it('a start that cannot build its pipeline (track processor throws) errors instead of throwing', async () => {
    const worker = new FakeWorker();
    const recorder = new WebcodecsTakeRecorder(
      fakeStream(),
      { targetFps: 30, videoBitrate: 45_000_000, audioBitrate: 192_000 },
      fakeDeps(worker, {
        createTrackProcessor: () => {
          throw new Error('no processor');
        },
      }),
    );
    const onError = vi.fn();
    recorder.onerror = onError;
    expect(() => recorder.start()).not.toThrow();
    await flushAsync();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('dispose silences everything (the fallback has taken the take over)', async () => {
    const worker = new FakeWorker();
    const recorder = new WebcodecsTakeRecorder(
      fakeStream(),
      { targetFps: 30, videoBitrate: 45_000_000, audioBitrate: 192_000 },
      fakeDeps(worker),
    );
    const onError = vi.fn();
    const onData = vi.fn();
    const onStop = vi.fn();
    recorder.onerror = onError;
    recorder.ondataavailable = onData;
    recorder.onstop = onStop;
    recorder.start();
    recorder.dispose();
    worker.emit({ type: 'finished', telemetry: emptyCaptureEngineTelemetry(), fileName: 'x.mp4' });
    worker.emit({ type: 'error', message: 'late' });
    await flushAsync();
    expect(onError).not.toHaveBeenCalled();
    expect(onData).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
    expect(worker.listenerCount()).toBe(0);
  });

  it('a video-only stream starts without an audio config or transfer', () => {
    const worker = new FakeWorker();
    const recorder = new WebcodecsTakeRecorder(
      fakeStream(false),
      { targetFps: 30, videoBitrate: 45_000_000, audioBitrate: 192_000 },
      fakeDeps(worker),
    );
    recorder.start();
    const start = worker.sent[0].message as { audioConfig: AudioEncoderConfig | null; audioStream: unknown };
    expect(start.audioConfig).toBeNull();
    expect(start.audioStream).toBeNull();
    expect(worker.sent[0].transfer).toHaveLength(1);
    recorder.dispose();
  });

  it('the factory returns null where the platform pieces are absent (this test environment)', () => {
    // Node/jsdom has no MediaStreamTrackProcessor, VideoEncoder or
    // Worker — the factory must decline so the caller uses the
    // standard engine without ever surfacing a broken option.
    expect(
      createWebcodecsTakeRecorder(fakeStream(), { targetFps: 30, videoBitrate: 1_000_000, audioBitrate: 192_000 }),
    ).toBeNull();
  });
});

describe('Rung B interplay — a by-construction CFR take is already even', () => {
  it('a perfect granted-fps grid assesses 100% in tolerance and needs no steadying', () => {
    const fps = 30;
    const timestampsSec = Array.from({ length: 1800 }, (_, i) => i / fps);
    const plan = planCfrRetiming(timestampsSec, fps);
    expect(plan.assessment.withinTolerancePercent).toBe(100);
    expect(planNeedsSteadying(plan)).toBe(false);
  });

  it('the stamper grid and the Rung B grid agree: stamper stamps form an exactly even series', () => {
    // Feed the stamper slightly jittered capture timestamps around
    // a dropped frame; the STAMPED series (what lands in the file)
    // is the perfect grid — which is why the file assesses even.
    const stamper = new CfrSlotStamper(30);
    const t0 = 2_000_000;
    const stampedSlots: number[] = [];
    const captureOffsetsUs = [0, 34_100, 66_200, 133_000, 166_800]; // slot 3's frame never arrived
    for (const offset of captureOffsetsUs) {
      const { slot, fillsBefore } = stamper.stampFor(t0 + offset);
      for (let f = 0; f < fillsBefore; f++) stampedSlots.push(slot - fillsBefore + f);
      stampedSlots.push(slot);
    }
    expect(stampedSlots).toEqual([0, 1, 2, 3, 4, 5]);
    const stampedSec = stampedSlots.map((slot) => stamper.slotTiming(slot).timestampSec);
    const plan = planCfrRetiming(stampedSec, 30);
    expect(plan.assessment.withinTolerancePercent).toBe(100);
    expect(planNeedsSteadying(plan)).toBe(false);
  });
});
