/**
 * RiddimRoom Studio — caption style catalog.
 *
 * R19 — premium faces + a real size system. The catalog's faces are
 * the app's premium font library (Google Fonts, OFL — Anton, Archivo
 * Black, Bungee, Montserrat, Cinzel, Playfair, Poppins, Titan One,
 * Alfa Slab One) instead of the system fonts the styles shipped
 * with; two styles keep deliberate system faces (Classic's neutral
 * Arial, Cyber Glitch's mono). Sizes are authored at the 1080-wide
 * reference and scale with the canvas at render time (see
 * resolveCaptionFontPx), so a style looks identical at any render
 * size. `fontWeight` is the face's TRUE weight — single-weight
 * display faces (Anton, Bungee…) render at 400, never under a
 * synthesized faux-bold.
 */

export interface CaptionStyle {
  id: string;
  label: string;
  fontFamily: string;
  /** Authored px size at the 1080px-wide reference canvas. */
  fontSize: number;
  /** The face's true weight (400 for single-weight display faces). */
  fontWeight?: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  background?: string;
  uppercase?: boolean;
  /** Suggested entrance animation for this style (editor hint). */
  animation?: string;
  /**
   * Karaoke-style active-word color: when set, the compositor fills
   * the currently-spoken word with this color while the remaining
   * words stay in `color` (see drawCaptionItem, which tracks the
   * active word from the item's words[] timings for its pop-scale
   * effect). Absent = active word uses `color`, words not yet
   * spoken are dimmed.
   */
  highlightColor?: string;
}

/** The reference width every style size is authored against. */
export const CAPTION_REFERENCE_WIDTH = 1080;

/**
 * The rendered pixel size of a caption: the style's authored size,
 * scaled to the actual canvas width, times the item's size tier.
 */
export function resolveCaptionFontPx(style: CaptionStyle, canvasWidth: number, sizeScale?: number): number {
  return style.fontSize * (canvasWidth / CAPTION_REFERENCE_WIDTH) * (sizeScale ?? 1);
}

/** User-facing size tiers (R19). M is the style's authored size. */
export const CAPTION_SIZE_TIERS = { S: 0.8, M: 1, L: 1.25, XL: 1.55 } as const;
export type CaptionSizeTier = keyof typeof CAPTION_SIZE_TIERS;

export const CAPTION_STYLES: CaptionStyle[] = [
  { id: 'classic', label: 'Classic', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 48, fontWeight: 700, color: '#ffffff', strokeColor: '#000000', strokeWidth: 6, animation: 'fade' },
  { id: 'bold-yellow', label: 'Bold Yellow', fontFamily: '"Archivo Black", "Arial Black", sans-serif', fontSize: 58, fontWeight: 400, color: '#FFD100', strokeColor: '#000000', strokeWidth: 7, uppercase: true, animation: 'pop' },
  { id: 'minimal-box', label: 'Minimal Box', fontFamily: '"Poppins", Arial, sans-serif', fontSize: 48, fontWeight: 600, color: '#ffffff', strokeColor: 'transparent', strokeWidth: 0, background: 'rgba(0,0,0,0.65)', animation: 'fadeup' },
  { id: 'viral', label: 'Classic Viral', fontFamily: '"Archivo Black", "Arial Black", sans-serif', fontSize: 64, fontWeight: 400, color: '#ffffff', strokeColor: '#000000', strokeWidth: 8, uppercase: true, animation: 'pop' },
  { id: 'tiktok-premium', label: 'TikTok Premium', fontFamily: '"Montserrat", "Helvetica Neue", sans-serif', fontSize: 56, fontWeight: 800, color: '#ffffff', strokeColor: '#000000', strokeWidth: 5, background: 'rgba(0,0,0,0.45)', animation: 'pop' },
  { id: 'podcast', label: 'Podcast', fontFamily: '"Poppins", Arial, sans-serif', fontSize: 50, fontWeight: 700, color: '#ffffff', strokeColor: '#000000', strokeWidth: 4, background: 'rgba(0,0,0,0.55)', animation: 'fade' },
  { id: 'cinema', label: 'Cinema', fontFamily: '"Playfair Display", Georgia, serif', fontSize: 52, fontWeight: 800, color: '#FFE9A8', strokeColor: '#000000', strokeWidth: 4, animation: 'fadeup' },
  { id: 'impact', label: 'Impact Viral', fontFamily: '"Anton", Impact, sans-serif', fontSize: 68, fontWeight: 400, color: '#FF5C1A', strokeColor: '#FFFFFF', strokeWidth: 3, uppercase: true, animation: 'bounce' },
  { id: 'cyber-glitch', label: 'Cyber Glitch', fontFamily: '"Courier New", monospace', fontSize: 50, fontWeight: 700, color: '#FFD100', strokeColor: '#FF5C1A', strokeWidth: 2, uppercase: true, animation: 'glitch' },
  { id: 'fire', label: 'Fire Burner', fontFamily: '"Archivo Black", "Arial Black", sans-serif', fontSize: 60, fontWeight: 400, color: '#FF8A00', strokeColor: '#7A0000', strokeWidth: 6, uppercase: true, animation: 'fire' },
  { id: 'rainbow', label: 'Cosmic Rainbow', fontFamily: '"Archivo Black", "Arial Black", sans-serif', fontSize: 58, fontWeight: 400, color: '#FFD100', strokeColor: '#FF7A1A', strokeWidth: 5, uppercase: true, animation: 'rainbow' },
  { id: 'heartbeat', label: 'Heartbeat', fontFamily: '"Archivo Black", "Arial Black", sans-serif', fontSize: 58, fontWeight: 400, color: '#ffffff', strokeColor: '#E8490F', strokeWidth: 6, uppercase: true, animation: 'heartbeat' },
  // On-brand set (black / gold #FFD100 / cream / ember).
  { id: 'gold-premium', label: 'Gold Premium', fontFamily: '"Cinzel", Georgia, serif', fontSize: 54, fontWeight: 700, color: '#FFD100', strokeColor: '#000000', strokeWidth: 5, background: 'rgba(0,0,0,0.55)', animation: 'fadeup' },
  { id: 'soca-pop', label: 'Soca Pop', fontFamily: '"Bungee", "Arial Black", sans-serif', fontSize: 56, fontWeight: 400, color: '#FFF6E3', strokeColor: '#FF5C1A', strokeWidth: 7, uppercase: true, animation: 'pop' },
  { id: 'bold-outline', label: 'Bold Outline', fontFamily: '"Archivo Black", "Arial Black", sans-serif', fontSize: 62, fontWeight: 400, color: '#ffffff', strokeColor: '#000000', strokeWidth: 11, uppercase: true, animation: 'fade' },
  { id: 'minimal-clean', label: 'Minimal Clean', fontFamily: '"Montserrat", "Helvetica Neue", sans-serif', fontSize: 46, fontWeight: 600, color: '#ffffff', strokeColor: 'transparent', strokeWidth: 0, animation: 'fade' },
  { id: 'karaoke-gold', label: 'Karaoke Gold', fontFamily: '"Montserrat", "Arial Black", sans-serif', fontSize: 60, fontWeight: 900, color: '#ffffff', strokeColor: '#000000', strokeWidth: 6, highlightColor: '#FFD100', animation: 'word-by-word' },
  // R17 Viral Finish — the signature word-by-word style.
  { id: 'viral-gold-pop', label: 'Viral Gold Pop', fontFamily: '"Anton", "Arial Black", sans-serif', fontSize: 88, fontWeight: 400, color: '#ffffff', strokeColor: '#000000', strokeWidth: 10, highlightColor: '#FFD100', uppercase: true, animation: 'word-by-word' },
  // R19 — the premium size/face additions.
  { id: 'anton-slam', label: 'Anton Slam', fontFamily: '"Anton", "Arial Black", sans-serif', fontSize: 94, fontWeight: 400, color: '#ffffff', strokeColor: '#000000', strokeWidth: 12, highlightColor: '#FFD100', uppercase: true, animation: 'word-by-word' },
  { id: 'montserrat-ultra', label: 'Montserrat Ultra', fontFamily: '"Montserrat", "Helvetica Neue", sans-serif', fontSize: 66, fontWeight: 900, color: '#ffffff', strokeColor: '#000000', strokeWidth: 8, highlightColor: '#FFD100', uppercase: true, animation: 'word-by-word' },
  { id: 'bungee-bashment', label: 'Bungee Bashment', fontFamily: '"Bungee", "Arial Black", sans-serif', fontSize: 60, fontWeight: 400, color: '#FFD100', strokeColor: '#000000', strokeWidth: 8, highlightColor: '#ffffff', uppercase: true, animation: 'pop' },
  { id: 'titan-chunk', label: 'Titan Chunk', fontFamily: '"Titan One", "Arial Black", sans-serif', fontSize: 64, fontWeight: 400, color: '#ffffff', strokeColor: '#000000', strokeWidth: 9, highlightColor: '#FFD100', uppercase: true, animation: 'pop' },
  { id: 'alfa-poster', label: 'Alfa Poster', fontFamily: '"Alfa Slab One", Georgia, serif', fontSize: 62, fontWeight: 400, color: '#FFF6E3', strokeColor: '#7A0000', strokeWidth: 6, uppercase: true, animation: 'fadeup' },
];

export function getCaptionStyle(id: string): CaptionStyle {
  return CAPTION_STYLES.find((style) => style.id === id) ?? CAPTION_STYLES[0];
}
