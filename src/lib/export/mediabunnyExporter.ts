/**
 * RiddimRoom Studio — Mediabunny/WebCodecs export engine (Pre-live build 2).
 *
 * The second export engine, behind the SAME `Renderer` contract the UI
 * already uses (renderer.ts). Where the default pipeline renders a
 * project in real time through Canvas2D + MediaRecorder into a WebM and
 * then transcodes that WebM to MP4 with ffmpeg.wasm (two passes, the
 * second one pure re-encode), this engine steps the shared compositor
 * (`drawFrame`) frame by frame — deterministically, not in real time —
 * and encodes each frame directly to H.264 via WebCodecs (Mediabunny's
 * `CanvasSource` → `Mp4OutputFormat`), with the project's audio pre-mixed
 * offline (`OfflineAudioContext`) into a single buffer encoded alongside
 * (AAC where the platform offers it, Opus-in-MP4 where it doesn't). One
 * pass, no MediaRecorder capture, no second transcode. The design follows
 * the architecture the OpenCut study validated (deterministic frame loop,
 * offline audio pre-mix, progress = frames encoded / total) — the code
 * here is ours, written against Studio's own timeline model.
 *
 * Feasibility was proven before this module existed (Phase 4L spike,
 * mediabunny 1.62.1, Chromium 152: 300/300 frames of a Studio-style
 * 1080×1920 composite, ffprobe-valid H.264 out; ~20× realtime on this
 * 2-core software-encode VM — an upper bound, not a phone prediction).
 *
 * ENGINE SELECTION — DEFAULT OFF. The default engine remains 'ffmpeg'
 * (Canvas2DRenderer + mp4Transcoder). This engine is used only when the
 * build sets VITE_EXPORT_ENGINE=mediabunny (same import.meta.env pattern
 * as src/lib/firebase.ts). Shipping it in the bundle changes nothing for
 * anyone until that flag is set — enablement on real user devices is a
 * separate, phone-gated decision.
 *
 * HONEST FAILURE, NO SILENT FALLBACK. When this engine IS selected, its
 * capability gate runs BEFORE any media is loaded or any frame is drawn:
 * if WebCodecs is absent, or H.264 can't be encoded at the requested
 * size/rate, or (when the project has audio) neither AAC nor Opus can be
 * encoded, the export fails immediately with a specific
 * `MediabunnyCapabilityError` naming the missing capability. It never
 * quietly switches engines mid-export and never hangs waiting for an
 * encoder that doesn't exist. And if the capability CHECK itself fails
 * (the library can't load, a probe call throws), that is reported as
 * its own distinct failure ('probe-error') — never disguised as a
 * codec verdict about the device.
 *
 * Known limits, stated up front (see the build report): the whole MP4 is
 * assembled in memory (Mediabunny `BufferTarget`, the spike-proven
 * target), and the offline audio pre-mix holds the mixed buffer in
 * memory too — long-form (10-minute) memory behavior is unproven and
 * gated on the on-device spike, exactly like all real-phone behavior.
 */

import type { Project, TimelineItem } from '../../types/timeline';
import { getItemsAtTime, getProjectDuration } from '../timeline/utils';
import { computeFadeOpacity, computeLoopedSourceTime, drawFrame } from '../render/compositor';
import type { Renderer, RenderOptions, RenderResult, RenderResultMetadata } from './renderer';
import { RenderAbortedError } from './renderer';
import { Canvas2DRenderer } from './canvas2dRenderer';

// ---------------------------------------------------------------------------
// Engine selection
// ---------------------------------------------------------------------------

export type ExportEngineId = 'ffmpeg' | 'mediabunny';

/** The engine every build uses unless explicitly configured otherwise. */
export const DEFAULT_EXPORT_ENGINE: ExportEngineId = 'ffmpeg';

/** Build-time env var that selects the export engine (Vite inlines it). */
export const EXPORT_ENGINE_ENV_VAR = 'VITE_EXPORT_ENGINE';

/**
 * Pure selection rule: only the exact value 'mediabunny' (any casing,
 * surrounding whitespace tolerated) selects the new engine. Everything
 * else — unset, 'ffmpeg', a typo, an arbitrary string — resolves to the
 * default 'ffmpeg' engine, so a misconfigured build degrades to the
 * proven pipeline instead of to a broken one. (This is build-time
 * configuration resolution, NOT a runtime fallback: once 'mediabunny'
 * is selected, its capability failures are hard errors, never a switch.)
 */
export function resolveExportEngine(rawValue: string | undefined | null): ExportEngineId {
  return typeof rawValue === 'string' && rawValue.trim().toLowerCase() === 'mediabunny'
    ? 'mediabunny'
    : 'ffmpeg';
}

/** Reads the engine selected for this build (import.meta.env, firebase.ts pattern). */
export function getConfiguredExportEngine(): ExportEngineId {
  const metaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env || {};
  return resolveExportEngine(metaEnv[EXPORT_ENGINE_ENV_VAR]);
}

/**
 * The renderer factory ExportPanel drives. 'ffmpeg' is the pre-existing
 * pipeline (Canvas2DRenderer produces the WebM; ExportPanel then runs
 * the ffmpeg transcode stage). 'mediabunny' produces the finished MP4
 * directly from `render()`.
 */
export function createExportRenderer(engine: ExportEngineId = getConfiguredExportEngine()): Renderer {
  return engine === 'mediabunny' ? new MediabunnyRenderer() : new Canvas2DRenderer();
}

// ---------------------------------------------------------------------------
// Capability gate
// ---------------------------------------------------------------------------

export type MediabunnyCapabilityFailure =
  | 'webcodecs'
  | 'video-codec'
  | 'audio-codec'
  /**
   * The capability CHECK ITSELF failed (library load, or a probe call
   * threw) before any codec verdict was reached. Distinct from every
   * codec verdict on purpose: a failed check must never be reported as
   * "this device cannot encode …". (Phone spike round 3, 2026-10-23:
   * the previous prober's catch-all converted exactly this case into
   * all-codecs-false, and the gate accused a fully capable phone.)
   */
  | 'probe-error';

/** The export cannot start on this browser/platform — the message says exactly why. */
export class MediabunnyCapabilityError extends Error {
  constructor(
    message: string,
    readonly failure: MediabunnyCapabilityFailure,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MediabunnyCapabilityError';
  }
}

/** Any other failure of the Mediabunny engine (encode/mux/finalize stage). */
export class MediabunnyExportError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'MediabunnyExportError';
  }
}

/** The encode parameters the capability probe must verify for a concrete export. */
export interface MediabunnyCapabilitySettings {
  width: number;
  height: number;
  frameRate: number;
  videoBitrate: number;
  audioSampleRate: number;
  audioChannels: number;
  audioBitrate: number;
  /** True when the export will carry an audio track, so an audio codec must exist. */
  requireAudio: boolean;
}

/** Raw probe answers (booleans only — the decision logic lives in `evaluateMediabunnyCapabilities`). */
export interface MediabunnyCapabilityProbe {
  webCodecsAvailable: boolean;
  avcEncodable: boolean;
  aacEncodable: boolean;
  opusEncodable: boolean;
}

export type MediabunnyCapabilityProber = (
  settings: MediabunnyCapabilitySettings,
) => Promise<MediabunnyCapabilityProbe>;

export interface NegotiatedExportCodecs {
  videoCodec: 'avc';
  /** 'aac' preferred; 'opus' where AAC encode doesn't exist; null when no audio track will be written. */
  audioCodec: 'aac' | 'opus' | null;
  audioSampleRate: number;
  audioChannels: number;
}

export type MediabunnyCapabilityEvaluation =
  | { supported: true; codecs: NegotiatedExportCodecs }
  | {
      supported: false;
      failure: MediabunnyCapabilityFailure;
      message: string;
      /** The original error, set when this failure came from a thrown probe (failure 'probe-error'). */
      cause?: unknown;
    };

/**
 * Pure decision logic over probe answers: WebCodecs presence → H.264
 * video → audio (AAC first, Opus second, either acceptable; neither is
 * a failure only when an audio track is actually required).
 */
export function evaluateMediabunnyCapabilities(
  probe: MediabunnyCapabilityProbe,
  settings: MediabunnyCapabilitySettings,
): MediabunnyCapabilityEvaluation {
  if (!probe.webCodecsAvailable) {
    return {
      supported: false,
      failure: 'webcodecs',
      message:
        'The Mediabunny export engine needs WebCodecs (VideoEncoder/AudioEncoder), which this browser does not provide. The export was not started.',
    };
  }
  if (!probe.avcEncodable) {
    return {
      supported: false,
      failure: 'video-codec',
      message: `This browser cannot encode H.264 (AVC) video at ${settings.width}×${settings.height}, which the Mediabunny export engine requires for MP4 output. The export was not started.`,
    };
  }
  let audioCodec: 'aac' | 'opus' | null = null;
  if (probe.aacEncodable) audioCodec = 'aac';
  else if (probe.opusEncodable) audioCodec = 'opus';
  if (settings.requireAudio && audioCodec === null) {
    return {
      supported: false,
      failure: 'audio-codec',
      message:
        'This browser can encode neither AAC nor Opus audio, so the Mediabunny export engine cannot include this project\'s audio track. The export was not started.',
    };
  }
  return {
    supported: true,
    codecs: {
      videoCodec: 'avc',
      audioCodec,
      audioSampleRate: settings.audioSampleRate,
      audioChannels: settings.audioChannels,
    },
  };
}

// ---------------------------------------------------------------------------
// Raw-WebCodecs probe of record
//
// Round 3 of the on-device spike (2026-10-23) settled why the gate must
// not trust Mediabunny's `canEncodeVideo`/`canEncodeAudio` as the probe
// of record: on the owner's Android phone the library layer answered NO
// for every codec (and the import behind it failed outright), while raw
// WebCodecs configs — and real 30-frame encodes under them — passed,
// including the exact config the runtime uses. So the probe of record is
// raw `isConfigSupported` with the exact runtime config shapes below.
// `canEncode*` stay as an ADVISORY signal: still called (their answers
// are cheap and usually right, and a throw from them is a real probe
// failure that must be attributed), but a library false contradicted by
// a raw true no longer gates — raw wins, because real encodes outrank
// both probes. And any THROW anywhere in the prober is a 'probe-error':
// a failed CHECK is reported as a failed check, never rewritten as a
// codec verdict (that rewrite is what round 1's all-false was).
// ---------------------------------------------------------------------------

/** The AVC level table Mediabunny 1.62.1's `buildVideoCodecString` selects from (ISO/IEC 14496-10 Annex A values). */
const AVC_LEVEL_TABLE: ReadonlyArray<{ maxMacroblocks: number; maxBitrate: number; level: number }> = [
  { maxMacroblocks: 99, maxBitrate: 64_000, level: 0x0a }, // Level 1
  { maxMacroblocks: 396, maxBitrate: 192_000, level: 0x0b }, // Level 1.1
  { maxMacroblocks: 396, maxBitrate: 384_000, level: 0x0c }, // Level 1.2
  { maxMacroblocks: 396, maxBitrate: 768_000, level: 0x0d }, // Level 1.3
  { maxMacroblocks: 396, maxBitrate: 2_000_000, level: 0x14 }, // Level 2
  { maxMacroblocks: 792, maxBitrate: 4_000_000, level: 0x15 }, // Level 2.1
  { maxMacroblocks: 1_620, maxBitrate: 4_000_000, level: 0x16 }, // Level 2.2
  { maxMacroblocks: 1_620, maxBitrate: 10_000_000, level: 0x1e }, // Level 3
  { maxMacroblocks: 3_600, maxBitrate: 14_000_000, level: 0x1f }, // Level 3.1
  { maxMacroblocks: 5_120, maxBitrate: 20_000_000, level: 0x20 }, // Level 3.2
  { maxMacroblocks: 8_192, maxBitrate: 20_000_000, level: 0x28 }, // Level 4
  { maxMacroblocks: 8_192, maxBitrate: 50_000_000, level: 0x29 }, // Level 4.1
  { maxMacroblocks: 8_704, maxBitrate: 50_000_000, level: 0x2a }, // Level 4.2
  { maxMacroblocks: 22_080, maxBitrate: 135_000_000, level: 0x32 }, // Level 5
  { maxMacroblocks: 36_864, maxBitrate: 240_000_000, level: 0x33 }, // Level 5.1
  { maxMacroblocks: 36_864, maxBitrate: 240_000_000, level: 0x34 }, // Level 5.2
  { maxMacroblocks: 139_264, maxBitrate: 240_000_000, level: 0x3c }, // Level 6
  { maxMacroblocks: 139_264, maxBitrate: 480_000_000, level: 0x3d }, // Level 6.1
  { maxMacroblocks: 139_264, maxBitrate: 800_000_000, level: 0x3e }, // Level 6.2
];

/**
 * The H.264 codec string the runtime actually encodes with, recomputed
 * the way Mediabunny 1.62.1's `buildVideoCodecString('avc', width,
 * height, bitrateEstimate, false)` computes it — so the raw probe asks
 * about the SAME string the runtime `CanvasSource` will negotiate
 * (1080×1920 @ 12 Mbps → `avc1.640028`: 8,160 macroblocks, High Profile,
 * Level 4).
 */
export function buildAvcEncoderCodecString(width: number, height: number, bitrate: number): string {
  const profileIndication = 0x64; // High Profile
  const totalMacroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const levelInfo =
    AVC_LEVEL_TABLE.find((entry) => totalMacroblocks <= entry.maxMacroblocks && bitrate <= entry.maxBitrate) ??
    AVC_LEVEL_TABLE[AVC_LEVEL_TABLE.length - 1];
  return `avc1.${profileIndication.toString(16).padStart(2, '0')}00${levelInfo.level.toString(16).padStart(2, '0')}`;
}

/**
 * The exact video config object Mediabunny's runtime builder
 * (`buildVideoEncoderConfigs`, bitrate candidate) hands to
 * `VideoEncoder.isConfigSupported` for this module's export settings —
 * including the members the builder copies straight through as
 * `undefined` (WebIDL drops them, but the shape is replicated
 * faithfully so the probe asks about the runtime's config, not a
 * paraphrase of it).
 */
export function buildRawVideoProbeConfig(
  settings: MediabunnyCapabilitySettings,
): Record<string, unknown> {
  return {
    codec: buildAvcEncoderCodecString(settings.width, settings.height, settings.videoBitrate),
    width: settings.width,
    height: settings.height,
    displayWidth: undefined,
    displayHeight: undefined,
    bitrate: settings.videoBitrate,
    bitrateMode: 'variable',
    alpha: 'discard',
    framerate: settings.frameRate,
    latencyMode: undefined,
    hardwareAcceleration: undefined,
    scalabilityMode: undefined,
    contentHint: undefined,
    avc: { format: 'avc' }, // getVideoEncoderConfigExtension: "Ensure the format is not Annex B"
  };
}

/**
 * The exact audio config object Mediabunny's runtime builder
 * (`buildAudioEncoderConfig`) hands to `AudioEncoder.isConfigSupported`
 * — codec string from `buildAudioCodecString` ('mp4a.40.2' / 'opus'),
 * the explicit bitrate from Quality, `bitrateMode: undefined` (no
 * Quality bitrate mode and no caller bitrateMode in this module's
 * path), plus the per-codec format member the library always adds.
 */
export function buildRawAudioProbeConfig(
  codec: 'aac' | 'opus',
  settings: MediabunnyCapabilitySettings,
): Record<string, unknown> {
  return {
    codec: codec === 'aac' ? 'mp4a.40.2' : 'opus',
    numberOfChannels: settings.audioChannels,
    sampleRate: settings.audioSampleRate,
    bitrate: settings.audioBitrate,
    bitrateMode: undefined,
    [codec]: { format: codec }, // getAudioEncoderConfigExtension: aac "not ADTS" / opus format member
  };
}

/** Minimal WebCodecs surface the raw probe needs from the encoder constructors. */
interface WebCodecsSupportQuerier {
  isConfigSupported(config: Record<string, unknown>): Promise<{ supported?: boolean } | undefined>;
}

function rawSupportQuerier(name: 'VideoEncoder' | 'AudioEncoder'): WebCodecsSupportQuerier | undefined {
  const ctor = (globalThis as unknown as Record<string, unknown>)[name] as
    | WebCodecsSupportQuerier
    | undefined;
  return ctor && typeof ctor.isConfigSupported === 'function' ? ctor : undefined;
}

/** The probe stage a capability-check failure occurred in — named in the error, never a codec verdict. */
export type MediabunnyProbeStage = 'library-load' | 'video-probe' | 'audio-probe' | 'probe';

function capabilityProbeError(stage: MediabunnyProbeStage, cause: unknown): MediabunnyCapabilityError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new MediabunnyCapabilityError(
    `The export engine's capability check itself failed (stage: ${stage}): ${detail}. No codec verdict was reached, so the export was not started.`,
    'probe-error',
    cause,
  );
}

/**
 * The real prober — raw WebCodecs probe of record (see the section
 * note above). WebCodecs globals first (no library load needed to
 * answer "absent"). Mediabunny is imported lazily so the library stays
 * out of the main bundle until this engine is used — but an import
 * failure is now a 'probe-error' at stage 'library-load', not three
 * phantom codec NOs.
 */
export const defaultMediabunnyProber: MediabunnyCapabilityProber = async (settings) => {
  const webCodecsAvailable =
    typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined';
  if (!webCodecsAvailable) {
    return { webCodecsAvailable: false, avcEncodable: false, aacEncodable: false, opusEncodable: false };
  }

  let canEncodeVideo: typeof import('mediabunny').canEncodeVideo;
  let canEncodeAudio: typeof import('mediabunny').canEncodeAudio;
  try {
    ({ canEncodeVideo, canEncodeAudio } = await import('mediabunny'));
  } catch (err) {
    throw capabilityProbeError('library-load', err);
  }

  // --- video stage: raw config probe of record + advisory library call ---
  let avcEncodable: boolean;
  try {
    const videoEncoder = rawSupportQuerier('VideoEncoder');
    if (!videoEncoder) {
      throw new TypeError('VideoEncoder is present but exposes no isConfigSupported to probe with.');
    }
    const [rawSupported] = await Promise.all([
      videoEncoder
        .isConfigSupported(buildRawVideoProbeConfig(settings))
        .then((support) => support?.supported === true),
      // Advisory only: the library's answer never gates (see the
      // section note), but a throw here is still a probe failure that
      // must be attributed to this stage, not swallowed.
      canEncodeVideo('avc', {
        width: settings.width,
        height: settings.height,
        bitrate: settings.videoBitrate,
        frameRate: settings.frameRate,
      }),
    ]);
    avcEncodable = rawSupported;
  } catch (err) {
    throw capabilityProbeError('video-probe', err);
  }

  // --- audio stage: raw config probes of record + advisory library calls ---
  let aacEncodable: boolean;
  let opusEncodable: boolean;
  try {
    const audioEncoder = rawSupportQuerier('AudioEncoder');
    if (!audioEncoder) {
      throw new TypeError('AudioEncoder is present but exposes no isConfigSupported to probe with.');
    }
    const [rawAac, rawOpus] = await Promise.all([
      audioEncoder
        .isConfigSupported(buildRawAudioProbeConfig('aac', settings))
        .then((support) => support?.supported === true),
      audioEncoder
        .isConfigSupported(buildRawAudioProbeConfig('opus', settings))
        .then((support) => support?.supported === true),
      canEncodeAudio('aac', {
        numberOfChannels: settings.audioChannels,
        sampleRate: settings.audioSampleRate,
        bitrate: settings.audioBitrate,
      }),
      canEncodeAudio('opus', {
        numberOfChannels: settings.audioChannels,
        sampleRate: settings.audioSampleRate,
        bitrate: settings.audioBitrate,
      }),
    ]);
    aacEncodable = rawAac;
    opusEncodable = rawOpus;
  } catch (err) {
    throw capabilityProbeError('audio-probe', err);
  }

  return { webCodecsAvailable, avcEncodable, aacEncodable, opusEncodable };
};

/**
 * Evaluates a prober's answers without throwing. A probe FAILURE is not
 * probe answers: any throw — an injected prober rejecting, or the
 * default prober's stage-attributed probe-error — converts to the
 * 'probe-error' evaluation so this non-throwing contract holds. Nothing
 * here ever claims a codec is unsupported on the evidence of a failed
 * check.
 */
export async function probeMediabunnyCapabilities(
  settings: MediabunnyCapabilitySettings,
  prober: MediabunnyCapabilityProber = defaultMediabunnyProber,
): Promise<MediabunnyCapabilityEvaluation> {
  try {
    return evaluateMediabunnyCapabilities(await prober(settings), settings);
  } catch (err) {
    if (err instanceof MediabunnyCapabilityError) {
      return { supported: false, failure: err.failure, message: err.message, cause: err.cause };
    }
    const probeErr = capabilityProbeError('probe', err);
    return { supported: false, failure: probeErr.failure, message: probeErr.message, cause: probeErr.cause };
  }
}

/** The gate itself: resolves with the negotiated codecs or throws `MediabunnyCapabilityError`. */
export async function assertMediabunnyCapabilities(
  settings: MediabunnyCapabilitySettings,
  prober: MediabunnyCapabilityProber = defaultMediabunnyProber,
): Promise<NegotiatedExportCodecs> {
  const evaluation = await probeMediabunnyCapabilities(settings, prober);
  if (!evaluation.supported) {
    throw new MediabunnyCapabilityError(evaluation.message, evaluation.failure, evaluation.cause);
  }
  return evaluation.codecs;
}

// ---------------------------------------------------------------------------
// Frame-by-frame encoder core
// ---------------------------------------------------------------------------

export interface MediabunnyEncodeProgress {
  framesEncoded: number;
  totalFrames: number;
  /** framesEncoded / totalFrames — a real measured ratio, never an estimate. */
  ratio: number;
}

export interface EncodeFramesToMp4Options {
  /** The canvas the caller draws each frame into (its size must equal width × height). */
  canvas: HTMLCanvasElement | OffscreenCanvas;
  width: number;
  height: number;
  frameRate: number;
  totalFrames: number;
  /** Draws frame `frameIndex` (at `timeSeconds`) into the canvas. Awaited per frame. */
  drawFrame: (frameIndex: number, timeSeconds: number) => void | Promise<void>;
  /** The whole audio track as one buffer (offline pre-mix), or null for a silent export. */
  audioBuffer?: AudioBuffer | null;
  videoBitrate: number;
  audioBitrate: number;
  /** Pre-negotiated codecs from `assertMediabunnyCapabilities`; when omitted the gate runs here. */
  negotiated?: NegotiatedExportCodecs;
  onProgress?: (progress: MediabunnyEncodeProgress) => void;
  signal?: AbortSignal;
  /** Stall watchdog per encode step; defaults to FRAME_STALL_TIMEOUT_MS. */
  frameStallTimeoutMs?: number;
}

/**
 * Stall watchdog for the encode loop (the canvas2d/ffmpeg path has one;
 * this path did not): if the encoder consumes no frame for this long,
 * the export is wedged — historically how "High" exports presented,
 * frozen at a percentage forever. 90s is far beyond any legitimate
 * single-frame encode, even 1080×1920 on a low-end phone.
 */
export const FRAME_STALL_TIMEOUT_MS = 90_000;

/** Races `work` against a stall timeout; rejects with MediabunnyExportError naming the stall. */
export async function withStallTimeout<T>(work: Promise<T>, timeoutMs: number, stalledMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new MediabunnyExportError(stalledMessage)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export interface EncodeFramesToMp4Result {
  blob: Blob;
  mimeType: string;
  durationSeconds: number;
  framesEncoded: number;
  metadata: RenderResultMetadata;
}

/**
 * Encodes `totalFrames` caller-drawn frames into an MP4 (H.264 + AAC or
 * Opus) in a single pass. The capability gate runs before the output is
 * created and before the first frame is drawn — a platform that can't
 * do this fails in milliseconds with the specific reason, not after a
 * render. Progress fires once per encoded frame with the true ratio.
 */
export async function encodeFramesToMp4(
  options: EncodeFramesToMp4Options,
): Promise<EncodeFramesToMp4Result> {
  const { canvas, width, height, frameRate, totalFrames } = options;
  if (totalFrames <= 0) {
    throw new MediabunnyExportError('Cannot export: the project has no frames to encode.');
  }
  const audioBuffer = options.audioBuffer ?? null;

  const settings: MediabunnyCapabilitySettings = {
    width,
    height,
    frameRate,
    videoBitrate: options.videoBitrate,
    audioSampleRate: audioBuffer?.sampleRate ?? 48_000,
    audioChannels: audioBuffer?.numberOfChannels ?? 2,
    audioBitrate: options.audioBitrate,
    requireAudio: audioBuffer !== null,
  };
  const negotiated = options.negotiated ?? (await assertMediabunnyCapabilities(settings));

  const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource } =
    await import('mediabunny');

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });

  let videoCodecString: string | undefined;
  let audioCodecString: string | undefined;
  const videoSource = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: options.videoBitrate,
    keyFrameInterval: 2,
    onEncoderConfig: (config) => {
      videoCodecString = config.codec;
    },
  });
  output.addVideoTrack(videoSource);

  let audioSource: InstanceType<typeof AudioBufferSource> | null = null;
  if (audioBuffer && negotiated.audioCodec) {
    audioSource = new AudioBufferSource({
      codec: negotiated.audioCodec,
      bitrate: options.audioBitrate,
      onEncoderConfig: (config) => {
        audioCodecString = config.codec;
      },
    });
    output.addAudioTrack(audioSource);
  }

  const frameDuration = 1 / frameRate;
  let framesEncoded = 0;
  try {
    await output.start();
    for (let frame = 0; frame < totalFrames; frame++) {
      if (options.signal?.aborted) {
        await output.cancel().catch(() => undefined);
        throw new RenderAbortedError();
      }
      const timeSeconds = frame / frameRate;
      await options.drawFrame(frame, timeSeconds);
      // Awaiting add() is the backpressure contract: the loop advances
      // only as fast as the encoder actually consumes frames, so the
      // progress ratio below is frames ENCODED, not frames drawn. The
      // stall watchdog bounds that wait: a wedged encoder fails the
      // export honestly instead of freezing the progress bar forever.
      await withStallTimeout(
        videoSource.add(timeSeconds, frameDuration),
        options.frameStallTimeoutMs ?? FRAME_STALL_TIMEOUT_MS,
        `The video encoder stalled — no frame encoded for ${Math.round((options.frameStallTimeoutMs ?? FRAME_STALL_TIMEOUT_MS) / 1000)} seconds — and the export was stopped. Please try again.`,
      );
      framesEncoded = frame + 1;
      options.onProgress?.({
        framesEncoded,
        totalFrames,
        ratio: framesEncoded / totalFrames,
      });
    }
    if (audioSource && audioBuffer) {
      await audioSource.add(audioBuffer);
    }
    await withStallTimeout(
      output.finalize(),
      (options.frameStallTimeoutMs ?? FRAME_STALL_TIMEOUT_MS) * 2,
      'Finishing the MP4 file stalled and the export was stopped. Please try again.',
    );
  } catch (err) {
    if (err instanceof RenderAbortedError || err instanceof MediabunnyCapabilityError) throw err;
    // Best-effort release of the encoder/muxer on any mid-encode failure.
    await output.cancel().catch(() => undefined);
    throw new MediabunnyExportError(
      `Mediabunny export failed during encoding: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const buffer = target.buffer;
  if (!buffer || buffer.byteLength === 0) {
    throw new MediabunnyExportError('Mediabunny export produced an empty file.');
  }
  const mimeType = await output.getMimeType().catch(() => 'video/mp4');
  const blob = new Blob([buffer], { type: mimeType });
  return {
    blob,
    mimeType,
    durationSeconds: totalFrames / frameRate,
    framesEncoded,
    metadata: {
      engine: 'mediabunny',
      videoCodec: negotiated.videoCodec,
      videoCodecString,
      audioCodec: audioSource ? negotiated.audioCodec : null,
      audioCodecString,
    },
  };
}

// ---------------------------------------------------------------------------
// Renderer implementation (the seam ExportPanel drives)
// ---------------------------------------------------------------------------

const AUDIO_MIX_SAMPLE_RATE = 48_000;
const SEEK_TIMEOUT_MS = 2_000;

/** Waits for a media element to finish a seek; resolves anyway after a timeout so one bad seek can't hang an export. */
function waitForSeek(element: HTMLVideoElement, timeoutMs = SEEK_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    if (element.readyState >= 2 && !element.seeking) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      clearTimeout(timer);
      element.removeEventListener('seeked', finish);
      resolve();
    }
    element.addEventListener('seeked', finish);
  });
}

interface AudioScheduleItem {
  startTime: number;
  endTime: number;
  trimStart: number;
  trimEnd: number;
  /** Playback-rate multiplier (video items); 1 for audio items. */
  speed: number;
  loop: boolean;
  volume: number;
  fade?: { fadeInDuration: number; fadeOutDuration: number };
}

/**
 * Pre-mixes every audible timeline item into ONE AudioBuffer with an
 * OfflineAudioContext — the same "pre-mix the timeline, encode it in
 * one add" shape the architecture study validated. Volume, fades
 * (sampled from the compositor's own `computeFadeOpacity`, so export
 * fades match the preview's), trim windows, video-item playback speed,
 * and audio-item looping all map to buffer-source scheduling here.
 *
 * Returns null when the project has no audible items at all (the export
 * then legitimately has no audio track). A dedicated audio item whose
 * file cannot be fetched/decoded fails the export honestly (mirroring
 * Canvas2DRenderer's required-media rule); a VIDEO item whose file has
 * no decodable audio stream is treated as a silent clip — a common,
 * legitimate shape — because its video track is unaffected.
 */
async function mixProjectAudioOffline(
  project: Project,
  totalSeconds: number,
): Promise<AudioBuffer | null> {
  const audible: { item: AudioScheduleItem; assetId: string; assetUrl: string; fileName: string; kind: 'audio' | 'video' }[] = [];
  for (const item of project.items) {
    if (item.type !== 'audio' && item.type !== 'video') continue;
    if (item.muted || item.volume <= 0) continue;
    const asset = project.mediaAssets[item.mediaAssetId];
    if (!asset) continue;
    if (item.type === 'audio') {
      audible.push({
        item: {
          startTime: item.startTime, endTime: item.endTime,
          trimStart: item.trimStart, trimEnd: item.trimEnd,
          speed: 1, loop: item.loop === true, volume: item.volume, fade: item.fade,
        },
        assetId: asset.id, assetUrl: asset.storageUrl, fileName: asset.fileName || asset.id, kind: 'audio',
      });
    } else {
      audible.push({
        item: {
          startTime: item.startTime, endTime: item.endTime,
          trimStart: item.trimStart, trimEnd: item.trimEnd,
          speed: item.speed || 1, loop: false, volume: item.volume, fade: item.fade,
        },
        assetId: asset.id, assetUrl: asset.storageUrl, fileName: asset.fileName || asset.id, kind: 'video',
      });
    }
  }
  if (audible.length === 0) return null;

  const offline = new OfflineAudioContext(
    2,
    Math.max(1, Math.ceil(totalSeconds * AUDIO_MIX_SAMPLE_RATE)),
    AUDIO_MIX_SAMPLE_RATE,
  );

  // Decode each distinct asset once.
  const decodedByAsset = new Map<string, AudioBuffer | null>();
  for (const entry of audible) {
    if (decodedByAsset.has(entry.assetId)) continue;
    let decoded: AudioBuffer | null = null;
    try {
      const response = await fetch(entry.assetUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      decoded = await offline.decodeAudioData(await response.arrayBuffer());
    } catch (err) {
      if (entry.kind === 'audio') {
        throw new Error(
          `Audio failed to load (${entry.fileName}) — export cancelled. Check your connection or file access, then try again.`,
        );
      }
      // Video asset with no decodable audio stream → silent clip.
      decoded = null;
    }
    decodedByAsset.set(entry.assetId, decoded);
  }

  let scheduledAny = false;
  for (const entry of audible) {
    const decoded = decodedByAsset.get(entry.assetId);
    if (!decoded) continue;
    const { item } = entry;
    const timelineDuration = Math.max(0, item.endTime - item.startTime);
    if (timelineDuration <= 0) continue;

    const gain = offline.createGain();
    // Fade/volume automation sampled from computeFadeOpacity at 33
    // points across the item — the same curve the preview applies.
    const SAMPLES = 32;
    const curve = new Float32Array(SAMPLES + 1);
    for (let i = 0; i <= SAMPLES; i++) {
      const elapsed = (timelineDuration * i) / SAMPLES;
      curve[i] = item.volume * computeFadeOpacity(item.fade, elapsed, timelineDuration - elapsed);
    }
    gain.gain.setValueCurveAtTime(curve, item.startTime, timelineDuration);
    gain.connect(offline.destination);

    const scheduleSegment = (when: number, offset: number, sourceDuration: number) => {
      if (sourceDuration <= 0) return;
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.playbackRate.value = item.speed;
      source.connect(gain);
      source.start(when, offset, sourceDuration);
    };

    if (item.loop) {
      // Wrap inside the trim window (computeLoopedSourceTime semantics):
      // schedule consecutive trim-window passes until the item's span
      // is filled.
      const span = item.trimEnd - item.trimStart;
      if (span > 0) {
        let elapsed = 0;
        while (elapsed < timelineDuration) {
          const segment = Math.min(span, timelineDuration - elapsed);
          scheduleSegment(item.startTime + elapsed, item.trimStart, segment);
          elapsed += segment;
        }
      }
    } else {
      // Source seconds consumed = timeline span × speed, clamped to the
      // trim window and to the decoded file itself.
      const wanted = timelineDuration * item.speed;
      const available = Math.min(item.trimEnd - item.trimStart, decoded.duration - item.trimStart);
      scheduleSegment(item.startTime, item.trimStart, Math.min(wanted, Math.max(0, available)));
    }
    scheduledAny = true;
  }

  if (!scheduledAny) return null;
  return offline.startRendering();
}

export class MediabunnyRenderer implements Renderer {
  readonly name = 'mediabunny';

  async render(project: Project, options: RenderOptions = {}): Promise<RenderResult> {
    const totalSeconds = getProjectDuration(project);
    if (totalSeconds <= 0) {
      throw new Error('This project has no timeline items to export.');
    }

    const outputWidth = options.output?.width ?? project.canvasWidth;
    const outputHeight = options.output?.height ?? project.canvasHeight;
    const frameRate = options.output?.frameRate ?? project.frameRate;
    const videoBitrate = options.output?.videoBitsPerSecond ?? 8_000_000;
    const audioBitrate = options.output?.audioBitsPerSecond ?? 192_000;
    const totalFrames = Math.max(1, Math.round(totalSeconds * frameRate));

    // Which items could carry audio decides whether the capability gate
    // requires an audio codec — determined from the timeline alone,
    // before anything is fetched, decoded, or drawn.
    const hasAudibleItems = project.items.some(
      (item) =>
        (item.type === 'audio' || item.type === 'video') && !item.muted && item.volume > 0,
    );

    // PRE-FLIGHT GATE — before any media load or frame work. A platform
    // that can't run this engine fails here, in milliseconds, with the
    // specific missing capability. There is no fallback from this point.
    const negotiated = await assertMediabunnyCapabilities({
      width: outputWidth,
      height: outputHeight,
      frameRate,
      videoBitrate,
      audioSampleRate: AUDIO_MIX_SAMPLE_RATE,
      audioChannels: 2,
      audioBitrate,
      requireAudio: hasAudibleItems,
    });

    const canvas = document.createElement('canvas');
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser could not create a 2D rendering context for export.');
    if (outputWidth !== project.canvasWidth || outputHeight !== project.canvasHeight) {
      ctx.setTransform(outputWidth / project.canvasWidth, 0, 0, outputHeight / project.canvasHeight, 0, 0);
    }

    // Media elements, attached off-screen exactly as in
    // Canvas2DRenderer (a detached <video> can sit at readyState 0
    // forever in some browser configurations).
    const videoEls = new Map<string, HTMLVideoElement>();
    const imageEls = new Map<string, HTMLImageElement>();
    const attachOffscreen = (el: HTMLVideoElement) => {
      el.style.position = 'fixed';
      el.style.width = '1px';
      el.style.height = '1px';
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
      el.tabIndex = -1;
      document.body.appendChild(el);
    };
    const getVideoEl = (assetId: string, storageUrl: string): HTMLVideoElement => {
      let el = videoEls.get(assetId);
      if (!el) {
        el = document.createElement('video');
        el.crossOrigin = 'anonymous';
        el.preload = 'auto';
        el.playsInline = true;
        el.muted = true; // the element is a frame source only — audio comes from the offline mix
        attachOffscreen(el);
        el.src = storageUrl;
        videoEls.set(assetId, el);
      }
      return el;
    };
    const getImageEl = (assetId: string, storageUrl: string): HTMLImageElement => {
      let el = imageEls.get(assetId);
      if (!el) {
        el = new Image();
        el.crossOrigin = 'anonymous';
        el.src = storageUrl;
        imageEls.set(assetId, el);
      }
      return el;
    };
    const cleanup = () => {
      videoEls.forEach((el) => {
        el.pause();
        el.src = '';
        if (el.parentNode) el.parentNode.removeChild(el);
      });
      videoEls.clear();
      imageEls.clear();
    };

    try {
      // Preload video metadata + images up front; a video that fails to
      // load aborts the export with the same honest error the existing
      // pipeline uses (required media), never a black silent output.
      const failedMedia: string[] = [];
      await Promise.all(
        project.items.map((item) => {
          if (item.type === 'video') {
            const asset = project.mediaAssets[item.mediaAssetId];
            if (!asset) return Promise.resolve();
            const el = getVideoEl(asset.id, asset.storageUrl);
            return new Promise<void>((resolve) => {
              const fail = () => {
                failedMedia.push(asset.fileName || asset.id);
                resolve();
              };
              if (el.error) return fail();
              if (el.readyState >= 1) return resolve();
              el.addEventListener('loadedmetadata', () => resolve(), { once: true });
              el.addEventListener('error', fail, { once: true });
            });
          }
          if (item.type === 'image') {
            const asset = project.mediaAssets[item.mediaAssetId];
            if (!asset) return Promise.resolve();
            const el = getImageEl(asset.id, asset.storageUrl);
            return new Promise<void>((resolve) => {
              if (el.complete) return resolve();
              el.addEventListener('load', () => resolve(), { once: true });
              el.addEventListener('error', () => resolve(), { once: true });
            });
          }
          return Promise.resolve();
        }),
      );
      if (failedMedia.length > 0) {
        throw new Error(
          `Media failed to load (${failedMedia.join(', ')}) — export cancelled. Check your connection or file access, then try again.`,
        );
      }

      // Offline audio pre-mix (throws honestly on a failed audio asset).
      const audioBuffer = await mixProjectAudioOffline(project, totalSeconds);

      // Per-frame video sync: deterministic seeks, mirroring
      // Canvas2DRenderer's target-time formula (trim + elapsed × speed),
      // then the shared compositor draws the frame.
      const drawFrameForExport = async (_frameIndex: number, t: number) => {
        const activeItems: TimelineItem[] = getItemsAtTime(project, t);
        const videosMap = new Map<string, HTMLVideoElement>();
        let frameActiveVideo: { assetId: string; element: HTMLVideoElement } | undefined;
        for (const item of activeItems) {
          if (item.type !== 'video') continue;
          const asset = project.mediaAssets[item.mediaAssetId];
          if (!asset) continue;
          const el = getVideoEl(asset.id, asset.storageUrl);
          const targetTime = item.trimStart + Math.max(0, t - item.startTime) * (item.speed || 1);
          if (Math.abs(el.currentTime - targetTime) > 1 / frameRate / 2) {
            try {
              el.currentTime = targetTime;
            } catch {
              /* not seekable yet — draw whatever frame is current */
            }
            await waitForSeek(el);
          }
          videosMap.set(asset.id, el);
          if (!frameActiveVideo) frameActiveVideo = { assetId: asset.id, element: el };
        }
        drawFrame(ctx, project, t, { images: imageEls, activeVideo: frameActiveVideo, videos: videosMap });
      };

      const encoded = await encodeFramesToMp4({
        canvas,
        width: outputWidth,
        height: outputHeight,
        frameRate,
        totalFrames,
        drawFrame: drawFrameForExport,
        audioBuffer,
        videoBitrate,
        audioBitrate,
        negotiated,
        onProgress: ({ ratio, framesEncoded }) => {
          options.onProgress?.({
            fraction: ratio,
            renderedSeconds: framesEncoded / frameRate,
            totalSeconds,
          });
        },
        signal: options.signal,
      });

      return {
        blob: encoded.blob,
        mimeType: encoded.mimeType,
        durationSeconds: totalSeconds,
        metadata: encoded.metadata,
      };
    } finally {
      cleanup();
    }
  }
}
