/**
 * FINAL FIX Part 2 — the WebCodecs capture engine. Built as a
 * device-proof prototype beside MediaRecorder, it PASSED its
 * on-device proof on the owner's S25 Ultra (2026-11-11: both
 * cameras, zero queue drops, zero fallbacks, audio included) and
 * was promoted to the engine of record: where the capability gate
 * below passes, it is now the DEFAULT capture engine, with the
 * standard engine (MediaRecorder) still selectable and still the
 * automatic fallback.
 *
 * The research verdict (see
 * ~/workspace/research_notes/android-chrome-smooth-camera-final-fix-20261109-2255/report.md):
 * MediaRecorder's variable frame timing is by design — Chromium's
 * recorder drops frames when encoding lags and muxes whatever
 * arrives with capture timestamps, so no setting makes it CFR.
 * The only in-browser architecture that owns timestamps is
 * MediaStreamTrackProcessor → VideoEncoder → an app-driven muxer.
 * This module is that pipeline:
 *
 * - Same negotiated stream (the ladder / ceiling / flip machinery
 *   is untouched — only the recording leg differs).
 * - Frames are read in a dedicated worker (a busy main thread must
 *   never cost the footage a frame), encoded with VideoEncoder
 *   (hardware preferred, software fallback, latencyMode 'quality'),
 *   gated on encodeQueueSize with COUNTED drops — never silent.
 * - The worker's muxer (Mediabunny) stamps every packet onto the
 *   granted-fps grid: the file is CFR BY CONSTRUCTION, and grid
 *   slots the pipeline missed are filled with a repeat of the
 *   previous frame and counted.
 * - Audio is encoded in the same worker (AAC) and anchored to the
 *   first video frame's clock, so a new-engine take carries its
 *   sound in sync. When the platform declines the audio encode,
 *   the take is video-only and the telemetry SAYS so — the receipt
 *   and the diagnostics pack disclose it, never hide it.
 *
 * The adapter below is deliberately MediaRecorder-shaped (mimeType,
 * bitrate fields, ondataavailable / onstop / onerror, start / stop)
 * so the single-camera record path — normal takes, the camera
 * test and diagnostics alike — can swap engines without its stop
 * handling changing at all. Dual and two-pass step-2 recording are
 * NOT on this engine (they keep their own MediaRecorder paths).
 *
 * Capability gate first: nothing here is offered unless the
 * platform pieces exist and an encoder config probes supported —
 * where the gate fails, the standard engine is used and the
 * settings sheet says why in plain words. If the engine fails to
 * START or errors MID-TAKE, the component falls back to
 * MediaRecorder for the take and the receipt discloses it — a
 * take is never lost to the new engine.
 *
 * $0 rule: WebCodecs + Mediabunny (already a dependency). No new
 * dependencies; the worker is bundled by the existing toolchain.
 */

import { buildAvcEncoderCodecString } from '../export/mediabunnyExporter';

/* ------------------------------------------------------------------ */
/* Engine choice + persistence                                         */
/* ------------------------------------------------------------------ */

export type CaptureEngineKind = 'standard' | 'webcodecs';

export const CAPTURE_ENGINE_STORAGE_KEY = 'riddimroom.camera.captureEngine.v1';

/** The minimal storage slice the choice needs (structurally `localStorage`). */
export interface CaptureEngineStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function serializeCaptureEngineChoice(kind: CaptureEngineKind): string {
  return kind === 'webcodecs' ? 'webcodecs' : 'standard';
}

/**
 * Parse a stored choice. The stored value is only ever written by
 * an explicit pick in the settings sheet, so a stored 'standard'
 * is a deliberate choice and is honoured as-is. Anything else —
 * absent, unrecognised — means no explicit choice exists, and the
 * DEFAULT applies: the new engine (promoted 2026-11-11 after its
 * on-device proof). The capability gate still decides at take
 * time whether the new engine can actually run on this browser;
 * where it cannot, the standard engine records.
 */
export function parseCaptureEngineChoice(raw: string | null | undefined): CaptureEngineKind {
  return raw === 'standard' ? 'standard' : 'webcodecs';
}

export function loadCaptureEngineChoice(storage: CaptureEngineStorage | null | undefined): CaptureEngineKind {
  try {
    return parseCaptureEngineChoice(storage?.getItem(CAPTURE_ENGINE_STORAGE_KEY));
  } catch {
    return parseCaptureEngineChoice(null);
  }
}

export function saveCaptureEngineChoice(
  storage: CaptureEngineStorage | null | undefined,
  kind: CaptureEngineKind,
): void {
  try {
    storage?.setItem(CAPTURE_ENGINE_STORAGE_KEY, serializeCaptureEngineChoice(kind));
  } catch {
    // A storage refusal costs the persistence, never the choice.
  }
}

/* ------------------------------------------------------------------ */
/* Telemetry                                                           */
/* ------------------------------------------------------------------ */

/**
 * The new engine's own count of one take. Every number was
 * actually counted by the pipeline — a frame the queue gate dropped
 * is here, a grid slot the muxer filled is here. These counts land
 * in the capture receipt and the diagnostics pack, so the device
 * proof is measured from the engine's own ledger, not impressions.
 */
export interface CaptureEngineTelemetry {
  /** Video frames the track processor handed the worker. */
  framesReceived: number;
  /** Frames actually submitted to the encoder. */
  framesEncoded: number;
  /** Frames deliberately dropped because the encoder queue was full (counted, never silent). */
  framesDroppedByQueue: number;
  /** Grid slots filled by repeating the previous frame at the muxer. */
  framesFilled: number;
  /** False when the platform declined the audio encode and the take is video-only (disclosed). */
  audioIncluded: boolean;
  /** The AVC codec string the encoder actually configured with ('' when unknown). */
  encoderCodec: string;
}

export function emptyCaptureEngineTelemetry(): CaptureEngineTelemetry {
  return {
    framesReceived: 0,
    framesEncoded: 0,
    framesDroppedByQueue: 0,
    framesFilled: 0,
    audioIncluded: false,
    encoderCodec: '',
  };
}

/* ------------------------------------------------------------------ */
/* The CFR grid (pure)                                                 */
/* ------------------------------------------------------------------ */

/**
 * Deliberate-drop threshold: when more than this many frames are
 * already waiting in the encoder, the incoming frame is dropped
 * (and counted) rather than letting latency snowball — the same
 * gate Google's own WebCodecs capture sample applies.
 */
export const WEBCAPTURE_MAX_ENCODE_QUEUE = 2;

export function shouldDropFrameForQueue(encodeQueueSize: number): boolean {
  return typeof encodeQueueSize === 'number' && encodeQueueSize > WEBCAPTURE_MAX_ENCODE_QUEUE;
}

/** One grid slot's duration in microseconds at `fps`. */
export function frameDurationUs(fps: number): number {
  const safe = typeof fps === 'number' && Number.isFinite(fps) && fps > 0 ? fps : 30;
  return 1_000_000 / safe;
}

/** The grid slot a capture timestamp (µs, same clock as `t0Us`) belongs to. */
export function slotForTimestampUs(timestampUs: number, t0Us: number, fps: number): number {
  const rel = timestampUs - t0Us;
  if (!Number.isFinite(rel) || rel <= 0) return 0;
  return Math.round(rel / frameDurationUs(fps));
}

/**
 * The muxer's slot ledger: feed it each encoded packet's capture
 * timestamp (µs) in the order packets are muxed; it answers the
 * grid slot the packet must be stamped at and how many slots before
 * it stand empty (to be filled by repeating the previous packet).
 * The first timestamp seen anchors the grid (slot 0). A late
 * out-of-order packet (a smaller slot than already stamped) is
 * stamped at its own slot and never rewinds the ledger.
 */
export class CfrSlotStamper {
  private t0Us: number | null = null;
  private nextSlot = 0;
  private readonly fps: number;

  constructor(fps: number) {
    this.fps = typeof fps === 'number' && Number.isFinite(fps) && fps > 0 ? fps : 30;
  }

  /** The grid anchor (first timestamp seen), or null before any packet. */
  get anchorUs(): number | null {
    return this.t0Us;
  }

  stampFor(timestampUs: number): { slot: number; fillsBefore: number } {
    if (this.t0Us === null) {
      this.t0Us = timestampUs;
      this.nextSlot = 1;
      return { slot: 0, fillsBefore: 0 };
    }
    const slot = slotForTimestampUs(timestampUs, this.t0Us, this.fps);
    if (slot < this.nextSlot) return { slot, fillsBefore: 0 };
    const fillsBefore = slot - this.nextSlot;
    this.nextSlot = slot + 1;
    return { slot, fillsBefore };
  }

  /** The stamp (seconds) and duration (seconds) for a grid slot. */
  slotTiming(slot: number): { timestampSec: number; durationSec: number } {
    const dur = 1 / this.fps;
    return { timestampSec: slot * dur, durationSec: dur };
  }
}

/* ------------------------------------------------------------------ */
/* Encoder configs (pure builders)                                     */
/* ------------------------------------------------------------------ */

/**
 * VideoEncoder config candidates for one take, in try-order:
 * hardware first, then no-preference, then software (Chromium's
 * 'prefer-hardware' never falls back by itself, so the ladder is
 * explicit — the Sendou.ink production pattern). The codec string
 * is the same one the export engine computes, so the probe asks
 * about exactly what the runtime will configure.
 */
export function buildWebcodecsVideoConfigCandidates(input: {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}): VideoEncoderConfig[] {
  const width = Math.max(2, Math.round(input.width) || 0);
  const height = Math.max(2, Math.round(input.height) || 0);
  const fps = typeof input.fps === 'number' && Number.isFinite(input.fps) && input.fps > 0 ? input.fps : 30;
  const bitrate =
    typeof input.bitrate === 'number' && Number.isFinite(input.bitrate) && input.bitrate > 0
      ? Math.round(input.bitrate)
      : 12_000_000;
  const codec = buildAvcEncoderCodecString(width, height, bitrate);
  const accelerations: HardwareAcceleration[] = ['prefer-hardware', 'no-preference', 'prefer-software'];
  return accelerations.map((hardwareAcceleration) => ({
    codec,
    width,
    height,
    bitrate,
    bitrateMode: 'variable',
    framerate: fps,
    hardwareAcceleration,
    latencyMode: 'quality',
    avc: { format: 'avc' },
  }));
}

/** The AAC audio config for the take's mic track (matches the standard engine's 192 kbps audio tier). */
export function buildWebcodecsAudioConfig(input: {
  sampleRate?: number;
  channelCount?: number;
  bitrate?: number;
}): AudioEncoderConfig {
  const sampleRate =
    typeof input.sampleRate === 'number' && Number.isFinite(input.sampleRate) && input.sampleRate >= 8_000
      ? Math.round(input.sampleRate)
      : 48_000;
  const channelCount =
    typeof input.channelCount === 'number' && (input.channelCount === 1 || input.channelCount === 2)
      ? input.channelCount
      : 2;
  const bitrate =
    typeof input.bitrate === 'number' && Number.isFinite(input.bitrate) && input.bitrate > 0
      ? Math.round(input.bitrate)
      : 192_000;
  // The `aac` member is the WebCodecs AAC registration extension —
  // real and required for raw-AAC output, but not yet in TS's DOM
  // lib; the cast carries it without weakening anything else.
  return {
    codec: 'mp4a.40.2',
    sampleRate,
    numberOfChannels: channelCount,
    bitrate,
    aac: { format: 'aac' },
  } as AudioEncoderConfig;
}

/* ------------------------------------------------------------------ */
/* Capability probe                                                    */
/* ------------------------------------------------------------------ */

export interface WebcodecsProbeDeps {
  hasTrackProcessor: () => boolean;
  hasVideoEncoder: () => boolean;
  isConfigSupported: (config: VideoEncoderConfig) => Promise<{ supported: boolean }>;
}

export interface WebcodecsProbeResult {
  supported: boolean;
  /** Internal reason code when unsupported ('track-processor' | 'encoder' | 'config'); null when supported. */
  reason: string | null;
  /** The first candidate config the platform accepted, when supported. */
  config: VideoEncoderConfig | null;
}

/**
 * The capability gate, pure over injected platform seams: the
 * track processor and the encoder must exist, and at least one
 * config candidate must probe supported for the take's actual
 * dimensions. Anything else and the new engine is not offered.
 */
export async function probeWebcodecsCaptureWith(
  deps: WebcodecsProbeDeps,
  dims: { width: number; height: number; fps: number; bitrate: number },
): Promise<WebcodecsProbeResult> {
  if (!deps.hasTrackProcessor()) return { supported: false, reason: 'track-processor', config: null };
  if (!deps.hasVideoEncoder()) return { supported: false, reason: 'encoder', config: null };
  const candidates = buildWebcodecsVideoConfigCandidates(dims);
  for (const config of candidates) {
    try {
      const result = await deps.isConfigSupported(config);
      if (result?.supported) return { supported: true, reason: null, config };
    } catch {
      // A throwing probe is a declined config, not a verdict on the next one.
    }
  }
  return { supported: false, reason: 'config', config: null };
}

/** The structural slice of MediaStreamTrackProcessor the adapter uses (not in TS's DOM lib). */
export interface TrackProcessorLike {
  readable: ReadableStream<unknown>;
}

type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => TrackProcessorLike;

function platformTrackProcessorCtor(): TrackProcessorCtor | null {
  const ctor = (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor;
  return typeof ctor === 'function' ? (ctor as TrackProcessorCtor) : null;
}

function platformHasVideoEncoder(): boolean {
  return typeof (globalThis as { VideoEncoder?: unknown }).VideoEncoder === 'function';
}

/** The platform-backed probe (what the settings sheet runs). */
export async function probeWebcodecsCapture(dims: {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}): Promise<WebcodecsProbeResult> {
  const encoderCtor = (globalThis as { VideoEncoder?: typeof VideoEncoder }).VideoEncoder;
  return probeWebcodecsCaptureWith(
    {
      hasTrackProcessor: () => platformTrackProcessorCtor() !== null,
      hasVideoEncoder: () => platformHasVideoEncoder(),
      isConfigSupported: async (config) => {
        if (!encoderCtor) return { supported: false };
        const result = await encoderCtor.isConfigSupported(config);
        return { supported: !!result?.supported };
      },
    },
    dims,
  );
}

/* ------------------------------------------------------------------ */
/* Worker protocol                                                     */
/* ------------------------------------------------------------------ */

export interface WebcodecsStartMessage {
  type: 'start';
  videoStream: ReadableStream<unknown>;
  audioStream: ReadableStream<unknown> | null;
  videoConfigs: VideoEncoderConfig[];
  audioConfig: AudioEncoderConfig | null;
  targetFps: number;
  fileName: string;
}

export interface WebcodecsStopMessage {
  type: 'stop';
}

export type WebcodecsWorkerInMessage = WebcodecsStartMessage | WebcodecsStopMessage;

export type WebcodecsWorkerOutMessage =
  | { type: 'ready'; audioIncluded: boolean }
  | { type: 'error'; message: string }
  | { type: 'finished'; telemetry: CaptureEngineTelemetry; fileName: string };

/** The structural slice of a Worker the adapter drives. */
export interface WebcodecsWorkerLike {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  addEventListener: (type: 'message' | 'error', listener: (event: { data?: unknown }) => void) => void;
  removeEventListener: (type: 'message' | 'error', listener: (event: { data?: unknown }) => void) => void;
  terminate: () => void;
}

/* ------------------------------------------------------------------ */
/* The take recorder (MediaRecorder-shaped adapter)                    */
/* ------------------------------------------------------------------ */

export interface WebcodecsTakeRecorderDeps {
  /** Create the pipeline worker (the production default builds the bundled worker). */
  createWorker: () => WebcodecsWorkerLike;
  /** Create a track processor for one track (the production default uses the platform's). */
  createTrackProcessor: (track: MediaStreamTrack) => TrackProcessorLike;
  /** Read the worker's finished OPFS file back as a Blob (null when it cannot be read). */
  collectOutputFile: (fileName: string) => Promise<Blob | null>;
}

const WEBCAPTURE_OPFS_PREFIX = 'riddimroom-webcap-';

function defaultCreateWorker(): WebcodecsWorkerLike {
  return new Worker(new URL('./webcodecsCapture.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WebcodecsWorkerLike;
}

function defaultCreateTrackProcessor(track: MediaStreamTrack): TrackProcessorLike {
  const ctor = platformTrackProcessorCtor();
  if (!ctor) throw new Error('MediaStreamTrackProcessor unavailable');
  return new ctor({ track });
}

async function defaultCollectOutputFile(fileName: string): Promise<Blob | null> {
  try {
    const storage = (globalThis as { navigator?: Navigator }).navigator?.storage as
      | (StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> })
      | undefined;
    if (!storage?.getDirectory) return null;
    const root = await storage.getDirectory();
    const handle = await root.getFileHandle(fileName);
    const file = (await handle.getFile()) as Blob;
    try {
      await root.removeEntry(fileName);
    } catch {
      // The file was read; a leftover temp is swept by the next take.
    }
    return file;
  } catch {
    return null;
  }
}

const defaultRecorderDeps: WebcodecsTakeRecorderDeps = {
  createWorker: defaultCreateWorker,
  createTrackProcessor: defaultCreateTrackProcessor,
  collectOutputFile: defaultCollectOutputFile,
};

export interface WebcodecsTakeOptions {
  /** The take's granted frame rate — the CFR grid's rate. */
  targetFps: number;
  videoBitrate: number;
  audioBitrate: number;
  /** Fired with the engine's ledger just before the take's data is delivered. */
  onTelemetry?: (telemetry: CaptureEngineTelemetry) => void;
}

/**
 * One new-engine take, shaped exactly like the MediaRecorder
 * the single-camera path already drives: assign ondataavailable /
 * onstop / onerror, call start(), later stop(). The finished file
 * is delivered as ONE data event (the worker muxes the whole take),
 * then onstop. Any worker/encoder failure fires onerror exactly
 * once — the component's fallback takes the take from there.
 */
export class WebcodecsTakeRecorder {
  readonly mimeType = 'video/mp4';
  readonly videoBitsPerSecond: number;
  readonly audioBitsPerSecond: number;

  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  private readonly stream: MediaStream;
  private readonly options: WebcodecsTakeOptions;
  private readonly deps: WebcodecsTakeRecorderDeps;
  private worker: WebcodecsWorkerLike | null = null;
  private started = false;
  private stopSent = false;
  private settled = false;

  constructor(stream: MediaStream, options: WebcodecsTakeOptions, deps: WebcodecsTakeRecorderDeps = defaultRecorderDeps) {
    this.stream = stream;
    this.options = options;
    this.deps = deps;
    this.videoBitsPerSecond = Math.round(options.videoBitrate) || 0;
    this.audioBitsPerSecond = Math.round(options.audioBitrate) || 0;
  }

  /**
   * Start the take. The `timeslice` parameter exists for exact
   * MediaRecorder parity at the call site (the record paths all
   * start with 250) and is deliberately ignored: this engine's one
   * data event is the worker's whole finished file, never slices.
   */
  start(_timeslice?: number): void {
    void _timeslice;
    if (this.started) return;
    this.started = true;
    try {
      const videoTrack = this.stream.getVideoTracks()[0];
      if (!videoTrack) throw new Error('no video track');
      const videoSettings = (videoTrack.getSettings?.() ?? {}) as {
        width?: number;
        height?: number;
        frameRate?: number;
      };
      const width = videoSettings.width ?? 0;
      const height = videoSettings.height ?? 0;
      if (!(width > 0 && height > 0)) throw new Error('video track has no size yet');
      const videoProcessor = this.deps.createTrackProcessor(videoTrack);
      const audioTrack = this.stream.getAudioTracks()[0] ?? null;
      let audioProcessor: TrackProcessorLike | null = null;
      let audioConfig: AudioEncoderConfig | null = null;
      if (audioTrack) {
        try {
          audioProcessor = this.deps.createTrackProcessor(audioTrack);
          const audioSettings = (audioTrack.getSettings?.() ?? {}) as {
            sampleRate?: number;
            channelCount?: number;
          };
          audioConfig = buildWebcodecsAudioConfig({
            sampleRate: audioSettings.sampleRate,
            channelCount: audioSettings.channelCount,
            bitrate: this.options.audioBitrate,
          });
        } catch {
          audioProcessor = null;
          audioConfig = null;
        }
      }
      const worker = this.deps.createWorker();
      this.worker = worker;
      worker.addEventListener('message', this.handleWorkerMessage);
      worker.addEventListener('error', this.handleWorkerError);
      const startMessage: WebcodecsStartMessage = {
        type: 'start',
        videoStream: videoProcessor.readable,
        audioStream: audioProcessor ? audioProcessor.readable : null,
        videoConfigs: buildWebcodecsVideoConfigCandidates({
          width,
          height,
          fps: this.options.targetFps,
          bitrate: this.options.videoBitrate,
        }),
        audioConfig,
        targetFps: this.options.targetFps,
        fileName: `${WEBCAPTURE_OPFS_PREFIX}${Date.now()}-${Math.floor(Math.random() * 1e9)}.mp4`,
      };
      const transfer: Transferable[] = [startMessage.videoStream as unknown as Transferable];
      if (startMessage.audioStream) transfer.push(startMessage.audioStream as unknown as Transferable);
      worker.postMessage(startMessage, transfer);
    } catch (err) {
      this.fail(err);
    }
  }

  stop(): void {
    if (!this.started || this.settled || this.stopSent) return;
    this.stopSent = true;
    try {
      this.worker?.postMessage({ type: 'stop' } satisfies WebcodecsStopMessage);
    } catch {
      this.fail(new Error('could not reach the capture worker'));
    }
  }

  /** Terminate the worker and silence every event (the take has been taken over by the fallback). */
  dispose(): void {
    this.settled = true;
    this.teardownWorker();
  }

  private readonly handleWorkerError = (): void => {
    this.fail(new Error('the capture worker failed'));
  };

  private readonly handleWorkerMessage = (event: { data?: unknown }): void => {
    const message = event.data as WebcodecsWorkerOutMessage | undefined;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'error') {
      this.fail(new Error(message.message || 'the capture engine failed'));
      return;
    }
    if (message.type === 'finished') {
      if (this.settled) return;
      this.settled = true;
      const { telemetry, fileName } = message;
      try {
        this.options.onTelemetry?.(telemetry);
      } catch {
        // Telemetry is evidence, never a reason to lose the take.
      }
      void (async () => {
        const file = await this.deps.collectOutputFile(fileName);
        this.teardownWorker();
        if (file && file.size > 0) {
          const blob = file.type === this.mimeType ? file : new Blob([file], { type: this.mimeType });
          // A real BlobEvent where the platform has one (every
          // browser does); the structural stand-in only serves
          // non-DOM runtimes — the handler reads `.data` either way.
          const event =
            typeof BlobEvent !== 'undefined'
              ? new BlobEvent('dataavailable', { data: blob })
              : ({ type: 'dataavailable', data: blob } as unknown as BlobEvent);
          this.ondataavailable?.(event);
        }
        this.onstop?.();
      })();
    }
    // 'ready' needs no main-thread action — recording is under way.
  };

  private fail(err: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.teardownWorker();
    const event = new Event('error') as Event & { error?: unknown };
    event.error = err;
    // Async, like the platform's own error events: the component
    // wires its handlers before start() returns, and a synchronous
    // throw-path must not fire before they exist.
    queueMicrotask(() => {
      this.onerror?.(event);
    });
  }

  private teardownWorker(): void {
    if (!this.worker) return;
    try {
      this.worker.removeEventListener('message', this.handleWorkerMessage);
      this.worker.removeEventListener('error', this.handleWorkerError);
    } catch {
      // Detach is best-effort; terminate below is the guarantee.
    }
    try {
      this.worker.terminate();
    } catch {
      // Already gone.
    }
    this.worker = null;
  }
}

/**
 * Create one new-engine take recorder for `stream`, or null when the
 * platform pieces the engine needs are not all here (no track
 * processor, no encoder, no worker) — the caller then uses the
 * standard engine without the user ever seeing a broken option.
 * Encoder-config support is proven inside the worker at start; a
 * refusal there arrives as the recorder's error event.
 */
export function createWebcodecsTakeRecorder(
  stream: MediaStream,
  options: WebcodecsTakeOptions,
  deps: WebcodecsTakeRecorderDeps = defaultRecorderDeps,
): WebcodecsTakeRecorder | null {
  try {
    if (typeof Worker === 'undefined') return null;
    if (!platformTrackProcessorCtor()) return null;
    if (!platformHasVideoEncoder()) return null;
    if (!stream?.getVideoTracks?.()[0]) return null;
    return new WebcodecsTakeRecorder(stream, options, deps);
  } catch {
    return null;
  }
}
