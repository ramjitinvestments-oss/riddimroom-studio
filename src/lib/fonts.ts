/**
 * Premium display fonts — the ten faces the owner asked for, all
 * Google Fonts under the Open Font License (free for commercial
 * use, no attribution duty). They load at runtime from Google's
 * font CDN (CORS-open, cacheable) — no font files ship in the
 * repo, so there's nothing for a deploy to drop.
 *
 * Loading discipline: `ensureFontsLoaded` injects the stylesheet
 * once and then waits on `document.fonts.load` for each face, so
 * by the time the preview or an export draws a text item, the
 * face is actually ready — a canvas that draws before the font
 * arrives silently falls back to Arial, which is exactly the
 * failure this module exists to prevent. Export calls it for the
 * fonts the project actually uses before rendering a frame.
 */

export interface FontOption {
  /** The CSS family name stored on text items. */
  family: string;
  label: string;
  vibe: string;
}

export const FONT_OPTIONS: FontOption[] = [
  { family: 'Anton', label: 'Anton', vibe: 'Poster bold — the headline hammer' },
  { family: 'Bebas Neue', label: 'Bebas Neue', vibe: 'Tall + tight — flyer classic' },
  { family: 'Archivo Black', label: 'Archivo Black', vibe: 'Heavy block — maximum weight' },
  { family: 'Bungee', label: 'Bungee', vibe: 'Party signage — pure energy' },
  { family: 'Luckiest Guy', label: 'Luckiest Guy', vibe: 'Playful display — soca sunshine' },
  { family: 'Montserrat', label: 'Montserrat', vibe: 'Clean geometric — modern premium' },
  { family: 'Oswald', label: 'Oswald', vibe: 'Condensed — news + lineup cards' },
  { family: 'Playfair Display', label: 'Playfair Display', vibe: 'Elegant serif — gospel + luxury' },
  { family: 'Cinzel', label: 'Cinzel', vibe: 'Engraved caps — ceremony + realty' },
  { family: 'Poppins', label: 'Poppins', vibe: 'Round + friendly — corporate clean' },
];

export const DEFAULT_PROMO_FONT = 'Anton';

const WEIGHTS: Record<string, string> = {
  Anton: '400',
  'Bebas Neue': '400',
  'Archivo Black': '400',
  Bungee: '400',
  'Luckiest Guy': '400',
  Montserrat: '700;800;900',
  Oswald: '500;600;700',
  'Playfair Display': '700;800;900',
  Cinzel: '600;700;800',
  Poppins: '600;700;800',
};

export function googleFontsStylesheetUrl(): string {
  const families = FONT_OPTIONS.map(
    (f) => `family=${encodeURIComponent(f.family)}:wght@${WEIGHTS[f.family] ?? '400;700'}`,
  ).join('&');
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}

/** The canvas font stack for a stored family name. */
export function canvasFontStack(family: string | undefined): string {
  if (!family || family === 'Arial') return 'Arial, Helvetica, sans-serif';
  return `"${family}", Arial, Helvetica, sans-serif`;
}

let stylesheetInjected = false;

/**
 * Load the premium faces (once) and wait until each is usable for
 * canvas drawing. Safe to call repeatedly; failures resolve quietly
 * (text then renders in the fallback stack rather than blocking).
 */
export async function ensureFontsLoaded(families?: string[]): Promise<void> {
  if (typeof document === 'undefined') return;
  try {
    if (!stylesheetInjected) {
      stylesheetInjected = true;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = googleFontsStylesheetUrl();
      link.dataset.riddimFonts = '1';
      document.head.appendChild(link);
    }
    const wanted = (families && families.length > 0 ? families : FONT_OPTIONS.map((f) => f.family)).filter(
      (f) => f && f !== 'Arial',
    );
    await Promise.all(
      wanted.map(async (family) => {
        try {
          await document.fonts.load(`700 80px "${family}"`);
          await document.fonts.load(`400 80px "${family}"`);
        } catch {
          /* one face failing never blocks the rest */
        }
      }),
    );
  } catch {
    /* font loading must never block a render or an export */
  }
}

/** Distinct premium families a project actually uses on text items. */
export function fontsUsedInProject(project: { items: Array<{ type: string; font?: string }> }): string[] {
  const used = new Set<string>();
  for (const item of project.items) {
    if (item.type === 'text' && item.font && item.font !== 'Arial') used.add(item.font);
  }
  return [...used];
}
