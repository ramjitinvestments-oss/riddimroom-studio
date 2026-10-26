/**
 * RiddimRoom Studio — WS-S1 import dedupe registry + probe cache.
 *
 * A per-user, device-local index (localStorage, following the brand-kit /
 * site-profile persistence pattern: pure parse/serialize helpers, fail-soft
 * wrappers, no Firestore) mapping a file's sampled content hash
 * (fileHash.ts) to the asset that content already became:
 *
 *   hash -> { assetId, storagePath, downloadUrl, fileName, sizeBytes,
 *             mimeType, probe, createdAt, importedAt }
 *
 * Two wins ride on this one record:
 *  1. DEDUPE — re-importing the same content (same session or months
 *     later) resolves to the EXISTING asset/storage object. No bytes are
 *     re-uploaded; the storage path keeps the exact
 *     `users/{uid}/media/{assetId}/{filename}` shape storage.rules scopes
 *     to the owner.
 *  2. PROBE CACHE — the probe result captured at first import is stored
 *     alongside, so a re-import never re-probes either. (probe.ts also
 *     keeps an in-memory cache keyed by the same hash for the
 *     probe-then-upload double-probe within one import.)
 *
 * Everything here is fail-soft by design: a missing, corrupt, or
 * partially-invalid index degrades to "no dedupe" (a normal upload), never
 * to a blocked import. Entries that fail validation are dropped
 * individually; a wholly unparseable payload parses to an empty index.
 */

import type { ProbedMedia } from './probe';
import type { MediaAsset } from '../../types/timeline';

export interface DedupeEntry {
  assetId: string;
  /** `users/{uid}/media/{assetId}/{filename}` — the existing storage object. */
  storagePath: string;
  downloadUrl: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  /** Probe result captured at first import — the persistent probe cache. */
  probe: ProbedMedia;
  /** The existing asset's createdAt (ms epoch). */
  createdAt: number;
  /** When this entry was recorded (ms epoch) — drives eviction. */
  importedAt: number;
}

/** hash -> entry. */
export type DedupeIndex = Record<string, DedupeEntry>;

/** Hard cap so the index can never grow localStorage without bound; oldest entries evict first. */
export const MAX_DEDUPE_ENTRIES = 200;

const INDEX_VERSION = 1;

export function dedupeStorageKey(uid: string): string {
  return `riddimroom-studio:media-dedupe:v${INDEX_VERSION}:${uid}`;
}

/** The minimal Storage surface used here — `localStorage` satisfies it; tests inject a fake. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): KeyValueStorage | null {
  try {
    const ls = (globalThis as { localStorage?: KeyValueStorage }).localStorage;
    return ls ?? null;
  } catch {
    return null; // storage access itself can throw (privacy modes) — treat as unavailable
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProbe(value: unknown): ProbedMedia | null {
  if (!isRecord(value)) return null;
  if (value.kind !== 'video' && value.kind !== 'image' && value.kind !== 'audio') return null;
  const probe: ProbedMedia = { kind: value.kind };
  if (typeof value.durationSeconds === 'number' && Number.isFinite(value.durationSeconds)) {
    probe.durationSeconds = value.durationSeconds;
  }
  if (typeof value.width === 'number' && Number.isFinite(value.width)) probe.width = value.width;
  if (typeof value.height === 'number' && Number.isFinite(value.height)) probe.height = value.height;
  return probe;
}

function parseEntry(value: unknown): DedupeEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.assetId !== 'string' || !value.assetId) return null;
  if (typeof value.storagePath !== 'string' || !value.storagePath) return null;
  if (typeof value.downloadUrl !== 'string' || !value.downloadUrl) return null;
  if (typeof value.fileName !== 'string') return null;
  if (typeof value.sizeBytes !== 'number' || !Number.isFinite(value.sizeBytes)) return null;
  if (typeof value.mimeType !== 'string' || !value.mimeType) return null;
  const probe = parseProbe(value.probe);
  if (!probe) return null;
  return {
    assetId: value.assetId,
    storagePath: value.storagePath,
    downloadUrl: value.downloadUrl,
    fileName: value.fileName,
    sizeBytes: value.sizeBytes,
    mimeType: value.mimeType,
    probe,
    createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : 0,
    importedAt: typeof value.importedAt === 'number' && Number.isFinite(value.importedAt) ? value.importedAt : 0,
  };
}

/**
 * Parses a stored payload into an index. Corrupt JSON, a wrong-shaped
 * payload, or junk entries all degrade gracefully: bad entries are dropped
 * one by one, a bad payload yields an empty index. Never throws.
 */
export function parseDedupeIndex(raw: string | null): DedupeIndex {
  if (!raw) return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (!isRecord(data)) return {};
    const entries = isRecord(data.entries) ? data.entries : data;
    const index: DedupeIndex = {};
    for (const [hash, value] of Object.entries(entries)) {
      const entry = parseEntry(value);
      if (entry) index[hash] = entry;
    }
    return index;
  } catch {
    return {};
  }
}

export function serializeDedupeIndex(index: DedupeIndex): string {
  return JSON.stringify({ version: INDEX_VERSION, entries: index });
}

/** Loads the user's index. Any storage failure reads as an empty index. */
export function loadDedupeIndex(uid: string, storage: KeyValueStorage | null = defaultStorage()): DedupeIndex {
  if (!storage) return {};
  try {
    return parseDedupeIndex(storage.getItem(dedupeStorageKey(uid)));
  } catch {
    return {};
  }
}

/**
 * Persists the index. Returns false (never throws) when storage is
 * unavailable or full — dedupe is an optimisation, not a requirement.
 */
export function saveDedupeIndex(uid: string, index: DedupeIndex, storage: KeyValueStorage | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(dedupeStorageKey(uid), serializeDedupeIndex(index));
    return true;
  } catch {
    return false;
  }
}

/** The dedupe lookup: the existing entry for this content hash, or null on a miss. */
export function lookupDedupedEntry(uid: string, contentHash: string, storage?: KeyValueStorage | null): DedupeEntry | null {
  const index = loadDedupeIndex(uid, storage);
  return index[contentHash] ?? null;
}

/** The probe-cache lookup: the stored probe result for this content hash, or null on a miss. */
export function getCachedProbe(uid: string, contentHash: string, storage?: KeyValueStorage | null): ProbedMedia | null {
  return lookupDedupedEntry(uid, contentHash, storage)?.probe ?? null;
}

/**
 * Records a completed import under its content hash, evicting the oldest
 * entries beyond MAX_DEDUPE_ENTRIES. Fail-soft: returns whether the entry
 * was persisted; a false return only costs future dedupe, never the
 * import that just succeeded.
 */
export function recordDedupedEntry(
  uid: string,
  contentHash: string,
  entry: DedupeEntry,
  storage?: KeyValueStorage | null,
): boolean {
  const store = storage === undefined ? defaultStorage() : storage;
  const index = loadDedupeIndex(uid, store);
  index[contentHash] = entry;
  const hashes = Object.keys(index);
  if (hashes.length > MAX_DEDUPE_ENTRIES) {
    const byAge = hashes.sort((a, b) => index[a].importedAt - index[b].importedAt);
    for (const stale of byAge.slice(0, hashes.length - MAX_DEDUPE_ENTRIES)) delete index[stale];
  }
  return saveDedupeIndex(uid, index, store);
}

/** Rebuilds the existing MediaAsset a dedupe hit resolves to — no upload, no probe. */
export function assetFromDedupeEntry(entry: DedupeEntry): MediaAsset {
  return {
    id: entry.assetId,
    kind: entry.probe.kind,
    storageUrl: entry.downloadUrl,
    fileName: entry.fileName,
    sizeBytes: entry.sizeBytes,
    mimeType: entry.mimeType,
    durationSeconds: entry.probe.durationSeconds,
    width: entry.probe.width,
    height: entry.probe.height,
    createdAt: entry.createdAt,
  };
}
