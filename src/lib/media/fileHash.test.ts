import { describe, it, expect } from 'vitest';
import { hashFileContent, sampleRangesForSize, HASH_SAMPLE_BYTES, type HashableFile } from './fileHash';

const S = HASH_SAMPLE_BYTES;

function makeFile(bytes: Uint8Array, type = 'video/mp4', name = 'clip.mp4'): File {
  // Copy into a fresh ArrayBuffer-backed view — Blob parts accept it and
  // this keeps TS's ArrayBuffer vs ArrayBufferLike distinction happy.
  const copy = new Uint8Array(bytes);
  return new File([copy.buffer], name, { type });
}

/** Deterministic pseudo-content: byte i depends on i and a seed, so two seeds differ almost everywhere. */
function content(size: number, seed = 7): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed * 17 + (i >> 8)) & 0xff;
  return out;
}

describe('sampleRangesForSize', () => {
  it('empty / invalid sizes sample nothing', () => {
    expect(sampleRangesForSize(0)).toEqual([]);
    expect(sampleRangesForSize(-5)).toEqual([]);
  });

  it('a file under one sample is sampled whole', () => {
    expect(sampleRangesForSize(100)).toEqual([{ start: 0, end: 100 }]);
    expect(sampleRangesForSize(S)).toEqual([{ start: 0, end: S }]);
  });

  it('a large file gets exactly head + centred middle + tail samples', () => {
    const size = 10 * S + 123;
    const ranges = sampleRangesForSize(size);
    expect(ranges).toHaveLength(3);
    expect(ranges[0]).toEqual({ start: 0, end: S });
    expect(ranges[2]).toEqual({ start: size - S, end: size });
    const midCentre = (ranges[1].start + ranges[1].end) / 2;
    expect(Math.abs(midCentre - size / 2)).toBeLessThanOrEqual(1);
    expect(ranges[1].end - ranges[1].start).toBe(S);
    for (const r of ranges) expect(r.end - r.start).toBeLessThanOrEqual(S);
  });

  it('a mid-size file (between 1 and 3 samples) has every byte covered', () => {
    for (const size of [S + 1, Math.floor(1.5 * S), 2 * S, Math.floor(2.7 * S), 3 * S]) {
      const ranges = sampleRangesForSize(size);
      const covered = new Uint8Array(size);
      for (const r of ranges) for (let i = r.start; i < r.end; i++) covered[i] = 1;
      expect(covered.every((b) => b === 1)).toBe(true);
    }
  });
});

describe('hashFileContent', () => {
  it('identical bytes produce the identical hash', async () => {
    const bytes = content(5000);
    const a = await hashFileContent(makeFile(bytes));
    const b = await hashFileContent(makeFile(new Uint8Array(bytes)));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic across repeated calls on a large file', async () => {
    const file = makeFile(content(5 * S + 999));
    const first = await hashFileContent(file);
    const second = await hashFileContent(file);
    expect(second).toBe(first);
  });

  it('different bytes in the HEAD sample change the hash', async () => {
    const a = content(4 * S);
    const b = new Uint8Array(a);
    b[10] ^= 0xff;
    expect(await hashFileContent(makeFile(b))).not.toBe(await hashFileContent(makeFile(a)));
  });

  it('different bytes in the MIDDLE sample change the hash', async () => {
    const a = content(4 * S);
    const b = new Uint8Array(a);
    b[2 * S] ^= 0xff; // dead centre — inside the middle sample, outside head/tail
    expect(await hashFileContent(makeFile(b))).not.toBe(await hashFileContent(makeFile(a)));
  });

  it('different bytes in the TAIL sample change the hash', async () => {
    const a = content(4 * S);
    const b = new Uint8Array(a);
    b[b.length - 5] ^= 0xff;
    expect(await hashFileContent(makeFile(b))).not.toBe(await hashFileContent(makeFile(a)));
  });

  it('size is part of the hash even when every sampled byte matches', async () => {
    // Two zero-filled files of different sizes have byte-identical head /
    // middle / tail samples (all zeros, each exactly one sample long) —
    // only the size in the preimage can tell them apart.
    const a = new Uint8Array(4 * S);
    const b = new Uint8Array(5 * S);
    expect(await hashFileContent(makeFile(b))).not.toBe(await hashFileContent(makeFile(a)));
  });

  it('appending a byte changes the hash', async () => {
    const a = content(3000);
    const b = new Uint8Array(3001);
    b.set(a, 0);
    b[3000] = 42;
    expect(await hashFileContent(makeFile(b))).not.toBe(await hashFileContent(makeFile(a)));
  });

  it('mime type is part of the hash', async () => {
    const bytes = content(3000);
    const asVideo = await hashFileContent(makeFile(bytes, 'video/mp4'));
    const asAudio = await hashFileContent(makeFile(bytes, 'audio/mpeg'));
    expect(asAudio).not.toBe(asVideo);
  });

  it('an empty file still hashes (header-only preimage)', async () => {
    const h = await hashFileContent(makeFile(new Uint8Array(0), 'image/png', 'empty.png'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the large-file path reads ONLY the sample ranges', async () => {
    const size = 20 * S; // 5 MiB logical file
    const backing = content(size);
    const reads: Array<{ start: number; end: number }> = [];
    const fake: HashableFile = {
      size,
      type: 'video/mp4',
      slice(start = 0, end = size) {
        reads.push({ start, end });
        return new Blob([backing.slice(start, end).buffer]);
      },
    };
    const hash = await hashFileContent(fake);
    const totalRead = reads.reduce((sum, r) => sum + (r.end - r.start), 0);
    expect(totalRead).toBe(3 * S);
    expect(reads).toEqual(sampleRangesForSize(size));
    // And the sampled hash of the fake equals the hash of a real File with
    // the same bytes — the fake's slices fed the hasher the real samples.
    expect(hash).toBe(await hashFileContent(makeFile(backing)));
  });
});
