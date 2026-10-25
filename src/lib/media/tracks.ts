/**
 * The real-music pack for Viral Promo — actual recordings by an
 * actual artist, replacing the synthesized loops as the promo
 * default (owner's call: the loops sounded "very very generic").
 *
 * Every track here was verified one by one during curation
 * (2026-10-24): title, artist, license and file all read from
 * Wikimedia Commons' own metadata. All are Kevin MacLeod recordings
 * under CC BY 3.0 — free for commercial use WITH attribution, which
 * is why the credit travels with the track: it shows in the promo
 * music row and in the producer's report of any export that uses it.
 * The files are served by upload.wikimedia.org with
 * `Access-Control-Allow-Origin: *` (verified), so the browser can
 * fetch them for the build; the fetched file is uploaded into the
 * project once, and exports use the project's stored copy.
 *
 * If a fetch ever fails, the caller falls back to the built-in
 * synthesized loop — a promo is never blocked by its music.
 */
import type { PromoSkinId } from '../promo/recipes';

export interface PackTrack {
  id: string;
  title: string;
  artist: string;
  license: string;
  /** Clean canonical file URL (no tracking parameters). */
  url: string;
  /** The name the file carries once uploaded into a project — the
   * producer's report matches on it to print the credit. */
  fileName: string;
  credit: string;
}

function macleod(id: string, title: string, url: string): PackTrack {
  return {
    id,
    title,
    artist: 'Kevin MacLeod',
    license: 'CC BY 3.0',
    url,
    fileName: `pack-${id}-kevin-macleod.mp3`,
    credit: `“${title}” by Kevin MacLeod — CC BY 3.0 (via Wikimedia Commons)`,
  };
}

export const PROMO_PACK_TRACKS: Record<PromoSkinId, PackTrack> = {
  // Reggae groove for the dancehall skin — the roots of the sound.
  'dancehall-raw': macleod(
    'tea-roots',
    'Tea Roots',
    'https://upload.wikimedia.org/wikipedia/commons/3/38/Tea_Roots_%28ISRC_USUAN1100472%29.mp3',
  ),
  // Island party groove for the soca skin (a real soca recording
  // under a free license could not be sourced at premium quality —
  // this is the closest real island energy, and the app says so).
  'soca-shine': macleod(
    'beach-party',
    'Beach Party',
    'https://upload.wikimedia.org/wikipedia/commons/7/72/Beach_Party_%28ISRC_USUAN1100613%29.mp3',
  ),
  'gospel-light': macleod(
    'amazing-grace-2011',
    'Amazing Grace 2011',
    'https://upload.wikimedia.org/wikipedia/commons/3/36/Amazing_Grace_2011_%28ISRC_USUAN1100820%29.mp3',
  ),
  'corporate-clean': macleod(
    'carefree',
    'Carefree',
    'https://upload.wikimedia.org/wikipedia/commons/f/f5/Carefree_%28ISRC_USUAN1400037%29.mp3',
  ),
};

export function packTrackForSkin(skin: PromoSkinId): PackTrack {
  return PROMO_PACK_TRACKS[skin];
}

/** The CC credit for a project media file name, when it is a pack track. */
export function creditForFileName(fileName: string): string | null {
  for (const track of Object.values(PROMO_PACK_TRACKS)) {
    if (track.fileName === fileName) return track.credit;
  }
  return null;
}

/** Fetch a pack track as a File ready for the project upload pipeline. */
export async function fetchPackTrackFile(track: PackTrack): Promise<File> {
  const res = await fetch(track.url);
  if (!res.ok) throw new Error(`Pack track fetch failed (HTTP ${res.status}).`);
  const blob = await res.blob();
  return new File([blob], track.fileName, { type: 'audio/mpeg' });
}

/**
 * Best-effort duration probe for an audio File (seconds), via an
 * off-DOM <audio> element. Used so the fitted music item trims/loops
 * against the track's real length, not a placeholder.
 */
export function probeAudioDurationSeconds(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const audio = new Audio();
      const done = (value: number | null) => {
        URL.revokeObjectURL(url);
        resolve(value);
      };
      audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
      audio.onerror = () => done(null);
      audio.src = url;
    } catch {
      resolve(null);
    }
  });
}
