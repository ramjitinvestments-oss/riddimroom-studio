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
import { probeMediaFile, mediaKindForMimeType } from './probe';

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
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'file';
}

/**
 * Uploads one file end to end: probe metadata -> upload bytes with progress
 * -> resolve a download URL -> build the `MediaAsset` the timeline
 * foundation expects. Does not touch React or Firestore/Project state —
 * callers (MediaImportPanel, ProjectContext) decide what to do with the
 * resulting MediaAsset. Kept as a single async function (not a class) so a
 * caller-driven retry is just "call this again with the same assetId".
 */
export async function uploadMediaFile(options: UploadMediaOptions): Promise<UploadMediaResult> {
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
  let probed: Awaited<ReturnType<typeof probeMediaFile>>;
  try {
    probed = await probeMediaFile(file, mimeType);
  } catch (err) {
    const kind = mediaKindForMimeType(mimeType);
    if (!kind) throw err; // genuinely unsupported type — still a real, fatal error
    probed = { kind, durationSeconds: undefined, width: undefined, height: undefined };
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

  return { asset, storagePath };
}
