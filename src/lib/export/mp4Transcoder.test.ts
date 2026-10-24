import { describe, it, expect, vi } from 'vitest';
import {
  getTranscoderAssetConfig,
  FFMPEG_LOAD_TIMEOUT_MS,
  FFMPEG_LOAD_MAX_ATTEMPTS,
  TRANSCODE_PROGRESS_STALL_MS,
  TRANSCODE_PROGRESS_WATCHDOG_INTERVAL_MS,
} from './transcoderAssets';
import { withTimeout, Mp4TranscodeError, TranscoderLoadTimeoutError } from './mp4Transcoder';

describe('getTranscoderAssetConfig (self-hosted engine assets)', () => {
  const config = getTranscoderAssetConfig();

  it('provides core and wasm URLs as non-empty strings', () => {
    expect(typeof config.coreURL).toBe('string');
    expect(config.coreURL.length).toBeGreaterThan(0);
    expect(typeof config.wasmURL).toBe('string');
    expect(config.wasmURL.length).toBeGreaterThan(0);
  });

  it('never points at the unpkg CDN (the old export-time fetch)', () => {
    for (const url of [config.coreURL, config.wasmURL]) {
      expect(url).not.toContain('unpkg');
      expect(url.startsWith('https://')).toBe(false);
      expect(url.startsWith('http://')).toBe(false);
    }
  });

  it('points at the ffmpeg core js and the core wasm', () => {
    expect(config.coreURL).toContain('ffmpeg-core');
    expect(config.wasmURL).toContain('ffmpeg-core');
    expect(config.wasmURL).toContain('.wasm');
  });

  it('uses two distinct asset files', () => {
    expect(config.coreURL).not.toBe(config.wasmURL);
  });

  it('carries no caller-supplied class worker URL (the build-bundled library worker is used instead)', () => {
    // Pinning the class worker from the caller side makes the Vite
    // build emit a verbatim, broken copy of the library's worker.js —
    // see transcoderAssets.ts. The config must not grow one back
    // without re-verifying the emitted worker chunk.
    expect(config).not.toHaveProperty('classWorkerURL');
  });
});

describe('transcoder timing constants', () => {
  it('bounds an engine load attempt to 30s with exactly one retry', () => {
    expect(FFMPEG_LOAD_TIMEOUT_MS).toBe(30_000);
    expect(FFMPEG_LOAD_MAX_ATTEMPTS).toBe(2);
  });

  it('treats 60s without transcode progress as a stall, checked every 5s', () => {
    expect(TRANSCODE_PROGRESS_STALL_MS).toBe(60_000);
    expect(TRANSCODE_PROGRESS_WATCHDOG_INTERVAL_MS).toBe(5_000);
    expect(TRANSCODE_PROGRESS_WATCHDOG_INTERVAL_MS).toBeLessThan(TRANSCODE_PROGRESS_STALL_MS);
  });
});

describe('withTimeout', () => {
  it('resolves with the wrapped value when it settles in time', async () => {
    const onTimeout = vi.fn();
    const value = await withTimeout(Promise.resolve(42), 1_000, () => new Error('timed out'), onTimeout);
    expect(value).toBe(42);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('rejects with the factory error and runs onTimeout when the deadline wins', async () => {
    const onTimeout = vi.fn();
    const never = new Promise<string>(() => undefined);
    await expect(
      withTimeout(never, 20, () => new TranscoderLoadTimeoutError(20), onTimeout),
    ).rejects.toBeInstanceOf(TranscoderLoadTimeoutError);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('propagates the wrapped rejection unchanged when it settles first', async () => {
    const boom = new Error('boom');
    await expect(withTimeout(Promise.reject(boom), 1_000, () => new Error('timed out'))).rejects.toBe(boom);
  });

  it('a late rejection after a timeout does not escape as a second error', async () => {
    let rejectLater: (err: Error) => void = () => undefined;
    const slow = new Promise<string>((_resolve, reject) => {
      rejectLater = reject;
    });
    const raced = withTimeout(slow, 10, () => new Error('timed out'));
    await expect(raced).rejects.toThrow('timed out');
    // The wrapped promise rejecting afterwards must be silently observed.
    rejectLater(new Error('late failure'));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
});

describe('TranscoderLoadTimeoutError', () => {
  it('is an Mp4TranscodeError with an honest, user-facing message', () => {
    const err = new TranscoderLoadTimeoutError();
    expect(err).toBeInstanceOf(Mp4TranscodeError);
    expect(err.message).toContain("didn't load in time");
    expect(err.message).toContain('30s');
  });
});
