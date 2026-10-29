/**
 * R37 Phase 1 — Reel Templates view-model.
 *
 * Pure derivation layer between the template catalog (`lib/templates.ts`)
 * and the reel-strip chooser in `TemplatesPanel`: everything a card
 * needs — kind/duration labels, slot count, frame chip, and the Stage-A
 * designed poster — computed from REAL template data only (accent,
 * grade, caption style, headline/hook texts, slot plan). No rendering,
 * no DOM, no project state: fully unit-testable, and the strip
 * component holds no template logic of its own.
 *
 * Stage-A poster honesty: the grade filter is the exact string the
 * compositor itself uses (`colorGradeToFilter` over the template's
 * grade preset), and the headline is set in the template's own caption
 * style — an impression of the look, never hand-tuned mock art.
 */
import {
  TEMPLATE_CATEGORIES,
  type StudioTemplate,
  type TemplateCategory,
} from '../templates';
import { colorGradeToFilter, getGradePreset } from '../grades';
import { getCaptionStyle } from '../captions/styles';

/**
 * Strip geometry (px) — the single source the chooser's height budget
 * is computed from: header 20 + gap 8 + chips 36 + gap 8 + strip 164
 * = 236, inside the plan's ≤260 target (was ≈1,750 for the row list).
 */
export const REEL_LAYOUT = {
  cardWidth: 88,
  cardHeight: 156,
  chipsHeight: 36,
  headerHeight: 20,
  gap: 8,
  stripPaddingY: 4,
} as const;

/** Strip height: one card plus its vertical padding. */
export const REEL_STRIP_HEIGHT = REEL_LAYOUT.cardHeight + 2 * REEL_LAYOUT.stripPaddingY;

/** Total chooser height implied by REEL_LAYOUT (header + chips + strip + the two gaps). */
export function reelChooserHeight(): number {
  return (
    REEL_LAYOUT.headerHeight +
    REEL_LAYOUT.gap +
    REEL_LAYOUT.chipsHeight +
    REEL_LAYOUT.gap +
    REEL_STRIP_HEIGHT
  );
}

export interface PosterHeadline {
  text: string;
  fontFamily: string;
  fontWeight: number;
  color: string;
  uppercase: boolean;
}

export interface PosterSlotSegment {
  name: string;
  /** Slot duration / total slot duration (segments sum to 1). */
  fraction: number;
}

/** Stage-A designed poster, derived only from the template's own data. */
export interface PosterSpec {
  /** Accent glows over the dark base the old monogram thumb used. */
  gradientCss: string;
  /** The compositor's own grade filter for this template ('' = ungraded). */
  gradeFilter: string;
  headline: PosterHeadline | null;
  /** Full edits only: the slot plan as proportional segments. */
  slotSegments: PosterSlotSegment[];
  /** Hooks only: the first element's text in its own colour. */
  hookText: { text: string; color: string } | null;
}

export interface ReelCardModel {
  id: string;
  name: string;
  kind: StudioTemplate['kind'];
  kindLabel: 'Hook' | 'Full edit';
  /** e.g. '2.5s', '30s' — trailing '.0' trimmed. */
  durationLabel: string;
  /** Full edits only; null for hooks. */
  slotCount: number | null;
  /** The preset's designed frame, only when it isn't the 9:16 default. */
  frameAspect: string | null;
  accentColor: string;
  poster: PosterSpec;
}

function formatDurationLabel(durationSeconds: number): string {
  return `${durationSeconds.toFixed(1).replace(/\.0$/, '')}s`;
}

/** '#RRGGBB' + alpha → rgba() string; falls back to the brand gold glow. */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return `rgba(255, 209, 0, ${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function posterFor(t: StudioTemplate): PosterSpec {
  const gradientCss =
    `radial-gradient(circle at 85% 15%, ${hexToRgba(t.accentColor, 0.16)} 0, transparent 45%), ` +
    `radial-gradient(circle at 10% 90%, ${hexToRgba(t.accentColor, 0.1)} 0, transparent 50%), ` +
    'linear-gradient(135deg, #161616 0%, #0a0a0a 100%)';
  const gradeFilter = colorGradeToFilter(getGradePreset(t.grade)?.grade);
  const style = getCaptionStyle(t.captionStyleId);

  let headline: PosterHeadline | null = null;
  let hookText: PosterSpec['hookText'] = null;
  if (t.kind === 'full') {
    // Headline = the template's own headline text only; a full edit
    // without one (e.g. Podcast Clip) shows slot bars + name instead.
    if (t.headlineText) {
      headline = {
        text: t.headlineText,
        fontFamily: style.fontFamily,
        fontWeight: style.fontWeight ?? 700,
        color: style.color,
        uppercase: !!style.uppercase,
      };
    }
  } else {
    const first = t.elements?.[0];
    if (first) {
      hookText = { text: first.text, color: first.color };
      headline = {
        text: first.text,
        fontFamily: style.fontFamily,
        fontWeight: style.fontWeight ?? 700,
        color: first.color,
        uppercase: !!style.uppercase,
      };
    }
  }

  const slots = t.kind === 'full' ? (t.slots ?? []) : [];
  const total = slots.reduce((sum, s) => sum + s.durationSeconds, 0);
  const slotSegments: PosterSlotSegment[] =
    total > 0 ? slots.map((s) => ({ name: s.name, fraction: s.durationSeconds / total })) : [];

  return { gradientCss, gradeFilter, headline, slotSegments, hookText };
}

export function reelCardModel(t: StudioTemplate): ReelCardModel {
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    kindLabel: t.kind === 'hook' ? 'Hook' : 'Full edit',
    durationLabel: formatDurationLabel(t.durationSeconds),
    slotCount: t.kind === 'full' ? (t.slots?.length ?? 0) : null,
    frameAspect: t.frame && t.frame.aspect !== '9:16' ? t.frame.aspect : null,
    accentColor: t.accentColor,
    poster: posterFor(t),
  };
}

/** The one filter row: kind shortcuts first, then the purpose categories. */
export type ReelChip = 'all' | 'hooks' | 'full' | TemplateCategory;

export const REEL_CHIPS: { id: ReelChip; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'full', label: 'Full edits' },
  ...TEMPLATE_CATEGORIES.map((c): { id: ReelChip; label: string } => ({ id: c, label: c })),
];

/**
 * Chip filtering over a template list (catalog order preserved):
 * 'all' → everything; 'hooks'/'full' → by kind; a category → that
 * category across BOTH kinds (what the old category dropdown did
 * across the two sections).
 */
export function reelFilter(templates: StudioTemplate[], chip: ReelChip): StudioTemplate[] {
  if (chip === 'all') return templates;
  if (chip === 'hooks') return templates.filter((t) => t.kind === 'hook');
  if (chip === 'full') return templates.filter((t) => t.kind === 'full');
  return templates.filter((t) => t.category === chip);
}
