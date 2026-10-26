/**
 * RiddimRoom Studio — Firebase Storage upload.
 *
 * Uploads a validated, probed file to `users/{uid}/media/{assetId}/{filename}`
 * — the exact path shape `storage.rules` already scopes to
 * `request.auth.uid == userId` (owner read/write, everything else denied).
 * Exercises that rule end-to-end for the first time in this codebase (it
 * was scaffolded in Step 1 but never used until this build step).
 *
 * Uses `uploadBytesResumable` (not `uploadBytes`) specifically so upload
 * progress and pause/resume/cancel are available to the UI, and so a
 * network blip mid-upload surfaces as a retryable `state_changed` error
 * rather than an opaque failed promise.
 *
 * WS-S1 (upload speed): before any bytes move, the file's sampled content
 * hash (fileHash.ts) is checked against the per-user dedupe registry
 * (dedupe.ts). A hit resolves to the EXISTING asset/storage object with
 * no re-upload and no re-probe — instantly, across sessions. A miss
 * uploads exactly as before and records the new asset + its probe result
 * in the registry, and the probe itself goes through the hash-keyed
 * probe cache (probe.ts) so the panel's pre-upload probe and this
 * function's probe never both pay for the same content twice. Hashing,
 * registry, and cache are all fail-soft: any failure degrades to the
 * plain pre-WS-S1 upload path, never to a blocked import.
 */

import {
  ref,
  uploadBytesResumable,
  getDownloadURL,
  type UploadTaskSnapshot,
} from 'firebase/storage';
import { storage } from '../firebase';
import { generateTimelineId } from '../timeline/utils';
import type { MediaAsset, MediaAssetKind } from '../../types/timeline';
import { probeMediaFileCached, primeProbeCache, mediaKindForMimeType, type ProbedMedia } from './probe';
import { hashFileContent } from './fileHash';
import { lookupDedupedEntry, getCachedProbe, recordDedupedEntry, assetFromDedupeEntry } from './dedupe';

export interface UploadProgressEvent {
  bytesTransferred: number;
  totalBytes: number;
  fraction: number;
}

export interface UploadMediaOptions {
  uid: string;
  file: File;
  onProgress?: (event: UploadProgressEvent) => void;
  /** Internal — set on retry so the same storage path is reused instead of orphaning a partial object. */
  assetId?: string;
}

export interface UploadMediaResult {
  asset: MediaAsset;
  storagePath: string;
  /** WS-S1 — true when the result resolved to an existing asset via the dedupe registry (no bytes were uploaded). */
  deduped?: boolean;
  /** WS-S1 — the file's sampled content hash, when hashing succeeded. */
  contentHash?: string;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'file';
}

/**
 * In-flight uploads keyed by `{uid}:{contentHash}` — two imports of the
 * same content started in the same batch (e.g. the same file picked for
 * the main track and again as an overlay) join ONE upload instead of
 * racing two uploads of identical bytes to two storage objects.
 */
const inFlightUploads = new Map<string, Promise<UploadMediaResult>>();

/**
 * Uploads one file end to end: WS-S1 hash + dedupe check -> probe metadata
 * -> upload bytes with progress -> resolve a download URL -> build the
 * `MediaAsset` the timeline foundation expects -> record in the dedupe
 * registry. Does not touch React or Firestore/Project state — callers
 * (MediaImportPanel, ProjectContext) decide what to do with the resulting
 * MediaAsset. Kept as a single async function (not a class) so a
 * caller-driven retry is just "call this again with the same assetId".
 */
export async function uploadMediaFile(options: UploadMediaOptions): Promise<UploadMediaResult> {
  const { uid, file, onProgress } = options;

  // WS-S1 step 1 — sampled content hash. Fail-soft: if hashing is
  // unavailable for any reason the import proceeds exactly as it did
  // before WS-S1, just without dedupe.
  let contentHash: string | null = null;
  try {
    contentHash = await hashFileContent(file);
  } catch {
    contentHash = null;
  }

  if (contentHash) {
    // WS-S1 step 2 — dedupe. A registry hit resolves to the EXISTING
    // asset/storage object: no upload, no probe. (A corrupt or stale
    // index degrades to a miss inside dedupe.ts, never to an error here.)
    const existing = lookupDedupedEntry(uid, contentHash);
    if (existing) {
      primeProbeCache(contentHash, existing.probe);
      if (onProgress) {
        onProgress({ bytesTransferred: file.size, totalBytes: file.size, fraction: 1 });
      }
      return { asset: assetFromDedupeEntry(existing), storagePath: existing.storagePath, deduped: true, contentHash };
    }

    // Same content already uploading in this session — join that upload
    // instead of starting a duplicate. If it fails, fall through and run
    // this call's own upload (per-file error/retry semantics preserved).
    const flightKey = `${uid}:${contentHash}`;
    const inFlight = inFlightUploads.get(flightKey);
    if (inFlight) {
      try {
        const joined = await inFlight;
        if (onProgress) {
          onProgress({ bytesTransferred: file.size, totalBytes: file.size, fraction: 1 });
        }
        return { ...joined, deduped: true, contentHash };
      } catch {
        /* the joined upload failed — run our own below */
      }
    }

    const own = performUpload(options, contentHash);
    inFlightUploads.set(flightKey, own);
    try {
      return await own;
    } finally {
      if (inFlightUploads.get(flightKey) === own) inFlightUploads.delete(flightKey);
    }
  }

  return performUpload(options, null);
}

/** The pre-WS-S1 upload path, plus registry recording + probe-cache plumbing. */
async function performUpload(options: UploadMediaOptions, contentHash: string | null): Promise<UploadMediaResult> {
  const { uid, file, onProgress } = options;
  const assetId = options.assetId ?? generateTimelineId('asset');
  const mimeType = file.type || 'application/octet-stream';

  // Metadata probing (duration/dimensions) is best-effort. Found via live
  // browser testing: some real-world video files never fire a usable
  // metadata event in every browser/codec/extension combination (probe.ts
  // now times out after 12s instead of hanging forever) — but a probe
  // quirk on THIS file must never block the user from getting real bytes
  // into Storage and onto the timeline. Fall back to safe unknown-duration
  // defaults (appendMediaToTimeline already treats a missing duration as
  // 5s) rather than aborting the whole upload.
  //
  // WS-S1: the probe goes through the hash-keyed caches first — the
  // persistent registry's stored probe result (cross-session), then the
  // in-memory probe cache (which the panel's pre-upload trim-gate probe
  // already warmed for this exact content).
  let probed: ProbedMedia;
  const cachedProbe = contentHash ? getCachedProbe(uid, contentHash) : null;
  if (cachedProbe) {
    probed = cachedProbe;
  } else {
    try {
      probed = await probeMediaFileCached(file, mimeType, contentHash);
    } catch (err) {
      const kind = mediaKindForMimeType(mimeType);
      if (!kind) throw err; // genuinely unsupported type — still a real, fatal error
      probed = { kind, durationSeconds: undefined, width: undefined, height: undefined };
    }
  }

  const storagePath = `users/${uid}/media/${assetId}/${sanitizeFileName(file.name)}`;
  const storageRef = ref(storage, storagePath);

  const downloadUrl = await new Promise<string>((resolve, reject) => {
    const task = uploadBytesResumable(storageRef, file, { contentType: mimeType });
    task.on(
      'state_changed',
      (snapshot: UploadTaskSnapshot) => {
        if (onProgress) {
          onProgress({
            bytesTransferred: snapshot.bytesTransferred,
            totalBytes: snapshot.totalBytes,
            fraction: snapshot.totalBytes > 0 ? snapshot.bytesTransferred / snapshot.totalBytes : 0,
          });
        }
      },
      (error) => {
        // Surfaced verbatim to the caller — MediaImportPanel maps this to a
        // retry affordance rather than swallowing it, per the "upload
        // error/retry states" requirement.
        reject(error);
      },
      async () => {
        try {
          const url = await getDownloadURL(task.snapshot.ref);
          resolve(url);
        } catch (err) {
          reject(err);
        }
      },
    );
  });

  const asset: MediaAsset = {
    id: assetId,
    kind: probed.kind as MediaAssetKind,
    storageUrl: downloadUrl,
    fileName: file.name,
    sizeBytes: file.size,
    mimeType,
    durationSeconds: probed.durationSeconds,
    width: probed.width,
    height: probed.height,
    createdAt: Date.now(),
  };

  // WS-S1 step 3 — record the completed import so the next import of this
  // content (this session or any later one) dedupes against it, probe
  // result included. Fail-soft inside recordDedupedEntry by design.
  if (contentHash) {
    primeProbeCache(contentHash, probed);
    recordDedupedEntry(uid, contentHash, {
      assetId,
      storagePath,
      downloadUrl,
      fileName: file.name,
      sizeBytes: file.size,
      mimeType,
      probe: probed,
      createdAt: asset.createdAt,
      importedAt: Date.now(),
    });
  }

  return { asset, storagePath, deduped: false, ...(contentHash ? { contentHash } : {}) };
}
