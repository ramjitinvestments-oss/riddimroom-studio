/**
 * R40 Phase 2 (P-08) — reel focus changes ONLY on a tap.
 *
 * The two-tap model: the first tap on a card focuses it (its own-media
 * preview plays, its Apply pill shows); a tap on the already-focused
 * card applies it. Focus is therefore the Apply target, and it must
 * never move on its own — the old IntersectionObserver moved it to
 * whichever card happened to be ≥90% visible after a scroll or an
 * unrelated project edit, so the card the user tapped was not always
 * the card that applied.
 *
 * This module is the ONLY focus decision in the reel strip, and it is
 * deliberately small: its inputs are the current focus and a tapped
 * card id — visibility ratios, scroll positions and project changes
 * have no path in. Scrolling may still emphasise cards visually in the
 * component, but emphasis never reaches this decision.
 */

export interface ReelCardTapDecision {
  /** 'focus' = the tap only moved focus; 'apply' = the tap hit the focused card. */
  action: 'focus' | 'apply';
  /** The focused card after the tap (the tapped card, either way). */
  focusedId: string;
}

/** The whole two-tap rule, as one pure decision. */
export function decideReelCardTap(focusedId: string | null, tappedId: string): ReelCardTapDecision {
  return focusedId === tappedId
    ? { action: 'apply', focusedId: tappedId }
    : { action: 'focus', focusedId: tappedId };
}

/**
 * Which card is focused for display: the tracked id while it is in
 * the current filter, else the filter's first card. Purely a read —
 * it never writes focus back, so a filter change or a re-render can
 * show the fallback without moving the stored focus.
 */
export function resolveReelFocusedId(focusedId: string | null, visibleIds: readonly string[]): string | null {
  if (focusedId !== null && visibleIds.includes(focusedId)) return focusedId;
  return visibleIds[0] ?? null;
}
