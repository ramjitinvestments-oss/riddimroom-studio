/**
 * RiddimRoom Studio — media probing.
 *
 * Reads intrinsic metadata (duration/width/height) out of a File/Blob
 * client-side before it becomes a `MediaAsset`, using the same
 * HTMLVideoElement/HTMLImageElement/HTMLAudioElement "load into an element,
 * read its natural dimensions/duration, then discard the element" technique
 * riddimroom-caption and EventCam both use for upload previews. No network
 * or Firebase dependency — pure browser API usage against an object URL.
 *
 * Reliability fix (found via live browser testing, not source inspection —
 * two different real-world MP4s both hung the upload UI at 0% forever with
 * no error): a bare, never-appended `document.createElement('video')` does
 * not reliably fire `loadedmetadata` in every Chrome build/codec
 * combination — some media pipelines only fully activate once the element
 * is actually connected to the document. `probeVideo`/`probeAudio` now
 * attach their element off-screen to `document.body` while probing (removed
 * immediately after), and every probe now has a hard timeout that rejects
 * with a real, user-visible error instead of hanging indefinitely — a
 * probe that can never fail is, in practice, a probe that can hang forever.
 */

import type { MediaAssetKind } from '../../types/timeline';

export interface ProbedMedia {
  kind: MediaAssetKind;
  durationSeconds?: number;
  width?: number;
  height?: number;
}

export function mediaKindForMimeType(mimeType: string): MediaAssetKind | null {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  return null;
}

const PROBE_TIMEOUT_MS = 12_000;

/** Probes a video file's duration + natural pixel dimensions. */
function probeVideo(file: Blob): Promise<Pick<ProbedMedia, 'durationSeconds' | 'width' | 'height'>> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    // Off-screen but genuinely connected to the document — see header
    // comment. display:none is deliberately avoided (some browsers suspend
    // media decoding for display:none elements too).
    video.style.position = 'fixed';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    document.body.appendChild(video);

    let settled = false;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
      if (video.parentNode) video.parentNode.removeChild(video);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      cleanup();
      fn();
    };

    const timeoutId = window.setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            'Timed out reading this video\'s metadata (waited 12s). The file may use an unusual codec/container — try re-exporting it as standard H.264 MP4.',
          ),
        ),
      );
    }, PROBE_TIMEOUT_MS);

    const finish = () => {
      // Some real-world MP4s (notably ones re-muxed by phone apps/AI
      // generators) report duration as Infinity/NaN until the browser is
      // forced to seek — the standard workaround is a large-then-zero seek.
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          settle(() =>
            resolve({
              durationSeconds: Number.isFinite(video.duration) ? video.duration : undefined,
              width: video.videoWidth || undefined,
              height: video.videoHeight || undefined,
            }),
          );
        };
        video.addEventListener('seeked', onSeeked);
        try {
          video.currentTime = 1e9;
        } catch {
          video.removeEventListener('seeked', onSeeked);
          settle(() =>
            resolve({ durationSeconds: undefined, width: video.videoWidth || undefined, height: video.videoHeight || undefined }),
          );
        }
        return;
      }
      settle(() =>
        resolve({ durationSeconds: video.duration, width: video.videoWidth || undefined, height: video.videoHeight || undefined }),
      );
    };

    video.onloadedmetadata = finish;
    // Fallback: some codec/container combinations fire loadeddata without a
    // preceding loadedmetadata event ever reaching this listener reliably.
    video.onloadeddata = finish;
    video.onerror = () => {
      settle(() => reject(new Error('Could not read video metadata — the file may be corrupt or in an unsupported format.')));
    };
    video.src = url;
  });
}

function probeImage(file: Blob): Promise<Pick<ProbedMedia, 'width' | 'height'>> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    let settled = false;
    const cleanup = () => URL.revokeObjectURL(url);
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      cleanup();
      fn();
    };
    const timeoutId = window.setTimeout(() => {
      settle(() => reject(new Error('Timed out reading this image\'s dimensions (waited 12s). The file may be corrupt.')));
    }, PROBE_TIMEOUT_MS);
    img.onload = () => {
      settle(() => resolve({ width: img.naturalWidth || undefined, height: img.naturalHeight || undefined }));
    };
    img.onerror = () => {
      settle(() => reject(new Error('Could not read image dimensions — the file may be corrupt or in an unsupported format.')));
    };
    img.src = url;
  });
}

function probeAudio(file: Blob): Promise<Pick<ProbedMedia, 'durationSeconds'>> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.style.position = 'fixed';
    audio.style.opacity = '0';
    audio.style.pointerEvents = 'none';
    document.body.appendChild(audio);

    let settled = false;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      audio.removeAttribute('src');
      audio.load();
      if (audio.parentNode) audio.parentNode.removeChild(audio);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      cleanup();
      fn();
    };
    const timeoutId = window.setTimeout(() => {
      settle(() => reject(new Error('Timed out reading this audio file\'s metadata (waited 12s). The file may use an unusual codec/container.')));
    }, PROBE_TIMEOUT_MS);

    const finish = () => {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
        const onSeeked = () => {
          audio.removeEventListener('seeked', onSeeked);
          settle(() => resolve({ durationSeconds: Number.isFinite(audio.duration) ? audio.duration : undefined }));
        };
        audio.addEventListener('seeked', onSeeked);
        try {
          audio.currentTime = 1e9;
        } catch {
          audio.removeEventListener('seeked', onSeeked);
          settle(() => resolve({ durationSeconds: undefined }));
        }
        return;
      }
      settle(() => resolve({ durationSeconds: audio.duration }));
    };

    audio.onloadedmetadata = finish;
    audio.onloadeddata = finish;
    audio.onerror = () => {
      settle(() => reject(new Error('Could not read audio metadata — the file may be corrupt or in an unsupported format.')));
    };
    audio.src = url;
  });
}

/** Probes a File/Blob's kind and intrinsic metadata. Throws if the mime type isn't image/video/audio. */
export async function probeMediaFile(file: File | Blob, mimeType: string): Promise<ProbedMedia> {
  const kind = mediaKindForMimeType(mimeType);
  if (!kind) {
    throw new Error(`Unsupported media type "${mimeType}". Only image/*, video/*, and audio/* are accepted.`);
  }
  if (kind === 'video') return { kind, ...(await probeVideo(file)) };
  if (kind === 'image') return { kind, ...(await probeImage(file)) };
  return { kind, ...(await probeAudio(file)) };
}
