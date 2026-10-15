/**
 * RiddimRoom Studio — cinematic color grades (Templates v3).
 *
 * Named grade presets → concrete `ColorGradeSettings` values
 * (brightness/contrast/saturation, -100..100, 0 = unchanged — the shape
 * `VideoTimelineItem.colorGrade` has carried since the data model was
 * founded, now also on `ImageTimelineItem`). Until v3 that field had NO
 * consumer anywhere — no render path read it — so this module also owns
 * the one conversion both render paths share: `colorGradeToFilter`,
 * which turns the settings into a CSS/canvas `filter` fragment.
 *
 * Both render paths (live preview in `PreviewPane`, export in
 * `canvas2dRenderer`) draw through the same compositor `drawFrame`,
 * whose `applyTransformedDraw` appends this fragment to `ctx.filter`
 * alongside the transition blur/hue-rotate — so a grade is guaranteed
 * identical in preview and export, never a preview-only effect.
 */
import type { ColorGradeSettings } from '../types/timeline';

export interface GradePreset {
  id: string;
  label: string;
  description: string;
  grade: ColorGradeSettings;
}

export const GRADE_PRESETS: GradePreset[] = [
  {
    id: 'cinematic-warm',
    label: 'Cinematic Warm',
    description: 'Warm highlights, deeper contrast — the filmic house look.',
    grade: { brightness: 2, contrast: 14, saturation: 12 },
  },
  {
    id: 'clean-commercial',
    label: 'Clean Commercial',
    description: 'Bright, neutral, product-true — ads and store content.',
    grade: { brightness: 6, contrast: 8, saturation: 4 },
  },
  {
    id: 'moody-noir',
    label: 'Moody Noir',
    description: 'Crushed, desaturated, dramatic — night and music visuals.',
    grade: { brightness: -6, contrast: 22, saturation: -35 },
  },
  {
    id: 'vivid-party',
    label: 'Vivid Party',
    description: 'Punched-up color and snap — events and high-energy social.',
    grade: { brightness: 4, contrast: 12, saturation: 38 },
  },
  {
    id: 'soft-podcast',
    label: 'Soft Podcast',
    description: 'Gentle and skin-friendly — talking heads and interviews.',
    grade: { brightness: 3, contrast: 4, saturation: -6 },
  },
];

export function getGradePreset(id: string | undefined): GradePreset | undefined {
  if (!id) return undefined;
  return GRADE_PRESETS.find((g) => g.id === id);
}

/** One -100..100 grade channel → a canvas/CSS filter factor (0..2, 1 = unchanged). */
function channelFactor(value: number): number {
  const safe = Number.isFinite(value) ? Math.max(-100, Math.min(100, value)) : 0;
  return Math.max(0, 1 + safe / 100);
}

/**
 * Converts item color-grade settings into a `filter` fragment
 * (e.g. `brightness(1.02) contrast(1.14) saturate(1.12)`), or '' when
 * the grade is absent/all-zero — callers append it only when non-empty,
 * so ungraded items render byte-identically to before grades existed.
 */
export function colorGradeToFilter(grade: ColorGradeSettings | undefined): string {
  if (!grade) return '';
  const parts: string[] = [];
  if (grade.brightness) parts.push(`brightness(${channelFactor(grade.brightness).toFixed(3)})`);
  if (grade.contrast) parts.push(`contrast(${channelFactor(grade.contrast).toFixed(3)})`);
  if (grade.saturation) parts.push(`saturate(${channelFactor(grade.saturation).toFixed(3)})`);
  return parts.join(' ');
}
