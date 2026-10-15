import { describe, it, expect } from 'vitest';
import {
  storagePathFromDownloadUrl,
  collectProjectStoragePaths,
  computePathsToDelete,
} from './storagePaths';

const firebaseUrl = (path: string, bucket = 'riddimroom-studio.firebasestorage.app') =>
  `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}?alt=media&token=abc-123`;

describe('storagePathFromDownloadUrl', () => {
  it('recovers the decoded path from a Firebase download URL', () => {
    expect(storagePathFromDownloadUrl(firebaseUrl('users/u1/media/asset_1/clip.mp4'))).toBe(
      'users/u1/media/asset_1/clip.mp4',
    );
  });

  it('handles paths with spaces and unicode', () => {
    const path = 'users/u1/media/asset_2/my clip — final.mp4';
    expect(storagePathFromDownloadUrl(firebaseUrl(path))).toBe(path);
  });

  it('works without a query string', () => {
    const url = `https://firebasestorage.googleapis.com/v0/b/bkt/o/${encodeURIComponent('users/u1/media/a/x.png')}`;
    expect(storagePathFromDownloadUrl(url)).toBe('users/u1/media/a/x.png');
  });

  it('parses gs:// URLs', () => {
    expect(storagePathFromDownloadUrl('gs://my-bucket/users/u1/media/a/x.png')).toBe(
      'users/u1/media/a/x.png',
    );
  });

  it('returns null for non-storage URLs', () => {
    expect(storagePathFromDownloadUrl('data:image/jpeg;base64,/9j/abc')).toBeNull();
    expect(storagePathFromDownloadUrl('blob:https://example.com/1234')).toBeNull();
    expect(storagePathFromDownloadUrl('/local/asset.png')).toBeNull();
    expect(storagePathFromDownloadUrl('')).toBeNull();
    expect(storagePathFromDownloadUrl('   ')).toBeNull();
  });
});

describe('collectProjectStoragePaths', () => {
  it('collects unique paths from the mediaAssets pool', () => {
    const data = {
      mediaAssets: {
        a1: { storageUrl: firebaseUrl('users/u1/media/a1/clip.mp4') },
        a2: { storageUrl: firebaseUrl('users/u1/media/a2/song.mp3') },
        // Same object referenced twice (duplicated item) — one path.
        a3: { storageUrl: firebaseUrl('users/u1/media/a1/clip.mp4') },
      },
    };
    expect(collectProjectStoragePaths(data).sort()).toEqual([
      'users/u1/media/a1/clip.mp4',
      'users/u1/media/a2/song.mp3',
    ]);
  });

  it('skips assets without a parseable storage URL', () => {
    const data = {
      mediaAssets: {
        poster: { storageUrl: 'data:image/png;base64,xyz' },
        broken: { storageUrl: '' },
        missing: {},
      },
    };
    expect(collectProjectStoragePaths(data)).toEqual([]);
  });

  it('tolerates malformed documents', () => {
    expect(collectProjectStoragePaths(null)).toEqual([]);
    expect(collectProjectStoragePaths(undefined)).toEqual([]);
    expect(collectProjectStoragePaths('nope')).toEqual([]);
    expect(collectProjectStoragePaths({})).toEqual([]);
    expect(collectProjectStoragePaths({ mediaAssets: null })).toEqual([]);
    expect(collectProjectStoragePaths({ mediaAssets: { a: null, b: 'x' } })).toEqual([]);
  });
});

describe('computePathsToDelete (exclusivity)', () => {
  it('returns batch paths no surviving project references', () => {
    expect(computePathsToDelete(['a', 'b', 'c'], ['b']).sort()).toEqual(['a', 'c']);
  });

  it('keeps paths shared with a surviving project (duplicate shares bytes)', () => {
    // Project being deleted and a kept project both reference 'shared'.
    expect(computePathsToDelete(['shared', 'own'], ['shared'])).toEqual(['own']);
  });

  it('batch: a path shared by two projects in the batch is deleted once', () => {
    // 'shared' is referenced only inside the batch (both deleters) — no
    // survivor references it, so it is safe to delete, exactly once.
    const batchPaths = ['shared', 'a-only', 'shared', 'b-only'];
    expect(computePathsToDelete(batchPaths, []).sort()).toEqual(['a-only', 'b-only', 'shared']);
  });

  it('batch: a path also referenced outside the batch is always kept', () => {
    const batchPaths = ['in-both', 'batch-only'];
    const retained = ['in-both', 'unrelated'];
    expect(computePathsToDelete(batchPaths, retained)).toEqual(['batch-only']);
  });

  it('empty cases', () => {
    expect(computePathsToDelete([], ['a'])).toEqual([]);
    expect(computePathsToDelete(['a'], ['a'])).toEqual([]);
    expect(computePathsToDelete([], [])).toEqual([]);
  });
});
