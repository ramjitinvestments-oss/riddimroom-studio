/**
 * RiddimRoom Studio — caption style catalog (v1).
 *
 * Restores the best 12 styles from riddimroom-caption's 17-style library
 * as real, distinct, working styles (not stubs). Each style renders
 * differently in the compositor (font / color / stroke / background /
 * uppercase) and is selectable per caption item. `animation` is a hint
 * for the editor UI (which entrance preset pairs best) — the compositor
 * itself reads the item's own `animation` field.
 */

export interface CaptionStyle {
  id: string;
  label: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  background?: string;
  uppercase?: boolean;
  /** Suggested entrance animation for this style (editor hint). */
  animation?: string;
  /**
   * Phase 2.3 — karaoke-style active-word color. When set, the compositor
   * fills the currently-spoken word with this color while the remaining
   * words stay in `color` (see `drawCaptionItem` in lib/render/compositor.ts,
   * which already tracks the active word from the item's `words[]` timings
   * for its pop-scale effect). Absent = active word uses `color`, words
   * not yet spoken are dimmed — the long-standing behavior.
   */
  highlightColor?: string;
}

export const CAPTION_STYLES: CaptionStyle[] = [
  { id: 'classic', label: 'Classic', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 48, color: '#ffffff', strokeColor: '#000000', strokeWidth: 6, animation: 'fade' },
  { id: 'bold-yellow', label: 'Bold Yellow', fontFamily: '"Arial Black", Arial, sans-serif', fontSize: 52, color: '#FFD100', strokeColor: '#000000', strokeWidth: 7, uppercase: true, animation: 'pop' },
  { id: 'minimal-box', label: 'Minimal Box', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 44, color: '#ffffff', strokeColor: 'transparent', strokeWidth: 0, background: 'rgba(0,0,0,0.65)', animation: 'fadeup' },
  { id: 'viral', label: 'Classic Viral', fontFamily: '"Arial Black", Arial, sans-serif', fontSize: 56, color: '#ffffff', strokeColor: '#000000', strokeWidth: 8, uppercase: true, animation: 'pop' },
  { id: 'tiktok-premium', label: 'TikTok Premium', fontFamily: '"Helvetica Neue", Arial, sans-serif', fontSize: 50, color: '#ffffff', strokeColor: '#000000', strokeWidth: 5, background: 'rgba(0,0,0,0.45)', animation: 'pop' },
  { id: 'podcast', label: 'Podcast', fontFamily: 'Georgia, serif', fontSize: 46, color: '#ffffff', strokeColor: '#000000', strokeWidth: 4, background: 'rgba(0,0,0,0.55)', animation: 'fade' },
  { id: 'cinema', label: 'Cinema', fontFamily: '"Times New Roman", Georgia, serif', fontSize: 44, color: '#FFE9A8', strokeColor: '#000000', strokeWidth: 4, animation: 'fadeup' },
  { id: 'impact', label: 'Impact Viral', fontFamily: 'Impact, "Arial Black", sans-serif', fontSize: 60, color: '#FF5C1A', strokeColor: '#FFFFFF', strokeWidth: 3, uppercase: true, animation: 'bounce' },
  { id: 'cyber-glitch', label: 'Cyber Glitch', fontFamily: '"Courier New", monospace', fontSize: 50, color: '#FFD100', strokeColor: '#FF5C1A', strokeWidth: 2, uppercase: true, animation: 'glitch' },
  { id: 'fire', label: 'Fire Burner', fontFamily: '"Arial Black", Arial, sans-serif', fontSize: 54, color: '#FF8A00', strokeColor: '#7A0000', strokeWidth: 6, uppercase: true, animation: 'fire' },
  { id: 'rainbow', label: 'Cosmic Rainbow', fontFamily: '"Arial Black", Arial, sans-serif', fontSize: 52, color: '#FFD100', strokeColor: '#FF7A1A', strokeWidth: 5, uppercase: true, animation: 'rainbow' },
  { id: 'heartbeat', label: 'Heartbeat', fontFamily: '"Arial Black", Arial, sans-serif', fontSize: 52, color: '#ffffff', strokeColor: '#E8490F', strokeWidth: 6, uppercase: true, animation: 'heartbeat' },
  // Phase 2.3 — on-brand additions (black / gold #FFD100 / cream / ember).
  { id: 'gold-premium', label: 'Gold Premium', fontFamily: '"Helvetica Neue", Arial, sans-serif', fontSize: 48, color: '#FFD100', strokeColor: '#000000', strokeWidth: 5, background: 'rgba(0,0,0,0.55)', animation: 'fadeup' },
  { id: 'soca-pop', label: 'Soca Pop', fontFamily: '"Arial Black", Arial, sans-serif', fontSize: 54, color: '#FFF6E3', strokeColor: '#FF5C1A', strokeWidth: 7, uppercase: true, animation: 'pop' },
  { id: 'bold-outline', label: 'Bold Outline', fontFamily: '"Arial Black", Arial, sans-serif', fontSize: 54, color: '#ffffff', strokeColor: '#000000', strokeWidth: 11, uppercase: true, animation: 'fade' },
  { id: 'minimal-clean', label: 'Minimal Clean', fontFamily: '"Helvetica Neue", Arial, sans-serif', fontSize: 40, color: '#ffffff', strokeColor: 'transparent', strokeWidth: 0, animation: 'fade' },
  { id: 'karaoke-gold', label: 'Karaoke Gold', fontFamily: '"Arial Black", Arial, sans-serif', fontSize: 52, color: '#ffffff', strokeColor: '#000000', strokeWidth: 6, highlightColor: '#FFD100', animation: 'word-by-word' },
];

export function getCaptionStyle(id: string): CaptionStyle {
  return CAPTION_STYLES.find((style) => style.id === id) ?? CAPTION_STYLES[0];
}
