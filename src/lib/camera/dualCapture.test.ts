import { describe, it, expect } from 'vitest';
import { recorderOptionsForTrackSettings } from './captureQuality';
import {
  DUAL_MIC_UNAVAILABLE_MESSAGE,
  DUAL_UNAVAILABLE_MESSAGE,
  attachMicrophone,
  buildDualPairings,
  dualAlignmentTrims,
  dualFailureDetails,
  dualStartDeltaMs,
  isDualRetryableError,
  pairFromLabels,
  probeDualCamera,
  selectDualDevicePair,
  tryRaiseRearResolution,
  type DualDeviceInfo,
  type DualProbeDeps,
} from './dualCapture';

const CANVAS = { canvasWidth: 1080, canvasHeight: 1920 };

/* ------------------------------------------------------------------ */
/* Fakes                                                               */
/* ------------------------------------------------------------------ */

interface FakeTrack {
  kind: string;
  readyState: string;
  muted: boolean;
  stopped: boolean;
  deviceId?: string;
  stop: () => void;
  getSettings: () => { deviceId?: string };
  applyConstraints?: (c: MediaTrackConstraints) => Promise<void>;
}

function makeFakeTrack(opts: { kind?: string; readyState?: string; muted?: boolean; deviceId?: string } = {}): FakeTrack {
  const track: FakeTrack = {
    kind: opts.kind ?? 'video',
    readyState: opts.readyState ?? 'live',
    muted: opts.muted ?? false,
    stopped: false,
    deviceId: opts.deviceId,
    stop() {
      this.stopped = true;
      this.readyState = 'ended';
    },
    getSettings() {
      return { deviceId: this.deviceId };
    },
  };
  return track;
}

function makeFakeStream(
  opts: { readyState?: string; muted?: boolean; deviceId?: string } = {},
): { stream: MediaStream; track: FakeTrack; audioTracks: FakeTrack[] } {
  const track = makeFakeTrack(opts);
  const audioTracks: FakeTrack[] = [];
  const stream = {
    getVideoTracks: () => [track],
    getAudioTracks: () => audioTracks,
    getTracks: () => [track, ...audioTracks],
    addTrack: (t: FakeTrack) => {
      if (t.kind === 'audio') audioTracks.push(t);
    },
  };
  return { stream: stream as unknown as MediaStream, track, audioTracks };
}

function makeMicStream(): { stream: MediaStream; track: FakeTrack } {
  const track = makeFakeTrack({ kind: 'audio' });
  const stream = {
    getVideoTracks: () => [],
    getAudioTracks: () => [track],
    getTracks: () => [track],
    addTrack: () => {},
  };
  return { stream: stream as unknown as MediaStream, track };
}

/** Probe deps with instant timers and always-flowing frames; override per test. */
function probeDeps(overrides: Partial<DualProbeDeps>): DualProbeDeps {
  return {
    delay: async () => {},
    framesFlowing: async () => true,
    ...overrides,
  } as DualProbeDeps;
}

function videoOf(c: MediaStreamConstraints): MediaTrackConstraints {
  return c.video as MediaTrackConstraints;
}

function device(id: string, label: string, kind = 'videoinput'): DualDeviceInfo {
  return { deviceId: id, kind, label } as DualDeviceInfo;
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

describe('messages', () => {
  it('keeps the exact R29 fallback wording', () => {
    expect(DUAL_UNAVAILABLE_MESSAGE).toBe(
      "This phone can't run both cameras at once in the browser — recording with one camera instead",
    );
  });

  it('has the exact mic-unavailable note', () => {
    expect(DUAL_MIC_UNAVAILABLE_MESSAGE).toBe(
      'Microphone unavailable — recording both cameras without sound',
    );
  });
});

/* ------------------------------------------------------------------ */
/* Pairing ladder                                                      */
/* ------------------------------------------------------------------ */

describe('buildDualPairings', () => {
  it('descends rear 1080/front 720 → 720/720 → 720/480, all 30fps and video-only', () => {
    const pairings = buildDualPairings(CANVAS);
    expect(pairings.map((p) => [p.rearShortSide, p.frontShortSide])).toEqual([
      [1080, 720],
      [720, 720],
      [720, 480],
    ]);
    expect(pairings.map((p) => p.label)).toEqual([
      'rear 1080p + front 720p',
      'rear 720p + front 720p',
      'rear 720p + front 480p',
    ]);
    for (const pairing of pairings) {
      for (const constraints of [pairing.rearConstraints, pairing.frontConstraints]) {
        expect(constraints.audio).toBe(false);
        expect(videoOf(constraints).frameRate).toEqual({ ideal: 30 });
      }
      expect(videoOf(pairing.rearConstraints).facingMode).toBe('environment');
      expect(videoOf(pairing.frontConstraints).facingMode).toBe('user');
      expect(videoOf(pairing.rearConstraints).deviceId).toBeUndefined();
    }
  });

  it('names exact deviceIds (and no facingMode) when a pair is given', () => {
    const pairings = buildDualPairings(CANVAS, { rearId: 'cam-back', frontId: 'cam-front' });
    for (const pairing of pairings) {
      expect(videoOf(pairing.rearConstraints).deviceId).toEqual({ exact: 'cam-back' });
      expect(videoOf(pairing.frontConstraints).deviceId).toEqual({ exact: 'cam-front' });
      expect(videoOf(pairing.rearConstraints).facingMode).toBeUndefined();
      expect(videoOf(pairing.frontConstraints).facingMode).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Device selection                                                    */
/* ------------------------------------------------------------------ */

describe('device pairing selection', () => {
  it('pairs by back/front labels', () => {
    const devices = [device('id-front', 'Front Camera'), device('id-back', 'Back Camera')];
    expect(pairFromLabels(devices)).toEqual({ rearId: 'id-back', frontId: 'id-front' });
    expect(selectDualDevicePair(devices)).toEqual({ rearId: 'id-back', frontId: 'id-front' });
  });

  it('uses the only other camera when just one side is labelled', () => {
    expect(pairFromLabels([device('a', 'Back Camera'), device('b', '')])).toEqual({
      rearId: 'a',
      frontId: 'b',
    });
    expect(pairFromLabels([device('a', ''), device('b', 'Selfie Camera')])).toEqual({
      rearId: 'a',
      frontId: 'b',
    });
  });

  it('returns null from pairFromLabels when nothing is labelled', () => {
    expect(pairFromLabels([device('a', ''), device('b', '')])).toBeNull();
  });

  it('falls back to the first two cameras in selectDualDevicePair (desktop route)', () => {
    expect(selectDualDevicePair([device('a', ''), device('b', ''), device('c', '')])).toEqual({
      rearId: 'a',
      frontId: 'b',
    });
  });

  it('ignores non-video devices and empty deviceIds', () => {
    expect(
      selectDualDevicePair([
        device('mic', 'Microphone', 'audioinput'),
        device('', 'Back Camera'),
        device('a', ''),
        device('b', ''),
      ]),
    ).toEqual({ rearId: 'a', frontId: 'b' });
  });

  it('returns null with fewer than two usable cameras', () => {
    expect(selectDualDevicePair([device('a', 'Back Camera')])).toBeNull();
    expect(pairFromLabels([device('a', 'Back Camera')])).toBeNull();
    expect(selectDualDevicePair([])).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Retry predicate + failure details                                   */
/* ------------------------------------------------------------------ */

describe('isDualRetryableError', () => {
  it('treats HAL rejections and aborts as step-down errors', () => {
    for (const name of ['OverconstrainedError', 'NotFoundError', 'NotReadableError', 'AbortError']) {
      expect(isDualRetryableError({ name })).toBe(true);
    }
  });

  it('keeps permission and unknown errors fatal', () => {
    expect(isDualRetryableError({ name: 'NotAllowedError' })).toBe(false);
    expect(isDualRetryableError({ name: 'SecurityError' })).toBe(false);
    expect(isDualRetryableError(null)).toBe(false);
    expect(isDualRetryableError(undefined)).toBe(false);
  });
});

describe('dualFailureDetails', () => {
  it('composes reason + error name + pairing last tried for a refused second camera', () => {
    expect(
      dualFailureDetails({
        reason: 'front-failed',
        error: { name: 'NotReadableError' },
        pairingLabel: 'rear 1080p + front 720p',
      }),
    ).toBe('the second camera was refused by the phone (NotReadableError) at rear 1080p + front 720p');
  });

  it('composes the rear-ended diagnosis without an error name', () => {
    expect(dualFailureDetails({ reason: 'rear-ended', pairingLabel: 'rear 720p + front 480p' })).toBe(
      'the main camera stopped when the second camera opened at rear 720p + front 480p',
    );
  });

  it('composes rear-failed and unsupported', () => {
    expect(
      dualFailureDetails({ reason: 'rear-failed', error: { name: 'NotAllowedError' }, pairingLabel: 'rear 1080p + front 720p' }),
    ).toBe('the main camera could not be opened (NotAllowedError) at rear 1080p + front 720p');
    expect(dualFailureDetails({ reason: 'unsupported' })).toBe('this browser does not provide camera access');
  });

  it('composes the front-open-failed diagnosis (R31)', () => {
    expect(
      dualFailureDetails({
        reason: 'front-open-failed',
        error: { name: 'NotReadableError' },
        pairingLabel: 'rear 720p + front 480p',
      }),
    ).toBe('the front camera could not be opened (NotReadableError) at rear 720p + front 480p');
  });

  it('appends the Tried list only when more than one strategy ran (R31)', () => {
    const base = {
      reason: 'front-open-failed' as const,
      error: { name: 'NotReadableError' },
      pairingLabel: 'rear 1080p + front 720p',
    };
    expect(
      dualFailureDetails({
        ...base,
        attempts: [
          { strategy: 'back camera first', reason: 'rear-failed' },
          { strategy: 'both cameras together', reason: 'rear-failed' },
          { strategy: 'front camera first', reason: 'front-open-failed' },
        ],
      }),
    ).toBe(
      'the front camera could not be opened (NotReadableError) at rear 1080p + front 720p Tried: back camera first, both cameras together, front camera first.',
    );
    // One attempt → the R30 wording, byte-identical.
    expect(
      dualFailureDetails({ ...base, attempts: [{ strategy: 'back camera first', reason: 'front-open-failed' }] }),
    ).toBe('the front camera could not be opened (NotReadableError) at rear 1080p + front 720p');
  });
});

/* ------------------------------------------------------------------ */
/* The probe                                                           */
/* ------------------------------------------------------------------ */

describe('probeDualCamera', () => {
  it('opens rear before front, both video-only, settles, and returns both streams on the first pairing', async () => {
    const rear = makeFakeStream();
    const front = makeFakeStream();
    const calls: MediaStreamConstraints[] = [];
    const delays: number[] = [];
    const getUserMedia = async (c: MediaStreamConstraints) => {
      calls.push(c);
      return calls.length === 1 ? rear.stream : front.stream;
    };
    const result = await probeDualCamera(
      probeDeps({
        getUserMedia,
        delay: async (ms) => {
          delays.push(ms);
        },
      }),
      CANVAS,
    );
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.rearStream).toBe(rear.stream);
      expect(result.frontStream).toBe(front.stream);
      expect(result.pairingLabel).toBe('rear 1080p + front 720p');
    }
    expect(calls).toHaveLength(2);
    expect(videoOf(calls[0]).facingMode).toBe('environment');
    expect(videoOf(calls[1]).facingMode).toBe('user');
    expect(calls[0].audio).toBe(false);
    expect(calls[1].audio).toBe(false);
    // The settle window ran before liveness was judged.
    expect(delays).toContain(1000);
    expect(rear.track.stopped).toBe(false);
    expect(front.track.stopped).toBe(false);
  });

  it('steps DOWN on a NotReadableError from the front camera instead of dying (the R29 fatal bug)', async () => {
    const created: Array<ReturnType<typeof makeFakeStream>> = [];
    let call = 0;
    const getUserMedia = async () => {
      call += 1;
      if (call === 2) throw { name: 'NotReadableError' };
      const s = makeFakeStream();
      created.push(s);
      return s.stream;
    };
    const result = await probeDualCamera(probeDeps({ getUserMedia }), CANVAS);
    expect(result.available).toBe(true);
    if (result.available) expect(result.pairingLabel).toBe('rear 720p + front 720p');
    // rear(p1), front(p1)✗, rear(p2), front(p2)
    expect(call).toBe(4);
    // The first pairing's rear stream was stopped before stepping down.
    expect(created[0].track.stopped).toBe(true);
  });

  it('steps down when the REAR open is refused with AbortError', async () => {
    let call = 0;
    const getUserMedia = async () => {
      call += 1;
      if (call === 1) throw { name: 'AbortError' };
      return makeFakeStream().stream;
    };
    const result = await probeDualCamera(probeDeps({ getUserMedia }), CANVAS);
    expect(result.available).toBe(true);
    if (result.available) expect(result.pairingLabel).toBe('rear 720p + front 720p');
    expect(call).toBe(3);
  });

  it('a rear track MUTED after the front opens still passes when frames are flowing (the R29 false negative)', async () => {
    const rear = makeFakeStream({ muted: true });
    const front = makeFakeStream();
    let call = 0;
    const getUserMedia = async () => {
      call += 1;
      return call === 1 ? rear.stream : front.stream;
    };
    const result = await probeDualCamera(probeDeps({ getUserMedia }), CANVAS);
    expect(result.available).toBe(true);
    expect(rear.track.stopped).toBe(false);
  });

  it('a rear track live but with NO frames across the window fails as rear-ended after every strategy', async () => {
    const created: MediaStream[] = [];
    // Role is read from the constraints, NOT the open order — the
    // R31 front-first strategy opens the front camera first, so
    // position parity no longer identifies which camera a stream is.
    const roles: Array<'rear' | 'front'> = [];
    const getUserMedia = async (c: MediaStreamConstraints) => {
      const s = makeFakeStream();
      created.push(s.stream);
      roles.push(videoOf(c).facingMode === 'user' ? 'front' : 'rear');
      return s.stream;
    };
    // Rear streams never flow; front streams do.
    const framesFlowing = async (s: MediaStream) => roles[created.indexOf(s)] === 'front';
    const result = await probeDualCamera(probeDeps({ getUserMedia, framesFlowing }), CANVAS);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe('rear-ended');
      // Base fields come from the LAST strategy (front-first, whose
      // ascending ladder ends at the largest pairing) + the Tried list.
      expect(result.details).toBe(
        'the main camera stopped when the second camera opened at rear 1080p + front 720p Tried: back camera first, both cameras together, front camera first.',
      );
    }
    // 3 strategies × 3 pairings × 2 opens, everything stopped.
    expect(created).toHaveLength(18);
  });

  it('a front track with no frames fails as front-failed with the refused wording', async () => {
    const created: MediaStream[] = [];
    const roles: Array<'rear' | 'front'> = [];
    const getUserMedia = async (c: MediaStreamConstraints) => {
      const s = makeFakeStream();
      created.push(s.stream);
      roles.push(videoOf(c).facingMode === 'user' ? 'front' : 'rear');
      return s.stream;
    };
    // Rear streams flow; front streams never do.
    const framesFlowing = async (s: MediaStream) => roles[created.indexOf(s)] === 'rear';
    const result = await probeDualCamera(probeDeps({ getUserMedia, framesFlowing }), CANVAS);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe('front-failed');
      expect(result.details).toBe(
        'the second camera was refused by the phone at rear 1080p + front 720p Tried: back camera first, both cameras together, front camera first.',
      );
    }
  });

  it('an ENDED rear track fails as rear-ended even without a frame probe', async () => {
    const rear = makeFakeStream({ readyState: 'ended' });
    const front = makeFakeStream();
    let call = 0;
    const getUserMedia = async () => {
      call += 1;
      return call % 2 === 1 ? rear.stream : front.stream;
    };
    const result = await probeDualCamera(
      probeDeps({ getUserMedia, framesFlowing: undefined }),
      CANVAS,
    );
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe('rear-ended');
    expect(front.track.stopped).toBe(true);
  });

  it('a non-retryable rear error fails immediately with exactly one call and full details', async () => {
    let calls = 0;
    const getUserMedia = async () => {
      calls += 1;
      throw { name: 'NotAllowedError' };
    };
    const result = await probeDualCamera(probeDeps({ getUserMedia }), CANVAS);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe('rear-failed');
      expect(result.details).toBe(
        'the main camera could not be opened (NotAllowedError) at rear 1080p + front 720p',
      );
      // R31: a permission denial stops the probe — the "together"
      // and "front-first" strategies are never invoked (the single
      // gum call above already proves it) and only one attempt is
      // recorded, so the details keep the exact R30 wording.
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts?.[0].strategy).toBe('back camera first');
    }
    expect(calls).toBe(1);
  });

  it('reports unsupported when there is no getUserMedia', async () => {
    const result = await probeDualCamera(probeDeps({ getUserMedia: null }), CANVAS);
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toBe('unsupported');
      expect(result.details).toBe('this browser does not provide camera access');
    }
  });

  it('uses label-exact deviceIds from the start when enumeration reveals them', async () => {
    const calls: MediaStreamConstraints[] = [];
    const getUserMedia = async (c: MediaStreamConstraints) => {
      calls.push(c);
      return makeFakeStream().stream;
    };
    const enumerateDevices = async () =>
      [device('cam-front', 'Front Camera'), device('cam-back', 'Back Camera')] as unknown as MediaDeviceInfo[];
    const result = await probeDualCamera(probeDeps({ getUserMedia, enumerateDevices }), CANVAS);
    expect(result.available).toBe(true);
    expect(videoOf(calls[0]).deviceId).toEqual({ exact: 'cam-back' });
    expect(videoOf(calls[1]).deviceId).toEqual({ exact: 'cam-front' });
  });

  it('refines to label-exact ids after the first open when the rear is the right camera', async () => {
    const calls: MediaStreamConstraints[] = [];
    let enumCalls = 0;
    const enumerateDevices = async () => {
      enumCalls += 1;
      return (enumCalls === 1
        ? [device('cam-back', ''), device('cam-front', '')]
        : [device('cam-back', 'Back Camera'), device('cam-front', 'Front Camera')]) as unknown as MediaDeviceInfo[];
    };
    const getUserMedia = async (c: MediaStreamConstraints) => {
      calls.push(c);
      // The facingMode rear open lands on cam-back (its real id).
      return makeFakeStream({ deviceId: calls.length === 1 ? 'cam-back' : undefined }).stream;
    };
    const result = await probeDualCamera(probeDeps({ getUserMedia, enumerateDevices }), CANVAS);
    expect(result.available).toBe(true);
    expect(calls).toHaveLength(2);
    expect(videoOf(calls[0]).facingMode).toBe('environment');
    // The front open used the refined exact id.
    expect(videoOf(calls[1]).deviceId).toEqual({ exact: 'cam-front' });
  });

  it('reopens the rear by exact id when facingMode landed on the WRONG physical camera', async () => {
    const made: Array<ReturnType<typeof makeFakeStream>> = [];
    let enumCalls = 0;
    const enumerateDevices = async () => {
      enumCalls += 1;
      return (enumCalls === 1
        ? [device('cam-back', ''), device('cam-front', '')]
        : [device('cam-back', 'Back Camera'), device('cam-front', 'Front Camera')]) as unknown as MediaDeviceInfo[];
    };
    const getUserMedia = async () => {
      const s = makeFakeStream({ deviceId: made.length === 0 ? 'cam-ultrawide' : undefined });
      made.push(s);
      return s.stream;
    };
    const calls: MediaStreamConstraints[] = [];
    const recordingGum = async (c: MediaStreamConstraints) => {
      calls.push(c);
      return getUserMedia();
    };
    const result = await probeDualCamera(
      probeDeps({ getUserMedia: recordingGum, enumerateDevices }),
      CANVAS,
    );
    expect(result.available).toBe(true);
    // rear(facingMode) → stopped → rear(exact) → front(exact)
    expect(calls).toHaveLength(3);
    expect(made[0].track.stopped).toBe(true);
    expect(videoOf(calls[1]).deviceId).toEqual({ exact: 'cam-back' });
    expect(videoOf(calls[2]).deviceId).toEqual({ exact: 'cam-front' });
  });

  it('falls back to first-two deviceId pairing when the whole facingMode ladder fails (desktop route)', async () => {
    const calls: MediaStreamConstraints[] = [];
    const enumerateDevices = async () =>
      [device('dev-0', ''), device('dev-1', '')] as unknown as MediaDeviceInfo[];
    const getUserMedia = async (c: MediaStreamConstraints) => {
      calls.push(c);
      const video = videoOf(c);
      const deviceIdExact = (video.deviceId as { exact?: string } | undefined)?.exact;
      const isFrontAsk = video.facingMode === 'user' || deviceIdExact === 'dev-1';
      const isDeviceIdAsk = !!video.deviceId;
      // Front refuses under facingMode at every pairing; succeeds by deviceId.
      if (isFrontAsk && !isDeviceIdAsk) throw { name: 'OverconstrainedError' };
      return makeFakeStream().stream;
    };
    const result = await probeDualCamera(probeDeps({ getUserMedia, enumerateDevices }), CANVAS);
    expect(result.available).toBe(true);
    // 3 facingMode pairings × 2 calls + 2 deviceId calls.
    expect(calls).toHaveLength(8);
    expect(videoOf(calls[6]).deviceId).toEqual({ exact: 'dev-0' });
    expect(videoOf(calls[7]).deviceId).toEqual({ exact: 'dev-1' });
  });
});

/* ------------------------------------------------------------------ */
/* The R31 deep probe: cool-down + together + front-first              */
/* ------------------------------------------------------------------ */

describe('probeDualCamera R31 deep probe', () => {
  it('waits out the 600ms cool-down ONCE, before the first camera open', async () => {
    const events: string[] = [];
    const delay = async (ms: number) => {
      events.push(`delay:${ms}`);
    };
    const getUserMedia = async () => {
      events.push('gum');
      return makeFakeStream().stream;
    };
    const result = await probeDualCamera(probeDeps({ getUserMedia, delay }), CANVAS);
    expect(result.available).toBe(true);
    // The component stopped its preview stream just before calling
    // the probe — the cool-down lands before ANY camera open.
    expect(events[0]).toBe('delay:600');
    expect(events[1]).toBe('gum');
    expect(events.filter((e) => e === 'delay:600')).toHaveLength(1);
    if (result.available) expect(result.strategy).toBe('back camera first');
  });

  it('cooldownMs: 0 skips the cool-down wait', async () => {
    const events: string[] = [];
    const delay = async (ms: number) => {
      events.push(`delay:${ms}`);
    };
    const getUserMedia = async () => {
      events.push('gum');
      return makeFakeStream().stream;
    };
    const result = await probeDualCamera(probeDeps({ getUserMedia, delay, cooldownMs: 0 }), CANVAS);
    expect(result.available).toBe(true);
    expect(events[0]).toBe('gum');
    expect(events).not.toContain('delay:600');
  });

  it('strategy "together" invokes BOTH opens before either resolves, and wins after rear-first fails', async () => {
    const calls: MediaStreamConstraints[] = [];
    const pending: Array<{ resolve: (s: MediaStream) => void }> = [];
    let call = 0;
    const getUserMedia = (c: MediaStreamConstraints): Promise<MediaStream> => {
      calls.push(c);
      call += 1;
      if (call <= 6) {
        // Rear-first ladder: the rear opens, the front (second) open
        // refuses with NotReadableError at every pairing — the R30
        // field failure.
        if (call % 2 === 0) return Promise.reject({ name: 'NotReadableError' });
        return Promise.resolve(makeFakeStream().stream);
      }
      // Together strategy: hold both opens pending until released.
      let resolve!: (s: MediaStream) => void;
      const promise = new Promise<MediaStream>((res) => {
        resolve = res;
      });
      pending.push({ resolve });
      return promise;
    };
    const probePromise = probeDualCamera(probeDeps({ getUserMedia }), CANVAS);
    let probeSettled = false;
    void probePromise.then(() => {
      probeSettled = true;
    });
    // Let the probe run until both together opens are in flight.
    for (let i = 0; i < 100 && pending.length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
    // Both getUserMedia invocations (calls 7 and 8) happened while
    // NEITHER promise had resolved and the probe was still running.
    expect(pending).toHaveLength(2);
    expect(calls).toHaveLength(8);
    expect(probeSettled).toBe(false);
    pending[0].resolve(makeFakeStream().stream);
    pending[1].resolve(makeFakeStream().stream);
    const result = await probePromise;
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.strategy).toBe('both cameras together');
      expect(result.pairingLabel).toBe('rear 720p + front 480p');
    }
  });

  it('strategy "together" tries the SMALLEST pairing first (rear 720p + front 480p)', async () => {
    const calls: MediaStreamConstraints[] = [];
    let call = 0;
    const getUserMedia = async (c: MediaStreamConstraints) => {
      calls.push(c);
      call += 1;
      if (call <= 6 && call % 2 === 0) throw { name: 'NotReadableError' };
      return makeFakeStream().stream;
    };
    const result = await probeDualCamera(probeDeps({ getUserMedia }), CANVAS);
    expect(result.available).toBe(true);
    if (result.available) expect(result.strategy).toBe('both cameras together');
    // Calls 7+8 are the first together attempt — ascending order.
    const togetherCalls = calls.slice(6);
    expect(videoOf(togetherCalls[0]).facingMode).toBe('environment');
    expect(videoOf(togetherCalls[0]).width).toEqual({ ideal: 720 });
    expect(videoOf(togetherCalls[1]).facingMode).toBe('user');
    expect(videoOf(togetherCalls[1]).width).toEqual({ ideal: 480 });
  });

  it('strategy "front-first" opens front before rear and wins after the first two strategies fail', async () => {
    const calls: MediaStreamConstraints[] = [];
    let call = 0;
    const getUserMedia = async (c: MediaStreamConstraints) => {
      calls.push(c);
      call += 1;
      if (call <= 6) {
        // Rear-first: the front second-open refuses at every pairing.
        if (call % 2 === 0) throw { name: 'NotReadableError' };
        return makeFakeStream().stream;
      }
      // Together: both opens refuse at every pairing.
      if (call <= 12) throw { name: 'NotReadableError' };
      // Front-first: both opens succeed.
      return makeFakeStream().stream;
    };
    const result = await probeDualCamera(probeDeps({ getUserMedia }), CANVAS);
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.strategy).toBe('front camera first');
      expect(result.pairingLabel).toBe('rear 720p + front 480p');
    }
    // Front-first phase (calls 13+): the FRONT opens first.
    expect(videoOf(calls[12]).facingMode).toBe('user');
    expect(videoOf(calls[13]).facingMode).toBe('environment');
  });

  it('when all three strategies fail, the details name every strategy tried and attempts record each one', async () => {
    let calls = 0;
    const getUserMedia = async () => {
      calls += 1;
      throw { name: 'NotReadableError' };
    };
    const result = await probeDualCamera(probeDeps({ getUserMedia }), CANVAS);
    expect(result.available).toBe(false);
    if (!result.available) {
      // Base fields come from the LAST strategy (front-first: its
      // first open refused at its last, largest ascending pairing).
      expect(result.reason).toBe('front-open-failed');
      expect(result.details).toBe(
        'the front camera could not be opened (NotReadableError) at rear 1080p + front 720p Tried: back camera first, both cameras together, front camera first.',
      );
      expect(result.attempts?.map((a) => a.strategy)).toEqual([
        'back camera first',
        'both cameras together',
        'front camera first',
      ]);
      expect(result.attempts?.map((a) => a.reason)).toEqual([
        'rear-failed',
        'rear-failed',
        'front-open-failed',
      ]);
      expect(result.attempts?.[2].errorName).toBe('NotReadableError');
    }
    // Bounded work: 3 rear-first opens + 3×2 together + 3 front-first.
    expect(calls).toBe(12);
  });
});

/* ------------------------------------------------------------------ */
/* Mic (separate, last)                                                */
/* ------------------------------------------------------------------ */

describe('attachMicrophone', () => {
  it('merges the mic track onto the rear stream', async () => {
    const rear = makeFakeStream();
    const mic = makeMicStream();
    const calls: MediaStreamConstraints[] = [];
    const getUserMedia = async (c: MediaStreamConstraints) => {
      calls.push(c);
      return mic.stream;
    };
    const result = await attachMicrophone(getUserMedia, rear.stream);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ audio: true }]);
    expect(rear.audioTracks).toContain(mic.track);
  });

  it('reports failure without throwing, leaving the rear stream silent (dual proceeds)', async () => {
    const rear = makeFakeStream();
    const getUserMedia = async () => {
      throw { name: 'NotAllowedError' };
    };
    const result = await attachMicrophone(getUserMedia, rear.stream);
    expect(result.ok).toBe(false);
    expect(rear.audioTracks).toHaveLength(0);
  });

  it('reports failure when getUserMedia is unavailable', async () => {
    const rear = makeFakeStream();
    expect((await attachMicrophone(null, rear.stream)).ok).toBe(false);
    expect((await attachMicrophone(undefined, rear.stream)).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Best-effort rear raise                                              */
/* ------------------------------------------------------------------ */

describe('tryRaiseRearResolution', () => {
  it('applies 1440p-class ideal constraints to the rear track', async () => {
    const rear = makeFakeStream();
    const applied: MediaTrackConstraints[] = [];
    rear.track.applyConstraints = async (c) => {
      applied.push(c);
    };
    expect(await tryRaiseRearResolution(rear.stream, 1080, 1920)).toBe(true);
    expect(applied).toHaveLength(1);
    // 9:16 canvas at short side 1440 → 1440 × 2560.
    expect(applied[0].width).toEqual({ ideal: 1440 });
    expect(applied[0].height).toEqual({ ideal: 2560 });
  });

  it('swallows a refusal and reports false', async () => {
    const rear = makeFakeStream();
    rear.track.applyConstraints = async () => {
      throw { name: 'NotReadableError' };
    };
    expect(await tryRaiseRearResolution(rear.stream, 1080, 1920)).toBe(false);
  });

  it('reports false when the track has no applyConstraints', async () => {
    const rear = makeFakeStream();
    rear.track.applyConstraints = undefined;
    expect(await tryRaiseRearResolution(rear.stream, 1080, 1920)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Start alignment (unchanged from R29)                                */
/* ------------------------------------------------------------------ */

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

describe('recorder config for the dual streams (documentation)', () => {
  it('a 1080p-class stream records at the 10 Mbps HD tier', () => {
    expect(recorderOptionsForTrackSettings({ width: 1920, height: 1080 }).videoBitsPerSecond).toBe(10_000_000);
  });
});
