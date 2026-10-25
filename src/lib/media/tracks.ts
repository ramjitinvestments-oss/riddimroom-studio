/**
 * The real-music pack for Viral Promo — actual recordings by actual
 * artists, replacing the synthesized loops as the promo default
 * (owner's call: the loops sounded "very very generic").
 *
 * Every track here was verified one by one during curation
 * (2026-10-24/25): title, artist, license and file all read from
 * Wikimedia Commons' own metadata. All are free for commercial use
 * WITH attribution (CC BY), which is why the credit travels with
 * the track: it shows in the promo music row and in the producer's
 * report of any export that uses it. Files are served by
 * upload.wikimedia.org with `Access-Control-Allow-Origin: *`
 * (verified), so the browser can fetch them for the build; the
 * fetched file is uploaded into the project once, and exports use
 * the project's stored copy.
 *
 * Each genre skin owns a SHELF of three tracks; the first is the
 * default, the user can pick another from the shelf in the Beat
 * row. If a fetch ever fails, the caller falls back to the
 * built-in synthesized loop — a promo is never blocked by music.
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

function track(id: string, title: string, artist: string, license: string, url: string, artistSlug: string): PackTrack {
  return {
    id,
    title,
    artist,
    license,
    url,
    fileName: `pack-${id}-${artistSlug}.mp3`,
    credit: `“${title}” by ${artist} — ${license} (via Wikimedia Commons)`,
  };
}

const macleod = (id: string, title: string, url: string): PackTrack =>
  track(id, title, 'Kevin MacLeod', 'CC BY 3.0', url, 'kevin-macleod');

export const PROMO_PACK_SHELVES: Record<PromoSkinId, PackTrack[]> = {
  'dancehall-raw': [
    // Reggae groove — the roots of the dancehall sound.
    macleod('tea-roots', 'Tea Roots', 'https://upload.wikimedia.org/wikipedia/commons/3/38/Tea_Roots_%28ISRC_USUAN1100472%29.mp3'),
    macleod('dub-feral', 'Dub Feral', 'https://upload.wikimedia.org/wikipedia/commons/b/b6/Dub_Feral_%28ISRC_USUAN1200045%29.mp3'),
    macleod('dub-eastern', 'Dub Eastern', 'https://upload.wikimedia.org/wikipedia/commons/3/3e/Dub_Eastern_%28ISRC_USUAN1200046%29.mp3'),
  ],
  'soca-shine': [
    // Island party grooves. (A genuine soca recording under a free
    // license at premium quality could not be sourced — these are
    // the closest real island energies, and the app says so.)
    macleod('beach-party', 'Beach Party', 'https://upload.wikimedia.org/wikipedia/commons/7/72/Beach_Party_%28ISRC_USUAN1100613%29.mp3'),
    macleod('beachfront-celebration', 'Beachfront Celebration', 'https://upload.wikimedia.org/wikipedia/commons/a/a8/Beachfront_Celebration_%28ISRC_USUAN1200022%29.mp3'),
    macleod('enter-the-party', 'Enter the Party', 'https://upload.wikimedia.org/wikipedia/commons/2/22/Enter_the_Party_%28ISRC_USUAN1100240%29.mp3'),
  ],
  'gospel-light': [
    macleod('amazing-grace-2011', 'Amazing Grace 2011', 'https://upload.wikimedia.org/wikipedia/commons/3/36/Amazing_Grace_2011_%28ISRC_USUAN1100820%29.mp3'),
    track('amazing-grace-audionautix', 'Amazing Grace', 'Audionautix', 'CC BY 3.0', 'https://upload.wikimedia.org/wikipedia/commons/9/97/Audionautix-com-ccby-amazinggrace.mp3', 'audionautix'),
    macleod('meditation-impromptu-03', 'Meditation Impromptu 03', 'https://upload.wikimedia.org/wikipedia/commons/9/97/Meditation_Impromptu_03_%28ISRC_USUAN1100161%29.mp3'),
  ],
  'corporate-clean': [
    macleod('carefree', 'Carefree', 'https://upload.wikimedia.org/wikipedia/commons/f/f5/Carefree_%28ISRC_USUAN1400037%29.mp3'),
    macleod('wallpaper', 'Wallpaper', 'https://upload.wikimedia.org/wikipedia/commons/1/1e/Wallpaper_%28ISRC_USUAN1100843%29.mp3'),
    track('inspiring-advertising', 'Inspiring Advertising', 'Rafael Krux', 'CC BY 4.0', 'https://upload.wikimedia.org/wikipedia/commons/3/38/Rafael_Krux_-_Inspiring_Advertising_-_Upbeat_Summer_Corporate_%28cc-by%29_%28filmmusic%29.mp3', 'rafael-krux'),
  ],
};

/** Every pack track, flat (credit lookups, integrity tests). */
export const ALL_PACK_TRACKS: PackTrack[] = Object.values(PROMO_PACK_SHELVES).flat();

/** The skin's chosen track: the shelf pick when valid, else the default. */
export function packTrackForSkin(skin: PromoSkinId, trackId?: string | null): PackTrack {
  const shelf = PROMO_PACK_SHELVES[skin];
  return shelf.find((t) => t.id === trackId) ?? shelf[0];
}

/** The CC credit for a project media file name, when it is a pack track. */
export function creditForFileName(fileName: string): string | null {
  for (const t of ALL_PACK_TRACKS) {
    if (t.fileName === fileName) return t.credit;
  }
  return null;
}

/** Fetch a pack track as a File ready for the project upload pipeline. */
export async function fetchPackTrackFile(t: PackTrack): Promise<File> {
  const res = await fetch(t.url);
  if (!res.ok) throw new Error(`Pack track fetch failed (HTTP ${res.status}).`);
  const blob = await res.blob();
  return new File([blob], t.fileName, { type: 'audio/mpeg' });
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
