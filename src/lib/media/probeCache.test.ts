import { describe, it, expect, beforeEach } from 'vitest';
import {
  probeMediaFileCached,
  primeProbeCache,
  getCachedProbeResult,
  clearProbeCache,
  probeCacheSize,
  type ProbedMedia,
} from './probe';
import { hashFileContent } from './fileHash';

/**
 * WS-S1 probe cache tests. Vitest runs in the node environment (no DOM),
 * so a REAL probe of any file rejects here — which is exactly what makes
 * these tests sharp: if `probeMediaFileCached` returns a value at all, it
 * must have come from the cache, not from a fresh probe.
 */

const PROBED: ProbedMedia = { kind: 'video', durationSeconds: 9.25, width: 1280, height: 720 };

function makeFile(content: string, type = 'video/mp4'): File {
  return new File([new TextEncoder().encode(content)], 'clip.mp4', { type });
}

beforeEach(() => {
  clearProbeCache();
});

describe('probe cache primitives', () => {
  it('prime / get / size / clear behave as a plain hash-keyed map', () => {
    expect(getCachedProbeResult('h1')).toBeNull();
    primeProbeCache('h1', PROBED);
    expect(getCachedProbeResult('h1')).toEqual(PROBED);
    expect(probeCacheSize()).toBe(1);
    clearProbeCache();
    expect(getCachedProbeResult('h1')).toBeNull();
    expect(probeCacheSize()).toBe(0);
  });
});

describe('probeMediaFileCached', () => {
  it('returns the cached result for a known hash without probing', async () => {
    primeProbeCache('known-hash', PROBED);
    const result = await probeMediaFileCached(makeFile('whatever'), 'video/mp4', 'known-hash');
    expect(result).toEqual(PROBED);
  });

  it('computes the content hash itself when none is passed, and hits the cache', async () => {
    const file = makeFile('cache me by content');
    const hash = await hashFileContent(file);
    primeProbeCache(hash, PROBED);
    const result = await probeMediaFileCached(file, 'video/mp4');
    expect(result).toEqual(PROBED);
  });

  it('a cache miss falls through to the real probe (which rejects without a DOM)', async () => {
    const file = makeFile('never probed before');
    await expect(probeMediaFileCached(file, 'video/mp4')).rejects.toThrow();
    // A failed probe must not poison the cache.
    const hash = await hashFileContent(file);
    expect(getCachedProbeResult(hash)).toBeNull();
  });

  it('different content does not collide with a cached entry', async () => {
    const cached = makeFile('content A');
    primeProbeCache(await hashFileContent(cached), PROBED);
    const other = makeFile('content B — different bytes');
    await expect(probeMediaFileCached(other, 'video/mp4')).rejects.toThrow();
  });
});
