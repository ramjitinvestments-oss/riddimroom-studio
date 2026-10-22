/**
 * RiddimRoom Studio — fixed-window trim math (Templates v3 crop picker).
 *
 * Pure helpers behind `SlotTrimPicker`: a video item keeps a source
 * window of FIXED length (its current `trimEnd - trimStart`); the user
 * only slides WHERE that window sits inside the source. All the clamping
 * lives here (not in the component) so it is unit-testable without a DOM:
 * the window may never start before 0, never end past the source, and a
 * window at least as long as the source is pinned to 0 (the whole
 * source is the window).
 */

/** Latest legal window start: `sourceDuration - windowLength`, floored at 0. */
export function maxWindowStart(windowLength: number, sourceDuration: number): number {
  if (!Number.isFinite(windowLength) || !Number.isFinite(sourceDuration)) return 0;
  return Math.max(0, sourceDuration - windowLength);
}

/** Clamps a proposed window start into `[0, maxWindowStart]`. NaN/negative proposals become 0. */
export function clampWindowStart(windowStart: number, windowLength: number, sourceDuration: number): number {
  if (!Number.isFinite(windowStart) || windowStart <= 0) return 0;
  return Math.min(windowStart, maxWindowStart(windowLength, sourceDuration));
}

/**
 * The trim window a video item currently shows, as `{ start, length }`
 * in SOURCE seconds: length is the item's own trim span (unaffected by
 * playback speed — speed stretches the timeline, not the source window).
 */
export function itemTrimWindow(item: { trimStart: number; trimEnd: number }): { start: number; length: number } {
  const length = Math.max(0, item.trimEnd - item.trimStart);
  return { start: Math.max(0, item.trimStart), length };
}

/**
 * Source duration for windowing: the asset's probed duration when it is
 * a sane positive number; otherwise the item's own `trimEnd` (the
 * furthest source point the project already references — the window can
 * never slide past what is known to exist).
 */
export function resolveSourceDuration(
  item: { trimEnd: number },
  assetDurationSeconds: number | undefined,
): number {
  if (typeof assetDurationSeconds === 'number' && Number.isFinite(assetDurationSeconds) && assetDurationSeconds > 0) {
    return assetDurationSeconds;
  }
  return Math.max(0, item.trimEnd);
}

/** True when the source is longer than the item's current window — i.e. there is anything for the crop picker to slide. */
export function hasCroppableSlack(item: { trimStart: number; trimEnd: number }, sourceDuration: number): boolean {
  const { length } = itemTrimWindow(item);
  return sourceDuration > length + 0.05;
}
