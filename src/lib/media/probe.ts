/**
 * RiddimRoom Studio — media probing.
 *
 * Reads intrinsic metadata (duration/width/height) out of a File/Blob
 * client-side before it becomes a `MediaAsset`, using the same
 * HTMLVideoElement/HTMLImageElement/HTMLAudioElement "load into an element,
 * read its natural dimensions/duration, then discard the element" technique
 * riddimroom-caption and EventCam both use for upload previews. No network
 * or Firebase dependency — pure browser API usage against an object URL.
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

/** Probes a video file's duration + natural pixel dimensions by loading it into a detached <video>. */
function probeVideo(file: Blob): Promise<Pick<ProbedMedia, 'durationSeconds' | 'width' | 'height'>> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    const cleanup = () => URL.revokeObjectURL(url);
    video.onloadedmetadata = () => {
      const result = {
        durationSeconds: Number.isFinite(video.duration) ? video.duration : undefined,
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
      };
      cleanup();
      resolve(result);
    };
    video.onerror = () => {
      cleanup();
      reject(new Error('Could not read video metadata — the file may be corrupt or in an unsupported format.'));
    };
    video.src = url;
  });
}

function probeImage(file: Blob): Promise<Pick<ProbedMedia, 'width' | 'height'>> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const cleanup = () => URL.revokeObjectURL(url);
    img.onload = () => {
      const result = { width: img.naturalWidth || undefined, height: img.naturalHeight || undefined };
      cleanup();
      resolve(result);
    };
    img.onerror = () => {
      cleanup();
      reject(new Error('Could not read image dimensions — the file may be corrupt or in an unsupported format.'));
    };
    img.src = url;
  });
}

function probeAudio(file: Blob): Promise<Pick<ProbedMedia, 'durationSeconds'>> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    const cleanup = () => URL.revokeObjectURL(url);
    audio.onloadedmetadata = () => {
      const result = { durationSeconds: Number.isFinite(audio.duration) ? audio.duration : undefined };
      cleanup();
      resolve(result);
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error('Could not read audio metadata — the file may be corrupt or in an unsupported format.'));
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
