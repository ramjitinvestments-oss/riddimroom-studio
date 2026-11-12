import type { CaptionTimelineItem, Project } from '../../types/timeline';
import { getCaptionStyle } from './styles';

/**
 * R42 Phase C — caption motion: animate in, fade out.
 *
 * Every caption style has always carried an `animation` hint
 * ('fade', 'pop', 'fadeup', 'bounce', 'glitch', 'fire', 'word-by-word'…)
 * that nothing consumed — cues hard-cut in and out. This module is the
 * vocabulary bridge: a style hint maps to ONE of three entrances, all
 * pure opacity/transform so the shared compositor renders them
 * identically in preview and export:
 *
 * - Fade — opacity ramp. Calm styles, and the default for anything
 *   unmapped (including 'word-by-word': the karaoke highlight is the
 *   motion inside those cues, the block itself must not fight it).
 * - Pop — scale up with the word-pop's own easeOutBack overshoot.
 *   The loud styles ('pop', 'bounce', and 'fire' — Event Promo's
 *   launch treatment).
 * - Rise — rises a short distance while fading in ('fadeup').
 *
 * The exit is NOT style-driven: every cue fades out, always — that is
 * the owner's shape ("animate them in, and just fade out").
 * `computeCaptionPhase` in the compositor turns a resolved kind into
 * per-frame numbers.
 */

export type CaptionMotionKind = 'fade' | 'pop' | 'rise';

/** A cue's stored override: a kind forces it, 'off' kills motion, absent follows the style. */
export type CaptionMotionSetting = CaptionMotionKind | 'off';

export function captionMotionForStyleHint(hint: string | undefined): CaptionMotionKind {
  switch (hint) {
    case 'pop':
    case 'bounce':
    case 'fire':
      return 'pop';
    case 'fadeup':
      return 'rise';
    default:
      // 'fade', 'word-by-word', 'glitch', 'heartbeat', 'rainbow',
      // unknown, absent — a caption that strobes or pulses is not
      // premium; the calm entrance is the honest mapping.
      return 'fade';
  }
}

/**
 * The motion a cue actually renders with: its own override wins
 * ('off' → no motion at all, the pre-R42 hard cut), otherwise its
 * caption style's hint decides.
 */
export function resolveCaptionMotion(
  item: Pick<CaptionTimelineItem, 'animation' | 'captionStyleId'>,
): CaptionMotionKind | null {
  if (item.animation === 'off') return null;
  if (item.animation) return item.animation;
  return captionMotionForStyleHint(getCaptionStyle(item.captionStyleId).animation);
}

/**
 * The Captions group's Caption motion control, as a pure project
 * transform (the panel wraps it in ONE mutate = one undo step):
 * sets the override on every caption cue — or clears it
 * (`setting === 'style'`) so cues follow their styles again.
 * Non-caption items are returned untouched, by reference.
 */
export function setAllCaptionMotion(project: Project, setting: CaptionMotionSetting | 'style'): Project {
  return {
    ...project,
    items: project.items.map((item) => {
      if (item.type !== 'caption') return item;
      if (setting === 'style') {
        if (item.animation === undefined) return item;
        const cleared = { ...item };
        delete cleared.animation;
        return cleared;
      }
      return item.animation === setting ? item : { ...item, animation: setting };
    }),
  };
}

/**
 * The control's current value: 'style' when no cue carries an
 * override, the shared kind when every cue agrees, 'mixed' when a
 * project was hand-built into disagreement (choosing any option
 * unifies it — see setAllCaptionMotion).
 */
export function captionMotionSelection(project: Project): CaptionMotionSetting | 'style' | 'mixed' {
  const values = new Set<CaptionMotionSetting | 'style'>();
  for (const item of project.items) {
    if (item.type === 'caption') values.add(item.animation ?? 'style');
  }
  if (values.size === 0) return 'style';
  if (values.size === 1) return [...values][0];
  return 'mixed';
}
