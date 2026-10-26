/**
 * R22 — the renderer's text occupancy guard.
 *
 * R20 guaranteed one caption per anchor zone. That was a *timing*
 * rule; the owner's R22 report was a *spatial* one: recipe text
 * items live outside the caption system, and a caption wrapped at
 * L/XL can grow out of its zone. This module is the shared spatial
 * law for every text drawn in a frame — captions and text items
 * alike:
 *
 *   1. Every text block claims its rendered box for the frame.
 *   2. A block that collides with an already-claimed box is first
 *      SHIFTED (up, then down) by the smallest amount that clears
 *      the collision while staying on canvas.
 *   3. A block that cannot be placed without overlapping is NOT
 *      drawn that frame. Big blocks claim first (headlines keep
 *      their place; small print moves).
 *
 * Pure geometry — the compositor supplies real measured boxes, the
 * build-time layout pass supplies estimated ones, and both get the
 * same verdicts.
 */

export interface TextBox {
  /** Left edge, px. */
  x: number;
  /** Top edge, px. */
  y: number;
  w: number;
  h: number;
}

export function boxesOverlap(a: TextBox, b: TextBox, padPx = 0): boolean {
  return (
    a.x - padPx < b.x + b.w &&
    b.x - padPx < a.x + a.w &&
    a.y - padPx < b.y + b.h &&
    b.y - padPx < a.y + a.h
  );
}

export interface ClaimResult {
  /** The box to draw at (possibly shifted), or null = do not draw. */
  box: TextBox | null;
  shiftedByPx: number;
}

/**
 * Claim `box` against the boxes already claimed this frame.
 * Candidates are tried in order: as-authored, shifted up by the
 * overlap depth (+pad), shifted down, then up/down at growing
 * multiples. The first collision-free candidate fully inside the
 * canvas wins; its box is added to `claimed`.
 */
export function claimTextBox(
  claimed: TextBox[],
  box: TextBox,
  canvasWidth: number,
  canvasHeight: number,
  padPx = 6,
): ClaimResult {
  const inside = (b: TextBox): boolean =>
    b.x >= -1 && b.y >= -1 && b.x + b.w <= canvasWidth + 1 && b.y + b.h <= canvasHeight + 1;
  const collides = (b: TextBox): boolean => claimed.some((c) => boxesOverlap(b, c, padPx));

  if (!collides(box)) {
    claimed.push(box);
    return { box, shiftedByPx: 0 };
  }
  // The smallest useful shift is the vertical distance that clears
  // the deepest collision; try that, then multiples of it.
  let depth = 0;
  for (const c of claimed) {
    if (boxesOverlap(box, c, padPx)) {
      depth = Math.max(depth, Math.min(box.y + box.h, c.y + c.h) - Math.max(box.y, c.y) + padPx);
    }
  }
  const steps = [depth, depth * 1.6, depth * 2.4, canvasHeight * 0.12, canvasHeight * 0.2];
  for (const d of steps) {
    for (const dir of [-1, 1]) {
      const candidate: TextBox = { ...box, y: box.y + dir * d };
      if (!inside(candidate) || collides(candidate)) continue;
      claimed.push(candidate);
      return { box: candidate, shiftedByPx: dir * d };
    }
  }
  return { box: null, shiftedByPx: 0 };
}

/**
 * Estimate a text item's rendered box without a canvas — the
 * build-time layout pass and audit use this; the renderer uses real
 * measurements through the same claim logic. Display faces in the
 * premium catalog average ~0.58 em advance; 0.64 is the deliberate
 * over-estimate so estimates err on the safe side.
 */
export function estimateTextBox(
  text: string,
  fontSizePx: number,
  centerXPx: number,
  centerYPx: number,
): TextBox {
  const w = Math.max(1, text.length * fontSizePx * 0.64);
  const h = fontSizePx * 1.18;
  return { x: centerXPx - w / 2, y: centerYPx - h / 2, w, h };
}
