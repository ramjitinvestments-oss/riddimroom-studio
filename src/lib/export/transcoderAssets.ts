/**
 * RiddimRoom Studio — self-hosted ffmpeg.wasm engine assets.
 *
 * The URLs the MP4 transcoder (mp4Transcoder.ts) hands to
 * `ffmpeg.load()` point at files THIS app ships, imported here with
 * Vite `?url` asset imports so the build emits them as first-party
 * files served from the app's own origin:
 *
 *  - `coreURL` — `@ffmpeg/core`'s ffmpeg-core.js (ESM build)
 *  - `wasmURL` — `@ffmpeg/core`'s ffmpeg-core.wasm (~32MB)
 *
 * The third load input, @ffmpeg/ffmpeg's class worker, is deliberately
 * NOT passed. `FFmpeg.load()` builds it from its own package
 * (`new URL("./worker.js", import.meta.url)` inside the library), and
 * the production build bundles that worker into a self-contained chunk
 * and rewrites the reference to the chunk's literal emitted path — a
 * constant in the shipped bundle, resolved at build time, not at
 * runtime. Supplying a caller-side worker URL instead (via a `?url`
 * import or a `new URL(...)` asset reference) makes the build emit the
 * library's worker.js as a VERBATIM copy whose own relative imports
 * (./const.js, ./errors.js) don't exist in dist/assets — a broken
 * worker that fails every load. Both routes were tried and verified
 * against real builds; the library-bundled worker is the only sound
 * option in this Vite setup, so it is the one we ship.
 *
 * Until this module existed, the core JS+WASM were fetched at export
 * time from the unpkg CDN — if that fetch (or the implicit worker
 * startup behind it) failed or crawled, an export sat at
 * "Preparing MP4… 0%" forever with no error. Self-hosting removes the
 * third-party CDN from the export path entirely: the same bytes, from
 * the same origin, under the app's own control.
 *
 * `@ffmpeg/core` is pinned to the exact version in package.json
 * (0.12.10 — the same version the old CDN URL served), so self-hosting
 * changes where the bytes come from, not which bytes they are.
 */
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

export interface TranscoderAssetConfig {
  coreURL: string;
  wasmURL: string;
}

export function getTranscoderAssetConfig(): TranscoderAssetConfig {
  return { coreURL, wasmURL };
}

/**
 * How long a single engine-load attempt may take before it is treated
 * as failed. Loading is same-origin now, so 30s is generous — reaching
 * it means something is genuinely stuck, not merely slow.
 */
export const FFMPEG_LOAD_TIMEOUT_MS = 30_000;

/** Total engine-load attempts: the initial try plus one retry on a fresh instance. */
export const FFMPEG_LOAD_MAX_ATTEMPTS = 2;

/**
 * If ffmpeg reports no transcode progress for this long, the conversion
 * is treated as stalled and aborted. Healthy transcodes emit progress
 * continuously; a full minute of silence is the historical hang
 * signature, not a slow encode.
 */
export const TRANSCODE_PROGRESS_STALL_MS = 60_000;

/** How often the transcode watchdog checks for a stall. */
export const TRANSCODE_PROGRESS_WATCHDOG_INTERVAL_MS = 5_000;
