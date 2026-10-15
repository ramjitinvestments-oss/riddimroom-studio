import { describe, it, expect } from 'vitest';
import {
  clampWindowStart,
  hasCroppableSlack,
  itemTrimWindow,
  maxWindowStart,
  resolveSourceDuration,
} from './trimWindow';
import type { VideoTimelineItem } from '../../types/timeline';

/**
 * Templates v3 — the crop picker's pure window math. The picker keeps a
 * window of FIXED length (the item's current source span) sliding over
 * the source; these are the clamps that keep it inside [0, source −
 * window] no matter what the drag (or the data) says.
 */
describe('trimWindow — clampWindowStart', () => {
  it('passes through a start already inside the range', () => {
    expect(clampWindowStart(5, 4, 30)).toBe(5);
    expect(clampWindowStart(0, 4, 30)).toBe(0);
    expect(clampWindowStart(26, 4, 30)).toBe(26); // exactly at the max
  });

  it('clamps a negative start to 0', () => {
    expect(clampWindowStart(-3, 4, 30)).toBe(0);
  });

  it('clamps a start past the end back to source − window', () => {
    expect(clampWindowStart(29, 4, 30)).toBe(26);
    expect(clampWindowStart(1000, 4, 30)).toBe(26);
  });

  it('window at least as long as the source pins the start to 0', () => {
    expect(clampWindowStart(5, 30, 30)).toBe(0);
    expect(clampWindowStart(5, 45, 30)).toBe(0);
  });

  it('degenerate inputs fall back to 0 rather than NaN', () => {
    expect(clampWindowStart(Number.NaN, 4, 30)).toBe(0);
    expect(clampWindowStart(5, Number.NaN, 30)).toBe(0);
    expect(clampWindowStart(5, 4, Number.NaN)).toBe(0);
    expect(clampWindowStart(5, 4, 0)).toBe(0); // empty source: nowhere to slide
  });

  it('maxWindowStart mirrors the clamp ceiling', () => {
    expect(maxWindowStart(4, 30)).toBe(26);
    expect(maxWindowStart(30, 30)).toBe(0);
    expect(maxWindowStart(4, 0)).toBe(0);
  });
});

describe('trimWindow — item helpers', () => {
  const item = { trimStart: 7, trimEnd: 12 } as VideoTimelineItem;

  it('itemTrimWindow reports start + length of the current source span', () => {
    expect(itemTrimWindow(item)).toEqual({ start: 7, length: 5 });
  });

  it('resolveSourceDuration prefers a sane probed asset duration', () => {
    expect(resolveSourceDuration(item, 30)).toBe(30);
  });

  it('resolveSourceDuration falls back to the item trim end when the asset duration is unusable', () => {
    expect(resolveSourceDuration(item, undefined)).toBe(12);
    expect(resolveSourceDuration(item, 0)).toBe(12);
    expect(resolveSourceDuration(item, Number.NaN)).toBe(12);
    // A sane probed duration is the ground truth about the source and
    // wins even when it disagrees with a stale trim.
    expect(resolveSourceDuration(item, 5)).toBe(5);
  });

  it('hasCroppableSlack is true only when source clearly exceeds the window', () => {
    // The item's window is 5s long (trim 7→12); slack compares the
    // SOURCE against that window length, not against the trim end.
    expect(hasCroppableSlack(item, 30)).toBe(true);
    expect(hasCroppableSlack(item, 5)).toBe(false); // window == source
    expect(hasCroppableSlack(item, 5.03)).toBe(false); // within float tolerance
    expect(hasCroppableSlack(item, 5.2)).toBe(true);
    expect(hasCroppableSlack(item, 0)).toBe(false);
  });
});
