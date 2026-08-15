/**
 * RiddimRoom Studio — caption style catalog.
 *
 * `CaptionTimelineItem.captionStyleId` references one of these by id rather
 * than embedding style data per item (see `src/types/timeline.ts` header
 * comment). riddimroom-caption shipped 17 animated caption styles; this
 * Phase 1 catalog intentionally ships a smaller, real, working set (3
 * static styles — animation presets referenced by `AnimationSettings` are a
 * separate, already-typed concern) rather than stubbing out 17 placeholder
 * entries that don't actually render differently. Extending this array is
 * how a future step reintroduces the rest of caption's style library —
 * nothing about the data model limits it to 3.
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
}

export const CAPTION_STYLES: CaptionStyle[] = [
  {
    id: 'classic',
    label: 'Classic',
    fontFamily: 'Arial, Helvetica, sans-serif',
    fontSize: 48,
    color: '#ffffff',
    strokeColor: '#000000',
    strokeWidth: 6,
  },
  {
    id: 'bold-yellow',
    label: 'Bold Yellow',
    fontFamily: '"Arial Black", Arial, sans-serif',
    fontSize: 52,
    color: '#FFD400',
    strokeColor: '#000000',
    strokeWidth: 7,
    uppercase: true,
  },
  {
    id: 'minimal-box',
    label: 'Minimal Box',
    fontFamily: 'Arial, Helvetica, sans-serif',
    fontSize: 44,
    color: '#ffffff',
    strokeColor: 'transparent',
    strokeWidth: 0,
    background: 'rgba(0,0,0,0.65)',
  },
];

export function getCaptionStyle(id: string): CaptionStyle {
  return CAPTION_STYLES.find((style) => style.id === id) ?? CAPTION_STYLES[0];
}
