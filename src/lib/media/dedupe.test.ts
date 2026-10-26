import { describe, it, expect } from 'vitest';
import {
  dedupeStorageKey,
  parseDedupeIndex,
  serializeDedupeIndex,
  loadDedupeIndex,
  lookupDedupedEntry,
  getCachedProbe,
  recordDedupedEntry,
  assetFromDedupeEntry,
  MAX_DEDUPE_ENTRIES,
  type DedupeEntry,
  type KeyValueStorage,
} from './dedupe';

function fakeStorage(): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

function entry(overrides: Partial<DedupeEntry> = {}): DedupeEntry {
  return {
    assetId: 'asset_abc',
    storagePath: 'users/u1/media/asset_abc/clip.mp4',
    downloadUrl: 'https://example.test/clip.mp4',
    fileName: 'clip.mp4',
    sizeBytes: 12345,
    mimeType: 'video/mp4',
    probe: { kind: 'video', durationSeconds: 12.5, width: 1920, height: 1080 },
    createdAt: 1000,
    importedAt: 2000,
    ...overrides,
  };
}

describe('dedupeStorageKey', () => {
  it('is uid-scoped', () => {
    expect(dedupeStorageKey('u1')).toContain('u1');
    expect(dedupeStorageKey('u1')).not.toBe(dedupeStorageKey('u2'));
  });
});

describe('parseDedupeIndex', () => {
  it('null / empty parses to an empty index', () => {
    expect(parseDedupeIndex(null)).toEqual({});
    expect(parseDedupeIndex('')).toEqual({});
  });

  it('corrupt JSON parses to an empty index, never throws', () => {
    expect(parseDedupeIndex('{{{not json')).toEqual({});
    expect(parseDedupeIndex('[1,2,3]')).toEqual({});
    expect(parseDedupeIndex('"just a string"')).toEqual({});
    expect(parseDedupeIndex('42')).toEqual({});
  });

  it('round-trips a valid index', () => {
    const index = { hash1: entry(), hash2: entry({ assetId: 'asset_xyz' }) };
    expect(parseDedupeIndex(serializeDedupeIndex(index))).toEqual(index);
  });

  it('drops individually-invalid entries but keeps valid ones', () => {
    const raw = JSON.stringify({
      version: 1,
      entries: {
        good: entry(),
        missingPath: { ...entry(), storagePath: '' },
        badProbe: { ...entry(), probe: { kind: 'document' } },
        notAnObject: 'junk',
        badSize: { ...entry(), sizeBytes: 'lots' },
      },
    });
    const parsed = parseDedupeIndex(raw);
    expect(Object.keys(parsed)).toEqual(['good']);
    expect(parsed.good).toEqual(entry());
  });
});

describe('registry hit / miss', () => {
  it('records an entry and looks it back up by hash', () => {
    const storage = fakeStorage();
    expect(lookupDedupedEntry('u1', 'hash1', storage)).toBeNull();
    expect(recordDedupedEntry('u1', 'hash1', entry(), storage)).toBe(true);
    expect(lookupDedupedEntry('u1', 'hash1', storage)).toEqual(entry());
    expect(lookupDedupedEntry('u1', 'other-hash', storage)).toBeNull();
  });

  it('is scoped per user — another uid misses', () => {
    const storage = fakeStorage();
    recordDedupedEntry('u1', 'hash1', entry(), storage);
    expect(lookupDedupedEntry('u2', 'hash1', storage)).toBeNull();
  });

  it('persists across a fresh load (new "session" over the same storage)', () => {
    const storage = fakeStorage();
    recordDedupedEntry('u1', 'hash1', entry(), storage);
    // Simulate a later session: nothing in memory, read back from storage only.
    expect(loadDedupeIndex('u1', storage)).toEqual({ hash1: entry() });
  });
});

describe('corrupt index handling', () => {
  it('a corrupt stored payload reads as a miss and is healed by the next record', () => {
    const storage = fakeStorage();
    storage.setItem(dedupeStorageKey('u1'), '{{{corrupt');
    expect(lookupDedupedEntry('u1', 'hash1', storage)).toBeNull();
    expect(getCachedProbe('u1', 'hash1', storage)).toBeNull();
    expect(recordDedupedEntry('u1', 'hash1', entry(), storage)).toBe(true);
    expect(lookupDedupedEntry('u1', 'hash1', storage)).toEqual(entry());
    // The stored payload is valid JSON again.
    expect(() => JSON.parse(storage.map.get(dedupeStorageKey('u1'))!)).not.toThrow();
  });

  it('storage that throws on read reads as empty; on write reports false — never throws', () => {
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    expect(loadDedupeIndex('u1', throwing)).toEqual({});
    expect(lookupDedupedEntry('u1', 'h', throwing)).toBeNull();
    expect(recordDedupedEntry('u1', 'h', entry(), throwing)).toBe(false);
  });

  it('null storage (unavailable) degrades to miss + unrecorded, never throws', () => {
    expect(lookupDedupedEntry('u1', 'h', null)).toBeNull();
    expect(recordDedupedEntry('u1', 'h', entry(), null)).toBe(false);
  });
});

describe('probe cache (registry-backed)', () => {
  it('returns the stored probe for a known hash and null for a miss', () => {
    const storage = fakeStorage();
    recordDedupedEntry('u1', 'hash1', entry(), storage);
    expect(getCachedProbe('u1', 'hash1', storage)).toEqual({
      kind: 'video',
      durationSeconds: 12.5,
      width: 1920,
      height: 1080,
    });
    expect(getCachedProbe('u1', 'nope', storage)).toBeNull();
  });
});

describe('eviction', () => {
  it(`caps the index at MAX_DEDUPE_ENTRIES, evicting the oldest first`, () => {
    const storage = fakeStorage();
    const total = MAX_DEDUPE_ENTRIES + 5;
    for (let i = 0; i < total; i++) {
      recordDedupedEntry('u1', `hash${i}`, entry({ assetId: `asset_${i}`, importedAt: i }), storage);
    }
    const index = loadDedupeIndex('u1', storage);
    expect(Object.keys(index)).toHaveLength(MAX_DEDUPE_ENTRIES);
    expect(index.hash0).toBeUndefined();
    expect(index.hash4).toBeUndefined();
    expect(index[`hash${total - 1}`]).toBeDefined();
  });
});

describe('assetFromDedupeEntry', () => {
  it('rebuilds the existing MediaAsset from the entry', () => {
    expect(assetFromDedupeEntry(entry())).toEqual({
      id: 'asset_abc',
      kind: 'video',
      storageUrl: 'https://example.test/clip.mp4',
      fileName: 'clip.mp4',
      sizeBytes: 12345,
      mimeType: 'video/mp4',
      durationSeconds: 12.5,
      width: 1920,
      height: 1080,
      createdAt: 1000,
    });
  });
});
