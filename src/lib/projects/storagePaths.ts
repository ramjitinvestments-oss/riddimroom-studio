/**
 * RiddimRoom Studio — storage-path helpers for project deletion.
 *
 * Project documents never store a Firebase Storage path directly — each
 * `MediaAsset` carries a `storageUrl` (the resolved download URL). Storage
 * cleanup on delete therefore has to recover the path from that URL.
 *
 * Everything in this module is pure (no Firebase imports) so the
 * exclusivity math is unit-testable and the URL parsing can't touch any
 * network or app state.
 */

/**
 * Recovers a Firebase Storage path from a download URL.
 *
 * Uploaded assets get URLs shaped like
 * `https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{encodeURIComponent(path)}?alt=media&token=…`
 * — the path is the URL-decoded segment after `/o/`. `gs://{bucket}/{path}`
 * is also understood. Anything else (data: URLs from saved posters,
 * blob: object URLs, relative paths, empty/whitespace strings) returns
 * `null` so callers skip it — no asset, no cleanup.
 */
export function storagePathFromDownloadUrl(url: string): string | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (trimmed.startsWith('gs://')) {
    const withoutScheme = trimmed.slice('gs://'.length);
    const slash = withoutScheme.indexOf('/');
    if (slash <= 0) return null;
    const path = withoutScheme.slice(slash + 1);
    return path ? path : null;
  }
  const marker = '/o/';
  const markerIndex = trimmed.indexOf(marker);
  if (markerIndex < 0) return null;
  let segment = trimmed.slice(markerIndex + marker.length);
  const queryIndex = segment.indexOf('?');
  if (queryIndex >= 0) segment = segment.slice(0, queryIndex);
  const hashIndex = segment.indexOf('#');
  if (hashIndex >= 0) segment = segment.slice(0, hashIndex);
  if (!segment) return null;
  try {
    const decoded = decodeURIComponent(segment);
    return decoded ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Collects the unique storage paths referenced by a raw/serialized project
 * document's `mediaAssets` pool. Defensive by design: the document may be
 * hand-edited in the Firebase console or from an older client — anything
 * malformed yields an empty contribution, never a throw.
 */
export function collectProjectStoragePaths(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  const assets = record.mediaAssets;
  if (!assets || typeof assets !== 'object') return [];
  const paths = new Set<string>();
  for (const value of Object.values(assets as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const storageUrl = (value as Record<string, unknown>).storageUrl;
    const path = storagePathFromDownloadUrl(typeof storageUrl === 'string' ? storageUrl : '');
    if (path) paths.add(path);
  }
  return [...paths];
}

/**
 * Pure exclusivity check for batch-safe storage cleanup.
 *
 * `batchPaths` — every storage path referenced by the projects being
 * deleted. `retainedPaths` — every storage path referenced by any project
 * NOT in the batch. Returns the paths that are safe to delete: referenced
 * only by the batch, deduped.
 *
 * Duplicated projects can share one storage object — a path still
 * referenced by a surviving project must never be deleted, which is why
 * the caller builds `retainedPaths` from projects outside the batch.
 */
export function computePathsToDelete(
  batchPaths: Iterable<string>,
  retainedPaths: Iterable<string>,
): string[] {
  const retained = new Set(retainedPaths);
  const toDelete = new Set<string>();
  for (const path of batchPaths) {
    if (path && !retained.has(path)) toDelete.add(path);
  }
  return [...toDelete];
}
