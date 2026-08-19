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
 * ffmpeg-core (~32MB of JS+WASM) is fetched at runtime from the unpkg CDN
 * (the standard ffmpeg.wasm distribution approach) rather than bundled into
 * this app's own build/deploy artifact — it's the single-threaded core (no
 * SharedArrayBuffer), so no COOP/COEP response headers are required from
 * this app's own server either way.
 *
 * The ffmpeg.wasm instance (and the ~30MB core it downloads) is created
 * lazily on first use and reused for subsequent exports in the same tab —
 * dynamic `import()` keeps it out of the main bundle entirely, matching the
 * existing pattern in src/lib/backgroundRemoval/index.ts for
 * @imgly/background-removal.
 */

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

let ffmpegSingleton: import('@ffmpeg/ffmpeg').FFmpeg | null = null;
let loadPromise: Promise<import('@ffmpeg/ffmpeg').FFmpeg> | null = null;

async function getFFmpeg(): Promise<import('@ffmpeg/ffmpeg').FFmpeg> {
  if (ffmpegSingleton) return ffmpegSingleton;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    const { toBlobURL } = await import('@ffmpeg/util');

    const ffmpeg = new FFmpeg();
    // Matches the @ffmpeg/core version installed in package.json. Must be
    // the `esm` build specifically — ffmpeg.wasm's internal Worker loads
    // this via a dynamic `import()`, which requires a real ES module; the
    // `umd` build is not one and fails with "failed to import ffmpeg-core.js"
    // (confirmed live while diagnosing this).
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm';
    try {
      const [coreURL, wasmURL] = await Promise.all([
        toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      ]);
      await ffmpeg.load({ coreURL, wasmURL });
    } catch (err) {
      loadPromise = null;
      // eslint-disable-next-line no-console
      console.error('[mp4Transcoder] ffmpeg-core failed to load:', err);
      throw new Mp4TranscodeError(
        `Could not load the MP4 conversion engine: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
    ffmpegSingleton = ffmpeg;
    return ffmpeg;
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
export async function transcodeWebmToMp4(
  webmBlob: Blob,
  sourceFrameRate: number,
  onProgress?: (progress: TranscodeProgress) => void,
): Promise<Blob> {
  if (webmBlob.size === 0) {
    throw new Mp4TranscodeError('Cannot convert an empty recording to MP4.');
  }
  const fps = Number.isFinite(sourceFrameRate) && sourceFrameRate > 0 ? Math.round(sourceFrameRate) : 30;

  const ffmpeg = await getFFmpeg();
  const { fetchFile } = await import('@ffmpeg/util');

  const inputName = 'input.webm';
  const outputName = 'output.mp4';

  const progressHandler = ({ progress }: { progress: number }) => {
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
    await ffmpeg.exec([
      '-i', inputName,
      '-r', String(fps),
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      outputName,
    ]);

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
