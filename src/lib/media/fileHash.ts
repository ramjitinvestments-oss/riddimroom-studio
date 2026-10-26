/**
 * RiddimRoom Studio — WS-S1 sampled content hash.
 *
 * A cheap fingerprint of a File's CONTENT, used as the dedupe + probe-cache
 * key for media imports (see dedupe.ts / upload.ts). Hashing a 500 MB video
 * end-to-end just to notice "the user picked this exact file last week"
 * would burn more time than it saves, so the digest covers only three
 * samples — head, middle, tail — plus the exact byte size and mime type:
 *
 *   SHA-256( "rr-sampled-hash-v1:{size}:{type}:" ‖ head ‖ middle ‖ tail )
 *
 * Each sample is at most HASH_SAMPLE_BYTES (256 KiB), so a hash never reads
 * more than 768 KiB no matter how large the file is. For files at or under
 * 3 samples long the samples tile the whole file (no gaps), i.e. small
 * files are effectively fully hashed.
 *
 * This is a dedupe key, not a security primitive: two DIFFERENT files would
 * need the same size, same mime type, and identical head/middle/tail
 * 256 KiB regions to collide — practically impossible for real media, and
 * the worst case of a collision is reusing an identical-looking asset the
 * same user already uploaded (the R26 plan's stated tolerance).
 */

/** Bytes read per sample (head / middle / tail). */
export const HASH_SAMPLE_BYTES = 256 * 1024;

/** Version tag baked into the digest preimage — bump if the sampling scheme ever changes. */
const HASH_SCHEME_VERSION = 'rr-sampled-hash-v1';

/**
 * The minimal slice of the File/Blob API the hasher needs. `File` and
 * `Blob` both satisfy it structurally; tests pass a recording fake to
 * prove the large-file path reads only the samples.
 */
export interface HashableFile {
  readonly size: number;
  readonly type: string;
  slice(start?: number, end?: number): Blob;
}

export interface SampleRange {
  start: number;
  /** Exclusive. */
  end: number;
}

/**
 * The [start, end) ranges sampled for a file of `size` bytes. Pure and
 * exported so tests (and any future caller) can assert exactly what will
 * be read before a single byte is touched.
 *
 * - size <= 3 * sampleBytes: the ranges' union is the whole file — no
 *   byte goes unsampled (the middle range shrinks to whatever is left,
 *   and head/tail may overlap slightly just above one sample long).
 * - larger: head [0, S), middle centred on size/2, tail [size - S, size).
 */
export function sampleRangesForSize(size: number, sampleBytes: number = HASH_SAMPLE_BYTES): SampleRange[] {
  if (!Number.isFinite(size) || size <= 0) return [];
  const sample = Math.max(1, Math.floor(sampleBytes));
  if (size <= sample) return [{ start: 0, end: size }];
  if (size <= 3 * sample) {
    const midStart = sample;
    const midEnd = size - sample;
    const ranges: SampleRange[] = [{ start: 0, end: sample }];
    if (midEnd > midStart) ranges.push({ start: midStart, end: midEnd });
    ranges.push({ start: size - sample, end: size });
    return ranges;
  }
  const midStart = Math.floor((size - sample) / 2);
  return [
    { start: 0, end: sample },
    { start: midStart, end: midStart + sample },
    { start: size - sample, end: size },
  ];
}

function toHex(digest: ArrayBuffer): string {
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Computes the sampled content hash of a file as a lowercase hex SHA-256
 * string. Reads ONLY the sample ranges (plus nothing else) — a 500 MB
 * file costs at most 768 KiB of reads and one digest over ≤768 KiB.
 *
 * Deterministic and pure with respect to content: identical bytes + size
 * + type always produce the identical hash; any byte difference inside a
 * sampled region (head, middle, or tail) changes it.
 */
export async function hashFileContent(file: HashableFile): Promise<string> {
  const ranges = sampleRangesForSize(file.size);
  const header = new TextEncoder().encode(`${HASH_SCHEME_VERSION}:${file.size}:${file.type || ''}:`);
  const sampleBytesTotal = ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
  const preimage = new Uint8Array(header.length + sampleBytesTotal);
  preimage.set(header, 0);
  let offset = header.length;
  for (const range of ranges) {
    const buf = new Uint8Array(await file.slice(range.start, range.end).arrayBuffer());
    preimage.set(buf, offset);
    offset += buf.length;
  }
  const digest = await crypto.subtle.digest('SHA-256', preimage);
  return toHex(digest);
}
