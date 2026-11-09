/**
 * FINAL FIX Part 2 — the WebCodecs capture worker.
 *
 * Everything time-critical lives here, off the main thread: read
 * frames from the track processors, encode them, and mux the take
 * to an OPFS file with timestamps the APP assigns on the granted-fps
 * grid — the saved file is CFR by construction, and every drop and
 * fill is counted in the telemetry posted back at the end.
 *
 * Pipeline:
 *   video: MediaStreamTrackProcessor.readable (transferred in)
 *          → VideoEncoder (config ladder: hardware → any →
 *            software; latencyMode 'quality') with encodeQueueSize
 *            gating — a frame that finds the queue full is dropped
 *            and COUNTED, never silently.
 *          → chunks stamped via the CfrSlotStamper; a grid slot the
 *            pipeline missed is filled by repeating the previous
 *            packet (counted), so the file's cadence never slips.
 *   audio: MediaStreamTrackProcessor.readable (when the mic track
 *          processed) → AudioEncoder (AAC) → packets re-based onto
 *          the FIRST VIDEO FRAME's clock, so sound and picture
 *          share one origin. If the platform declines the audio
 *          encode, the take continues video-only and the telemetry
 *          discloses it (audioIncluded: false).
 *   mux:   Mediabunny Output → MP4 → StreamTarget over an OPFS
 *          writable; every source.add() is serialised on one
 *          promise chain, which is also the mux backpressure.
 *
 * Failure contract: any error posts exactly one { type: 'error' }
 * and the main thread falls the take back to MediaRecorder — the
 * worker never retries silently and never loses a take on its own.
 */

import {
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
} from 'mediabunny';
import {
  CfrSlotStamper,
  emptyCaptureEngineTelemetry,
  shouldDropFrameForQueue,
  type CaptureEngineTelemetry,
  type WebcodecsStartMessage,
  type WebcodecsWorkerOutMessage,
} from './webcodecsCapture';

/* The worker-global surface this file uses (TS compiles with the DOM lib). */
interface CaptureWorkerScope {
  postMessage: (message: WebcodecsWorkerOutMessage) => void;
  addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
}
const scope = self as unknown as CaptureWorkerScope;

const OPFS_PREFIX = 'riddimroom-webcap-';

let failurePosted = false;
let finishPosted = false;
let stopRequested = false;
let finishTake: (() => Promise<void>) | null = null;

function post(message: WebcodecsWorkerOutMessage): void {
  try {
    scope.postMessage(message);
  } catch {
    // The main thread is gone; nothing left to tell.
  }
}

function fail(err: unknown): void {
  if (failurePosted || finishPosted) return;
  failurePosted = true;
  const message = err instanceof Error ? err.message : 'the capture engine failed';
  post({ type: 'error', message });
}

scope.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string } | undefined;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'start') {
    void run(data as WebcodecsStartMessage).catch(fail);
  } else if (data.type === 'stop') {
    stopRequested = true;
    if (finishTake) void finishTake().catch(fail);
    // When stop lands before the pipeline exists, run() sees
    // stopRequested the moment it finishes starting and finishes.
  }
});

async function run(start: WebcodecsStartMessage): Promise<void> {
  const telemetry: CaptureEngineTelemetry = emptyCaptureEngineTelemetry();
  const fps = start.targetFps;
  const stamper = new CfrSlotStamper(fps);

  /* --- Shared mux state (declared before any encoder exists) --- */
  let muxChain: Promise<void> = Promise.resolve();
  const chainMux = (step: () => Promise<void>): void => {
    muxChain = muxChain.then(step).catch((err) => fail(err));
  };
  let lastVideoPacket: EncodedPacket | null = null;
  let videoMetaSent = false;
  // Infinity so the very first frame is forced as a keyframe.
  let framesSinceKey = Number.POSITIVE_INFINITY;

  /* --- Audio re-basing state --- */
  let audioSource: EncodedAudioPacketSource | null = null;
  let audioMetaAttached = false;
  const pendingAudio: Array<{ packet: EncodedPacket; meta?: EncodedAudioChunkMetadata }> = [];
  const flushPendingAudio = async (useAudioAnchor = false): Promise<void> => {
    if (pendingAudio.length === 0 || !audioSource) return;
    const anchorUs = stamper.anchorUs;
    if (anchorUs === null && !useAudioAnchor) return; // wait for the video clock
    const anchorSec = (anchorUs ?? pendingAudio[0].packet.timestamp * 1_000_000) / 1_000_000;
    while (pendingAudio.length > 0) {
      const { packet, meta } = pendingAudio.shift()!;
      const rebased = packet.clone({ timestamp: Math.max(0, packet.timestamp - anchorSec) });
      if (!audioMetaAttached && meta) {
        await audioSource.add(rebased, meta);
        audioMetaAttached = true;
      } else {
        await audioSource.add(rebased);
      }
    }
  };

  /* --- OPFS output (sweep stale temp files from abandoned takes) --- */
  const storage = (globalThis as { navigator?: Navigator }).navigator?.storage as
    | (StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> })
    | undefined;
  if (!storage?.getDirectory) throw new Error('origin private file system unavailable');
  const root = await storage.getDirectory();
  try {
    const dir = root as FileSystemDirectoryHandle & { keys?: () => AsyncIterable<string> };
    if (typeof dir.keys === 'function') {
      for await (const name of dir.keys()) {
        if (name.startsWith(OPFS_PREFIX) && name !== start.fileName) {
          await root.removeEntry(name).catch(() => undefined);
        }
      }
    }
  } catch {
    // A failed sweep never blocks the take.
  }
  const fileHandle = await root.getFileHandle(start.fileName, { create: true });
  const writable = await fileHandle.createWritable();

  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new StreamTarget(writable as WritableStream),
  });
  const videoSource = new EncodedVideoPacketSource('avc');
  output.addVideoTrack(videoSource, { frameRate: fps });
  if (start.audioConfig && start.audioStream) {
    audioSource = new EncodedAudioPacketSource('aac');
    output.addAudioTrack(audioSource);
  }
  await output.start();

  /* --- Video encoder: the candidate ladder, hardware first --- */
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      chainMux(async () => {
        const packet = EncodedPacket.fromEncodedChunk(chunk);
        const { slot, fillsBefore } = stamper.stampFor(chunk.timestamp);
        const timing = stamper.slotTiming(slot);
        if (fillsBefore > 0 && lastVideoPacket) {
          for (let i = 0; i < fillsBefore; i++) {
            const fillTiming = stamper.slotTiming(slot - fillsBefore + i);
            await videoSource.add(
              lastVideoPacket.clone({ timestamp: fillTiming.timestampSec, duration: fillTiming.durationSec }),
            );
            telemetry.framesFilled += 1;
          }
        }
        const stamped = packet.clone({ timestamp: timing.timestampSec, duration: timing.durationSec });
        if (!videoMetaSent) {
          await videoSource.add(stamped, meta);
          videoMetaSent = true;
        } else {
          await videoSource.add(stamped);
        }
        lastVideoPacket = stamped;
        await flushPendingAudio();
      });
    },
    error: (err) => fail(err),
  });
  let configured: VideoEncoderConfig | null = null;
  for (const candidate of start.videoConfigs) {
    try {
      const support = await VideoEncoder.isConfigSupported(candidate);
      if (!support?.supported) continue;
      videoEncoder.configure(support.config ?? candidate);
      configured = support.config ?? candidate;
      break;
    } catch {
      // A config that throws is a declined config; try the next rung.
    }
  }
  if (!configured) {
    try {
      videoEncoder.close();
    } catch {
      // Already closed.
    }
    throw new Error('no WebCodecs encoder config is supported for this take');
  }
  telemetry.encoderCodec = typeof configured.codec === 'string' ? configured.codec : '';

  /* --- Audio encoder (optional; a refusal degrades to video-only, disclosed) --- */
  let audioEncoder: AudioEncoder | null = null;
  if (audioSource && start.audioConfig) {
    const candidate = new AudioEncoder({
      output: (chunk, meta) => {
        pendingAudio.push({ packet: EncodedPacket.fromEncodedChunk(chunk), meta });
        chainMux(() => flushPendingAudio());
      },
      error: (err) => fail(err),
    });
    try {
      const support = await AudioEncoder.isConfigSupported(start.audioConfig);
      if (support?.supported) {
        candidate.configure(support.config ?? start.audioConfig);
        audioEncoder = candidate;
      } else {
        candidate.close();
      }
    } catch {
      try {
        candidate.close();
      } catch {
        // Already closed.
      }
    }
  }
  telemetry.audioIncluded = audioEncoder !== null && audioSource !== null;
  post({ type: 'ready', audioIncluded: telemetry.audioIncluded });

  /* --- Read loops (the readers are kept so finish can cancel
         them — the stream itself belongs to the camera and keeps
         previewing after the take, so nothing else ends them) --- */
  let videoReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  let audioReader: ReadableStreamDefaultReader<AudioData> | null = null;
  const videoLoop = (async () => {
    const reader = start.videoStream.getReader() as ReadableStreamDefaultReader<VideoFrame>;
    videoReader = reader;
    try {
      for (;;) {
        const { done, value: frame } = await reader.read();
        if (done) break;
        if (!frame) continue;
        try {
          telemetry.framesReceived += 1;
          if (shouldDropFrameForQueue(videoEncoder.encodeQueueSize)) {
            telemetry.framesDroppedByQueue += 1;
          } else {
            const keyFrame = framesSinceKey >= fps * 2;
            videoEncoder.encode(frame, { keyFrame });
            framesSinceKey = keyFrame ? 0 : framesSinceKey + 1;
            telemetry.framesEncoded += 1;
          }
        } finally {
          frame.close();
        }
      }
    } catch (err) {
      if (!stopRequested) throw err;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Already released.
      }
    }
  })();

  const audioLoop = (async () => {
    if (!audioEncoder || !start.audioStream) return;
    const reader = start.audioStream.getReader() as ReadableStreamDefaultReader<AudioData>;
    audioReader = reader;
    try {
      for (;;) {
        const { done, value: data } = await reader.read();
        if (done) break;
        if (!data) continue;
        try {
          if (audioEncoder.state === 'configured') audioEncoder.encode(data);
        } finally {
          data.close();
        }
      }
    } catch (err) {
      if (!stopRequested) throw err;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Already released.
      }
    }
  })();
  // A loop rejection outside the stop path fails the take (the
  // loops re-throw only then); guard the floating promises so the
  // rejection is never unhandled before finish awaits them.
  void videoLoop.catch(fail);
  void audioLoop.catch(fail);

  /* --- Finish: flush everything, finalise, report --- */
  let finishPromise: Promise<void> | null = null;
  finishTake = () => {
    if (finishPromise) return finishPromise;
    finishPromise = (async () => {
      // Cancelling a track-processor reader ends its frame supply
      // (the camera track itself is untouched and keeps previewing).
      await Promise.allSettled([videoReader?.cancel(), audioReader?.cancel()]);
      await Promise.allSettled([videoLoop, audioLoop]);
      if (videoEncoder.state === 'configured') await videoEncoder.flush();
      if (audioEncoder && audioEncoder.state === 'configured') await audioEncoder.flush();
      await muxChain;
      await flushPendingAudio(true);
      await muxChain;
      await output.finalize();
      finishPosted = true;
      post({ type: 'finished', telemetry, fileName: start.fileName });
    })();
    return finishPromise;
  };
  if (stopRequested) void finishTake().catch(fail);
}
