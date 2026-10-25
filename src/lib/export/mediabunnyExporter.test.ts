import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_EXPORT_ENGINE,
  EXPORT_ENGINE_ENV_VAR,
  resolveExportEngine,
  getConfiguredExportEngine,
  createExportRenderer,
  evaluateMediabunnyCapabilities,
  probeMediabunnyCapabilities,
  assertMediabunnyCapabilities,
  defaultMediabunnyProber,
  buildAvcEncoderCodecString,
  buildRawVideoProbeConfig,
  buildRawAudioProbeConfig,
  encodeFramesToMp4,
  withStallTimeout,
  MediabunnyCapabilityError,
  type MediabunnyCapabilityProbe,
  type MediabunnyCapabilitySettings,
} from './mediabunnyExporter';
import {
  canEncodeVideo as mediabunnyCanEncodeVideo,
  canEncodeAudio as mediabunnyCanEncodeAudio,
} from 'mediabunny';

// The library seam the DEFAULT prober consults (advisory only since the
// round-3 fix): the real module with just canEncode* replaced by
// controllable stubs, so the prober tests can play "library says no"
// against "raw WebCodecs says yes" — the owner's-phone scenario.
vi.mock('mediabunny', async (importOriginal) => {
  const original = await importOriginal<typeof import('mediabunny')>();
  return {
    ...original,
    canEncodeVideo: vi.fn(async () => true),
    canEncodeAudio: vi.fn(async () => true),
  };
});

const advisoryCanEncodeVideo = vi.mocked(mediabunnyCanEncodeVideo);
const advisoryCanEncodeAudio = vi.mocked(mediabunnyCanEncodeAudio);

const SETTINGS: MediabunnyCapabilitySettings = {
  width: 1080,
  height: 1920,
  frameRate: 30,
  videoBitrate: 12_000_000,
  audioSampleRate: 48_000,
  audioChannels: 2,
  audioBitrate: 192_000,
  requireAudio: true,
};

const FULL_PROBE: MediabunnyCapabilityProbe = {
  webCodecsAvailable: true,
  avcEncodable: true,
  aacEncodable: true,
  opusEncodable: true,
};

describe('export engine selection (default OFF)', () => {
  it('defaults to the ffmpeg engine', () => {
    expect(DEFAULT_EXPORT_ENGINE).toBe('ffmpeg');
  });

  it('resolves an unset/empty value to ffmpeg', () => {
    expect(resolveExportEngine(undefined)).toBe('ffmpeg');
    expect(resolveExportEngine(null)).toBe('ffmpeg');
    expect(resolveExportEngine('')).toBe('ffmpeg');
  });

  it('resolves explicit ffmpeg to ffmpeg', () => {
    expect(resolveExportEngine('ffmpeg')).toBe('ffmpeg');
  });

  it('resolves mediabunny (any casing/whitespace) to mediabunny', () => {
    expect(resolveExportEngine('mediabunny')).toBe('mediabunny');
    expect(resolveExportEngine('Mediabunny')).toBe('mediabunny');
    expect(resolveExportEngine('  MEDIABUNNY  ')).toBe('mediabunny');
  });

  it('resolves unknown values to the safe default, never to mediabunny', () => {
    expect(resolveExportEngine('webcodecs')).toBe('ffmpeg');
    expect(resolveExportEngine('mediabunnyy')).toBe('ffmpeg');
    expect(resolveExportEngine('yes')).toBe('ffmpeg');
  });

  it('reads the build env var name VITE_EXPORT_ENGINE', () => {
    expect(EXPORT_ENGINE_ENV_VAR).toBe('VITE_EXPORT_ENGINE');
  });

  it('the configured engine in a default (flagless) build/test env is ffmpeg', () => {
    expect(getConfiguredExportEngine()).toBe('ffmpeg');
  });

  it('createExportRenderer returns the existing canvas2d pipeline for ffmpeg', () => {
    expect(createExportRenderer('ffmpeg').name).toBe('canvas2d');
  });

  it('createExportRenderer returns the mediabunny renderer when selected', () => {
    expect(createExportRenderer('mediabunny').name).toBe('mediabunny');
  });
});

describe('evaluateMediabunnyCapabilities (pure gate logic)', () => {
  it('fails with the WebCodecs reason when WebCodecs is absent', () => {
    const result = evaluateMediabunnyCapabilities(
      { webCodecsAvailable: false, avcEncodable: false, aacEncodable: false, opusEncodable: false },
      SETTINGS,
    );
    expect(result.supported).toBe(false);
    if (!result.supported) {
      expect(result.failure).toBe('webcodecs');
      expect(result.message).toContain('WebCodecs');
      expect(result.message).toContain('was not started');
    }
  });

  it('fails with the video reason (naming H.264 and the size) when AVC is unavailable', () => {
    const result = evaluateMediabunnyCapabilities(
      { ...FULL_PROBE, avcEncodable: false },
      SETTINGS,
    );
    expect(result.supported).toBe(false);
    if (!result.supported) {
      expect(result.failure).toBe('video-codec');
      expect(result.message).toContain('H.264');
      expect(result.message).toContain('1080×1920');
    }
  });

  it('prefers AAC when both audio codecs are encodable', () => {
    const result = evaluateMediabunnyCapabilities(FULL_PROBE, SETTINGS);
    expect(result.supported).toBe(true);
    if (result.supported) {
      expect(result.codecs.videoCodec).toBe('avc');
      expect(result.codecs.audioCodec).toBe('aac');
      expect(result.codecs.audioSampleRate).toBe(48_000);
      expect(result.codecs.audioChannels).toBe(2);
    }
  });

  it('negotiates Opus-in-MP4 where AAC encode does not exist (the desktop Chromium case)', () => {
    const result = evaluateMediabunnyCapabilities(
      { ...FULL_PROBE, aacEncodable: false, opusEncodable: true },
      SETTINGS,
    );
    expect(result.supported).toBe(true);
    if (result.supported) expect(result.codecs.audioCodec).toBe('opus');
  });

  it('fails with the audio reason when audio is required but neither AAC nor Opus encodes', () => {
    const result = evaluateMediabunnyCapabilities(
      { ...FULL_PROBE, aacEncodable: false, opusEncodable: false },
      SETTINGS,
    );
    expect(result.supported).toBe(false);
    if (!result.supported) {
      expect(result.failure).toBe('audio-codec');
      expect(result.message).toContain('AAC');
      expect(result.message).toContain('Opus');
    }
  });

  it('does not require an audio codec when the export has no audio track', () => {
    const result = evaluateMediabunnyCapabilities(
      { ...FULL_PROBE, aacEncodable: false, opusEncodable: false },
      { ...SETTINGS, requireAudio: false },
    );
    expect(result.supported).toBe(true);
    if (result.supported) expect(result.codecs.audioCodec).toBeNull();
  });
});

describe('capability gate (probe + assert)', () => {
  it('assert resolves with negotiated codecs from an injected prober', async () => {
    const prober = vi.fn(async () => ({ ...FULL_PROBE, aacEncodable: false }));
    const codecs = await assertMediabunnyCapabilities(SETTINGS, prober);
    expect(codecs.videoCodec).toBe('avc');
    expect(codecs.audioCodec).toBe('opus');
    expect(prober).toHaveBeenCalledWith(SETTINGS);
  });

  it('assert throws MediabunnyCapabilityError with the specific failure', async () => {
    const prober = vi.fn(async () => ({ ...FULL_PROBE, avcEncodable: false }));
    await expect(assertMediabunnyCapabilities(SETTINGS, prober)).rejects.toBeInstanceOf(
      MediabunnyCapabilityError,
    );
    await expect(assertMediabunnyCapabilities(SETTINGS, prober)).rejects.toMatchObject({
      name: 'MediabunnyCapabilityError',
      failure: 'video-codec',
    });
  });

  it('probe returns the evaluation without throwing', async () => {
    const prober = vi.fn(async () => ({
      webCodecsAvailable: false,
      avcEncodable: false,
      aacEncodable: false,
      opusEncodable: false,
    }));
    const evaluation = await probeMediabunnyCapabilities(SETTINGS, prober);
    expect(evaluation.supported).toBe(false);
    if (!evaluation.supported) expect(evaluation.failure).toBe('webcodecs');
  });
});

describe('encodeFramesToMp4 pre-flight honesty', () => {
  it('fails BEFORE drawing any frame when WebCodecs is unavailable (node test env has no VideoEncoder)', async () => {
    const drawFrame = vi.fn();
    await expect(
      encodeFramesToMp4({
        canvas: {} as HTMLCanvasElement,
        width: 1080,
        height: 1920,
        frameRate: 30,
        totalFrames: 150,
        drawFrame,
        audioBuffer: null,
        videoBitrate: 12_000_000,
        audioBitrate: 192_000,
      }),
    ).rejects.toBeInstanceOf(MediabunnyCapabilityError);
    expect(drawFrame).not.toHaveBeenCalled();
  });

  it('rejects a zero-frame encode as an export error, not a hang', async () => {
    await expect(
      encodeFramesToMp4({
        canvas: {} as HTMLCanvasElement,
        width: 1080,
        height: 1920,
        frameRate: 30,
        totalFrames: 0,
        drawFrame: () => undefined,
        audioBuffer: null,
        videoBitrate: 12_000_000,
        audioBitrate: 192_000,
      }),
    ).rejects.toThrow('no frames');
  });
});

// ---------------------------------------------------------------------------
// Round-3 fix (2026-10-23): raw-WebCodecs probe of record + probe-error
// honesty. The owner's phone evidence: raw configs (and real encodes
// under them) all passed while the library layer answered NO for every
// codec and the old prober's catch-all converted a probe-chain failure
// into an all-false "device verdict" in 2 ms.
// ---------------------------------------------------------------------------

type RawSupportHandler = (config: Record<string, unknown>) => Promise<{ supported?: boolean }>;

function stubWebCodecs(
  handlers: { video?: RawSupportHandler; aac?: RawSupportHandler; opus?: RawSupportHandler } = {},
) {
  const ok: RawSupportHandler = async () => ({ supported: true });
  const videoImpl = handlers.video ?? ok;
  const aacImpl = handlers.aac ?? ok;
  const opusImpl = handlers.opus ?? ok;
  const videoIsConfigSupported = vi.fn((config: Record<string, unknown>) => videoImpl(config));
  const audioIsConfigSupported = vi.fn((config: Record<string, unknown>) =>
    config.codec === 'opus' ? opusImpl(config) : aacImpl(config),
  );
  vi.stubGlobal('VideoEncoder', { isConfigSupported: videoIsConfigSupported });
  vi.stubGlobal('AudioEncoder', { isConfigSupported: audioIsConfigSupported });
  return { videoIsConfigSupported, audioIsConfigSupported };
}

describe('defaultMediabunnyProber — raw WebCodecs probe of record', () => {
  beforeEach(() => {
    advisoryCanEncodeVideo.mockReset().mockResolvedValue(true);
    advisoryCanEncodeAudio.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('phone regression: library says NO to everything, raw configs pass → all encodable, AAC negotiated', async () => {
    stubWebCodecs();
    advisoryCanEncodeVideo.mockResolvedValue(false);
    advisoryCanEncodeAudio.mockResolvedValue(false);

    const probe = await defaultMediabunnyProber(SETTINGS);
    expect(probe).toEqual({
      webCodecsAvailable: true,
      avcEncodable: true,
      aacEncodable: true,
      opusEncodable: true,
    });

    // The advisory library answers were still consulted — with the
    // exact arguments the pre-fix prober used — they just can't veto.
    expect(advisoryCanEncodeVideo).toHaveBeenCalledWith('avc', {
      width: 1080,
      height: 1920,
      bitrate: 12_000_000,
      frameRate: 30,
    });
    expect(advisoryCanEncodeAudio).toHaveBeenCalledWith('aac', {
      numberOfChannels: 2,
      sampleRate: 48_000,
      bitrate: 192_000,
    });
    expect(advisoryCanEncodeAudio).toHaveBeenCalledWith('opus', {
      numberOfChannels: 2,
      sampleRate: 48_000,
      bitrate: 192_000,
    });

    const codecs = await assertMediabunnyCapabilities(SETTINGS);
    expect(codecs.videoCodec).toBe('avc');
    expect(codecs.audioCodec).toBe('aac');
  });

  it('a raw "not supported" gates honestly even when the library says yes', async () => {
    stubWebCodecs({ video: async () => ({ supported: false }) });
    advisoryCanEncodeVideo.mockResolvedValue(true);

    const evaluation = await probeMediabunnyCapabilities(SETTINGS);
    expect(evaluation.supported).toBe(false);
    if (!evaluation.supported) {
      expect(evaluation.failure).toBe('video-codec');
      expect(evaluation.message).toContain('H.264');
      expect(evaluation.message).toContain('1080×1920');
    }
  });

  it('config-shape fidelity: probe configs deep-equal the runtime candidates (avc1.640028 at 1080×1920)', async () => {
    const { videoIsConfigSupported, audioIsConfigSupported } = stubWebCodecs();
    await defaultMediabunnyProber(SETTINGS);

    expect(buildAvcEncoderCodecString(1080, 1920, 12_000_000)).toBe('avc1.640028');

    expect(videoIsConfigSupported).toHaveBeenCalledTimes(1);
    const videoConfig = videoIsConfigSupported.mock.calls[0][0];
    expect(videoConfig).toStrictEqual({
      codec: 'avc1.640028',
      width: 1080,
      height: 1920,
      displayWidth: undefined,
      displayHeight: undefined,
      bitrate: 12_000_000,
      bitrateMode: 'variable',
      alpha: 'discard',
      framerate: 30,
      latencyMode: undefined,
      hardwareAcceleration: undefined,
      scalabilityMode: undefined,
      contentHint: undefined,
      avc: { format: 'avc' },
    });
    expect(buildRawVideoProbeConfig(SETTINGS)).toStrictEqual(videoConfig);

    expect(audioIsConfigSupported).toHaveBeenCalledTimes(2);
    const aacConfig = audioIsConfigSupported.mock.calls[0][0];
    const opusConfig = audioIsConfigSupported.mock.calls[1][0];
    expect(aacConfig).toStrictEqual({
      codec: 'mp4a.40.2',
      numberOfChannels: 2,
      sampleRate: 48_000,
      bitrate: 192_000,
      bitrateMode: undefined,
      aac: { format: 'aac' },
    });
    expect(opusConfig).toStrictEqual({
      codec: 'opus',
      numberOfChannels: 2,
      sampleRate: 48_000,
      bitrate: 192_000,
      bitrateMode: undefined,
      opus: { format: 'opus' },
    });
    expect(buildRawAudioProbeConfig('aac', SETTINGS)).toStrictEqual(aacConfig);
    expect(buildRawAudioProbeConfig('opus', SETTINGS)).toStrictEqual(opusConfig);
  });

  it('probe-throw honesty: isConfigSupported throws → probe-error naming the stage, cause preserved, never all-false', async () => {
    const boom = new Error('MediaCodec blew up');
    stubWebCodecs({
      video: async () => {
        throw boom;
      },
    });

    await expect(defaultMediabunnyProber(SETTINGS)).rejects.toMatchObject({
      name: 'MediabunnyCapabilityError',
      failure: 'probe-error',
      cause: boom,
    });
    await expect(defaultMediabunnyProber(SETTINGS)).rejects.toThrow(
      'capability check itself failed (stage: video-probe)',
    );

    const evaluation = await probeMediabunnyCapabilities(SETTINGS);
    expect(evaluation.supported).toBe(false);
    if (!evaluation.supported) {
      expect(evaluation.failure).toBe('probe-error');
      expect(evaluation.message).toContain('MediaCodec blew up');
      expect(evaluation.message).toContain('No codec verdict was reached');
      expect(evaluation.message).not.toContain('cannot encode');
      expect(evaluation.cause).toBe(boom);
    }
  });

  it('a library advisory throw is a probe-error at the audio stage, not a codec NO', async () => {
    stubWebCodecs();
    advisoryCanEncodeAudio.mockRejectedValue(new Error('audio probe exploded'));

    await expect(defaultMediabunnyProber(SETTINGS)).rejects.toMatchObject({
      name: 'MediabunnyCapabilityError',
      failure: 'probe-error',
    });
    await expect(defaultMediabunnyProber(SETTINGS)).rejects.toThrow('stage: audio-probe');
    await expect(defaultMediabunnyProber(SETTINGS)).rejects.toThrow('audio probe exploded');
  });

  it('still answers "absent" honestly when the WebCodecs globals do not exist', async () => {
    const probe = await defaultMediabunnyProber(SETTINGS);
    expect(probe.webCodecsAvailable).toBe(false);
    expect(advisoryCanEncodeVideo).not.toHaveBeenCalled();
  });
});

describe('probe-error honesty (injected prober)', () => {
  it('a rejecting prober → assert throws a probe-error MediabunnyCapabilityError with the cause preserved', async () => {
    const boom = new Error('socket exploded');
    const prober = vi.fn(async () => {
      throw boom;
    });

    await expect(assertMediabunnyCapabilities(SETTINGS, prober)).rejects.toBeInstanceOf(
      MediabunnyCapabilityError,
    );
    const err = await assertMediabunnyCapabilities(SETTINGS, prober).catch((e: unknown) => e);
    expect(err).toMatchObject({
      name: 'MediabunnyCapabilityError',
      failure: 'probe-error',
      cause: boom,
    });
    expect((err as Error).message).toContain('socket exploded');
    expect((err as Error).message).toContain('capability check itself failed');
    expect((err as Error).message).not.toContain('cannot encode');
  });

  it('probeMediabunnyCapabilities converts a rejecting prober into the probe-error evaluation instead of throwing', async () => {
    const prober = vi.fn(async () => {
      throw new Error('total probe failure');
    });
    const evaluation = await probeMediabunnyCapabilities(SETTINGS, prober);
    expect(evaluation.supported).toBe(false);
    if (!evaluation.supported) {
      expect(evaluation.failure).toBe('probe-error');
      expect(evaluation.message).toContain('total probe failure');
      expect(evaluation.cause).toBeInstanceOf(Error);
    }
  });
});

describe('library-load failure (the round-3 phone evidence)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a failed mediabunny dynamic import is a probe-error at stage library-load, never all-false', async () => {
    stubWebCodecs();
    vi.resetModules();
    vi.doMock('mediabunny', () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    try {
      const mod = await import('./mediabunnyExporter');
      const err = await mod.defaultMediabunnyProber(SETTINGS).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(mod.MediabunnyCapabilityError);
      expect(err).toMatchObject({
        name: 'MediabunnyCapabilityError',
        failure: 'probe-error',
      });
      expect((err as Error).message).toContain(
        'capability check itself failed (stage: library-load)',
      );
      expect((err as Error).message).toContain('No codec verdict was reached');
      expect((err as Error).message).not.toContain('cannot encode');
      // The original import failure is preserved as the cause (vitest
      // interposes its own mocking error text for the factory throw, so
      // assert the cause's presence/type here; the verbatim-text
      // property is proven by the video-probe and injected-prober tests).
      expect((err as { cause?: unknown }).cause).toBeInstanceOf(Error);
    } finally {
      vi.doUnmock('mediabunny');
      vi.resetModules();
    }
  });
});

describe('withStallTimeout (encode stall watchdog)', () => {
  it('passes through a fast result', async () => {
    await expect(withStallTimeout(Promise.resolve(42), 1000, 'stalled')).resolves.toBe(42);
  });
  it('rejects a wedged promise with an honest stall error', async () => {
    const never = new Promise<number>(() => undefined);
    await expect(withStallTimeout(never, 20, 'encoder stalled')).rejects.toThrow('encoder stalled');
  });
  it('propagates the original rejection when work fails first', async () => {
    await expect(withStallTimeout(Promise.reject(new Error('boom')), 1000, 'stalled')).rejects.toThrow('boom');
  });
});
