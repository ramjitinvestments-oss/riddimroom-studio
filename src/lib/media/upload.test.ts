import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * WS-S1 upload integration tests. Firebase Storage is mocked at the
 * module boundary: `uploadBytesResumable` counts its calls and completes
 * (or fails, on demand) via the same state_changed callback shape the
 * real SDK uses. Probing genuinely fails in the node test environment
 * (no DOM media elements), which exercises upload.ts's documented
 * best-effort probe fallback — image files still upload with kind-only
 * probe defaults.
 */

const mockState = vi.hoisted(() => ({ uploadCalls: 0, failNextUpload: false }));

vi.mock('firebase/storage', () => ({
  ref: (_storage: unknown, path: string) => ({ path }),
  getDownloadURL: async (refObj: { path: string }) => `https://example.test/${refObj.path}`,
  uploadBytesResumable: (refObj: { path: string }) => {
    mockState.uploadCalls += 1;
    const shouldFail = mockState.failNextUpload;
    mockState.failNextUpload = false;
    return {
      snapshot: { ref: refObj },
      on: (
        _event: string,
        _next: unknown,
        error: (err: Error) => void,
        complete: () => void,
      ) => {
        queueMicrotask(() => {
          if (shouldFail) error(new Error('simulated upload failure'));
          else complete();
        });
      },
    };
  },
}));

vi.mock('../firebase', () => ({ storage: { mock: true } }));

import { uploadMediaFile } from './upload';
import { hashFileContent } from './fileHash';
import { lookupDedupedEntry, recordDedupedEntry, dedupeStorageKey, type DedupeEntry } from './dedupe';
import { clearProbeCache } from './probe';

function stubLocalStorage() {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    length: 0,
  } as Storage;
  return store;
}

function pngFile(content: string, name = 'pic.png'): File {
  return new File([new TextEncoder().encode(content)], name, { type: 'image/png' });
}

beforeEach(() => {
  stubLocalStorage();
  clearProbeCache();
  mockState.uploadCalls = 0;
  mockState.failNextUpload = false;
});

describe('uploadMediaFile — WS-S1 dedupe', () => {
  it('a first import uploads once and records the asset in the registry', async () => {
    const uid = 'u-first';
    const file = pngFile('first-import-bytes');
    const result = await uploadMediaFile({ uid, file });
    expect(mockState.uploadCalls).toBe(1);
    expect(result.deduped).toBe(false);
    expect(result.storagePath).toBe(`users/${uid}/media/${result.asset.id}/pic.png`);
    expect(result.asset.storageUrl).toBe(`https://example.test/${result.storagePath}`);
    expect(result.asset.kind).toBe('image');

    const hash = await hashFileContent(file);
    const recorded = lookupDedupedEntry(uid, hash);
    expect(recorded).not.toBeNull();
    expect(recorded!.assetId).toBe(result.asset.id);
    expect(recorded!.storagePath).toBe(result.storagePath);
  });

  it('re-importing the same content dedupes: NO second upload, existing asset returned', async () => {
    const uid = 'u-reimport';
    const first = await uploadMediaFile({ uid, file: pngFile('same-bytes') });
    expect(mockState.uploadCalls).toBe(1);

    // A brand-new File object with identical bytes (e.g. picked again
    // from disk in a later session) must resolve to the existing asset.
    const second = await uploadMediaFile({ uid, file: pngFile('same-bytes') });
    expect(mockState.uploadCalls).toBe(1); // still one — no re-upload
    expect(second.deduped).toBe(true);
    expect(second.asset.id).toBe(first.asset.id);
    expect(second.asset.storageUrl).toBe(first.asset.storageUrl);
    expect(second.storagePath).toBe(first.storagePath);
  });

  it('different content uploads separately and gets its own asset', async () => {
    const uid = 'u-distinct';
    const a = await uploadMediaFile({ uid, file: pngFile('content-A') });
    const b = await uploadMediaFile({ uid, file: pngFile('content-B') });
    expect(mockState.uploadCalls).toBe(2);
    expect(b.deduped).toBe(false);
    expect(b.asset.id).not.toBe(a.asset.id);
  });

  it('a pre-seeded registry entry resolves with zero uploads and a full progress event', async () => {
    const uid = 'u-preseeded';
    const file = pngFile('already-up-there');
    const hash = await hashFileContent(file);
    const seeded: DedupeEntry = {
      assetId: 'asset_existing',
      storagePath: `users/${uid}/media/asset_existing/pic.png`,
      downloadUrl: 'https://example.test/existing.png',
      fileName: 'pic.png',
      sizeBytes: file.size,
      mimeType: 'image/png',
      probe: { kind: 'image', width: 800, height: 600 },
      createdAt: 4242,
      importedAt: 5000,
    };
    expect(recordDedupedEntry(uid, hash, seeded)).toBe(true);

    const progress: number[] = [];
    const result = await uploadMediaFile({ uid, file, onProgress: (e) => progress.push(e.fraction) });
    expect(mockState.uploadCalls).toBe(0);
    expect(result.deduped).toBe(true);
    expect(result.asset.id).toBe('asset_existing');
    expect(result.asset.width).toBe(800);
    expect(result.asset.createdAt).toBe(4242);
    expect(progress).toEqual([1]);
  });

  it('dedupe is per-user: the same content under another uid uploads fresh', async () => {
    const file = pngFile('shared-bytes');
    await uploadMediaFile({ uid: 'u-one', file });
    const other = await uploadMediaFile({ uid: 'u-two', file: pngFile('shared-bytes') });
    expect(mockState.uploadCalls).toBe(2);
    expect(other.deduped).toBe(false);
  });

  it('a failed upload records nothing, and the retry uploads + records', async () => {
    const uid = 'u-retry';
    const file = pngFile('flaky-bytes');
    mockState.failNextUpload = true;
    await expect(uploadMediaFile({ uid, file })).rejects.toThrow('simulated upload failure');
    const hash = await hashFileContent(file);
    expect(lookupDedupedEntry(uid, hash)).toBeNull();

    const retried = await uploadMediaFile({ uid, file });
    expect(retried.deduped).toBe(false);
    expect(lookupDedupedEntry(uid, hash)).not.toBeNull();
  });

  it('a corrupt registry falls back to a normal upload and is healed', async () => {
    const uid = 'u-corrupt';
    localStorage.setItem(dedupeStorageKey(uid), '{{{corrupt');
    const result = await uploadMediaFile({ uid, file: pngFile('corrupt-index-bytes') });
    expect(mockState.uploadCalls).toBe(1);
    expect(result.deduped).toBe(false);
    // Registry now holds a valid entry for this content.
    const hash = await hashFileContent(pngFile('corrupt-index-bytes'));
    expect(lookupDedupedEntry(uid, hash)?.assetId).toBe(result.asset.id);
  });
});
