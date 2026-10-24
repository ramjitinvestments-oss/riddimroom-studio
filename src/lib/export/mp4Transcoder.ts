/**
 * RiddimRoom Studio — WebM → MP4 transcoder.
 *
 * `Canvas2DRenderer` (canvas2dRenderer.ts) is unchanged and still produces a
 * real `video/webm` (VP9 + Opus) blob exactly as before — that rendering
 * loop is left completely intact per the explicit requirement not to touch
 * working export/render behavior. This module takes that finished WebM blob
 * and transcodes it, client-side, into a genuine MP4 container (H.264 video
 * + AAC audio) using ffmpeg.wasm. Nothing here re-renders the canvas or
 * re-reads the project/timeline — it operates purely on the already-recorded
 * WebM bytes, so every pixel/audio-sample the existing renderer already
 * produces (text, watermark, layering, rotation, effects, transitions,
 * captions) passes through unchanged into the MP4; only the container/codec
 * changes.
 *
 * ffmpeg-core (~32MB of JS+WASM) is SELF-HOSTED: it ships inside this
 * app's own build artifact and is served from the app's own origin (see
 * transcoderAssets.ts for the asset wiring). It used to be fetched at
 * export time from the unpkg CDN — if that fetch, or the worker startup
 * behind it, failed or crawled, an export sat at "Preparing MP4… 0%"
 * forever with no error. It's the single-threaded core (no
 * SharedArrayBuffer), so no COOP/COEP response headers are required from
 * this app's own server either way.
 *
 * The ffmpeg.wasm instance (and the ~32MB core behind it) is created
 * lazily on first use and reused for subsequent exports in the same tab —
 * dynamic `import()` keeps the @ffmpeg/ffmpeg library code out of the
 * main bundle entirely, matching the existing pattern in
 * src/lib/backgroundRemoval/index.ts for @imgly/background-removal. The
 * core/wasm/worker files themselves are plain static assets referenced
 * by URL, so referencing them costs nothing until an export runs.
 *
 * Engine loading is bounded: each load attempt has a timeout
 * (FFMPEG_LOAD_TIMEOUT_MS), a timed-out/failed attempt is terminated
 * and retried once on a fresh instance, and a second failure throws an
 * honest error the export panel displays — an export can no longer sit
 * at 0% indefinitely because the engine never arrived.
 */

import {
  getTranscoderAssetConfig,
  FFMPEG_LOAD_TIMEOUT_MS,
  FFMPEG_LOAD_MAX_ATTEMPTS,
  TRANSCODE_PROGRESS_STALL_MS,
  TRANSCODE_PROGRESS_WATCHDOG_INTERVAL_MS,
} from './transcoderAssets';

export interface TranscodeProgress {
  /** 0-1. ffmpeg.wasm's own progress events are occasionally slightly out of [0,1]; this is clamped. */
  ratio: number;
}

export class Mp4TranscodeError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'Mp4TranscodeError';
  }
}

/** The engine did not finish loading within FFMPEG_LOAD_TIMEOUT_MS. */
export class TranscoderLoadTimeoutError extends Mp4TranscodeError {
  constructor(timeoutMs: number = FFMPEG_LOAD_TIMEOUT_MS, cause?: unknown) {
    super(
      `The MP4 conversion engine didn't load in time (${Math.round(timeoutMs / 1000)}s). Please try again.`,
      cause,
    );
    this.name = 'TranscoderLoadTimeoutError';
  }
}

/**
 * Races `promise` against a deadline. If the deadline wins, `onTimeout`
 * runs (used to terminate the half-loaded ffmpeg instance so it doesn't
 * linger) and the race rejects with the error from `makeTimeoutError`.
 * The wrapped promise's own settlement is always observed, so a late
 * rejection after a timeout never surfaces as an unhandled rejection.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  makeTimeoutError: () => Error,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        /* best-effort cleanup only */
      }
      reject(makeTimeoutError());
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

let ffmpegSingleton: import('@ffmpeg/ffmpeg').FFmpeg | null = null;
let loadPromise: Promise<import('@ffmpeg/ffmpeg').FFmpeg> | null = null;

/**
 * One engine-load attempt on a brand-new FFmpeg instance: self-hosted
 * core/wasm URLs (transcoderAssets.ts), bounded by the load timeout.
 * A timed-out attempt terminates its instance before throwing, so the
 * retry really does start from a clean worker.
 */
async function loadFFmpegInstance(): Promise<import('@ffmpeg/ffmpeg').FFmpeg> {
  const { FFmpeg } = await import('@ffmpeg/ffmpeg');
  const ffmpeg = new FFmpeg();
  // The URLs come from @ffmpeg/core's `esm` build specifically —
  // ffmpeg.wasm's internal Worker loads the core via a dynamic
  // `import()`, which requires a real ES module; the `umd` build is not
  // one and fails with "failed to import ffmpeg-core.js" (confirmed
  // live while diagnosing this). No classWorkerURL is passed: the
  // production build bundles the library's own worker into a
  // self-contained chunk at a literal emitted path (see
  // transcoderAssets.ts for why a caller-supplied worker URL is worse).
  const { coreURL, wasmURL } = getTranscoderAssetConfig();
  await withTimeout(
    ffmpeg.load({ coreURL, wasmURL }),
    FFMPEG_LOAD_TIMEOUT_MS,
    () => new TranscoderLoadTimeoutError(),
    () => {
      try {
        ffmpeg.terminate();
      } catch {
        /* ignore — the instance is being discarded either way */
      }
    },
  );
  return ffmpeg;
}

async function getFFmpeg(): Promise<import('@ffmpeg/ffmpeg').FFmpeg> {
  if (ffmpegSingleton) return ffmpegSingleton;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= FFMPEG_LOAD_MAX_ATTEMPTS; attempt++) {
      try {
        const ffmpeg = await loadFFmpegInstance();
        ffmpegSingleton = ffmpeg;
        return ffmpeg;
      } catch (err) {
        lastError = err;
        // eslint-disable-next-line no-console
        console.error(
          `[mp4Transcoder] ffmpeg engine load attempt ${attempt}/${FFMPEG_LOAD_MAX_ATTEMPTS} failed:`,
          err,
        );
      }
    }
    loadPromise = null;
    if (lastError instanceof TranscoderLoadTimeoutError) throw lastError;
    throw new Mp4TranscodeError(
      `Could not load the MP4 conversion engine: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      lastError,
    );
  })();

  return loadPromise;
}

/**
 * Transcodes a WebM (VP9/VP8 + Opus) blob into a genuine MP4 container
 * (H.264 + AAC, `+faststart` for immediate playback/seek). Rejects with
 * `Mp4TranscodeError` on any failure — callers must not fall back to
 * silently relabeling the WebM as an MP4.
 *
 * `sourceFrameRate` should be the project's own `frameRate` (the same value
 * passed to `canvas.captureStream()` in canvas2dRenderer.ts). This matters
 * more than it looks: `MediaRecorder`'s WebM output has no real duration or
 * frame-rate in its container metadata, only a 1000Hz (millisecond) time
 * base — which `ffprobe`/`ffmpeg` misreport as the stream's frame rate
 * ("1k tbr"/"1k fps"). Without an explicit `-r`, ffmpeg tries to conform the
 * output to that bogus ~1000fps rate and inserts thousands of duplicate
 * frames, which is why an early version of this hung indefinitely (confirmed
 * live: identical hang reproduced with plain command-line ffmpeg on the same
 * file — not a WASM or browser issue — and resolved by forcing the real
 * output frame rate).
 */
export interface TranscodeQualityOptions {
  /** libx264 CRF (lower = higher quality). Defaults to 20 — the value hardcoded before the export quality picker existed. */
  crf?: number;
  /** AAC audio bitrate in kbps. Defaults to 192 — likewise the pre-picker value. */
  audioBitrateKbps?: number;
}

export async function transcodeWebmToMp4(
  webmBlob: Blob,
  sourceFrameRate: number,
  onProgress?: (progress: TranscodeProgress) => void,
  quality?: TranscodeQualityOptions,
): Promise<Blob> {
  if (webmBlob.size === 0) {
    throw new Mp4TranscodeError('Cannot convert an empty recording to MP4.');
  }
  const fps = Number.isFinite(sourceFrameRate) && sourceFrameRate > 0 ? Math.round(sourceFrameRate) : 30;
  const crf = quality?.crf ?? 20;
  const audioBitrateKbps = quality?.audioBitrateKbps ?? 192;

  const ffmpeg = await getFFmpeg();
  const { fetchFile } = await import('@ffmpeg/util');

  const inputName = 'input.webm';
  const outputName = 'output.mp4';

  let lastProgressAt = Date.now();
  const progressHandler = ({ progress }: { progress: number }) => {
    lastProgressAt = Date.now();
    if (Number.isFinite(progress)) onProgress?.({ ratio: Math.max(0, Math.min(1, progress)) });
  };
  ffmpeg.on('progress', progressHandler);

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(webmBlob));

    // -r <fps>: see the frame-rate note above — this is the fix for the hang.
    // -c:v libx264 + -pix_fmt yuv420p: the broadly-compatible MP4 video
    // codec/pixel-format combination (yuv420p specifically so the file
    // plays in Safari/QuickTime/most phones, not just Chromium).
    // -c:a aac: MP4-compatible audio codec (source is Opus, not valid in MP4).
    // -movflags +faststart: moves the moov atom to the front so the file is
    // seekable/streamable immediately rather than only after a full download.
    //
    // The exec is raced against a no-progress watchdog: healthy transcodes
    // emit progress events continuously, so a full
    // TRANSCODE_PROGRESS_STALL_MS of silence means the conversion is
    // wedged, not slow. On a stall the worker is terminated, the cached
    // singleton is dropped (so the next export reloads a fresh engine),
    // and the caller gets an honest "stalled" error instead of an
    // export that sits at one percentage forever.
    lastProgressAt = Date.now();
    const execPromise = ffmpeg.exec([
      '-i', inputName,
      '-r', String(fps),
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', String(crf),
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', `${audioBitrateKbps}k`,
      '-movflags', '+faststart',
      outputName,
    ]);
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    let stalled = false;
    const stallPromise = new Promise<never>((_resolve, reject) => {
      watchdogTimer = setInterval(() => {
        if (Date.now() - lastProgressAt > TRANSCODE_PROGRESS_STALL_MS) {
          stalled = true;
          reject(
            new Mp4TranscodeError(
              `The MP4 conversion stalled — no progress for ${Math.round(TRANSCODE_PROGRESS_STALL_MS / 1000)} seconds — and was stopped. Please try again.`,
            ),
          );
        }
      }, TRANSCODE_PROGRESS_WATCHDOG_INTERVAL_MS);
    });
    let exitCode: number;
    try {
      exitCode = await Promise.race([execPromise, stallPromise]);
    } catch (err) {
      if (stalled) {
        // The watchdog won: the worker is wedged. Observe the exec
        // promise so its eventual settlement is never an unhandled
        // rejection, terminate the worker, and drop the singleton so
        // the next export reloads a fresh engine.
        execPromise.catch(() => undefined);
        try {
          ffmpeg.terminate();
        } catch {
          /* ignore — the instance is dead either way */
        }
        if (ffmpegSingleton === ffmpeg) {
          ffmpegSingleton = null;
          loadPromise = null;
        }
      }
      throw err;
    } finally {
      if (watchdogTimer !== null) clearInterval(watchdogTimer);
    }
    if (exitCode !== 0) {
      throw new Mp4TranscodeError(`MP4 conversion failed (ffmpeg exited with code ${exitCode}).`);
    }

    const data = await ffmpeg.readFile(outputName);
    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
    if (bytes.byteLength === 0) {
      throw new Mp4TranscodeError('MP4 conversion produced an empty file.');
    }
    return new Blob([bytes], { type: 'video/mp4' });
  } catch (err) {
    if (err instanceof Mp4TranscodeError) throw err;
    // eslint-disable-next-line no-console
    console.error('[mp4Transcoder] conversion failed:', err);
    throw new Mp4TranscodeError(err instanceof Error ? err.message : 'MP4 conversion failed.', err);
  } finally {
    ffmpeg.off('progress', progressHandler);
    // Best-effort cleanup of the WASM virtual filesystem so repeated
    // exports in the same tab don't accumulate files.
    try {
      await ffmpeg.deleteFile(inputName);
    } catch {
      /* ignore */
    }
    try {
      await ffmpeg.deleteFile(outputName);
    } catch {
      /* ignore */
    }
  }
}
