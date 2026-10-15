import { describe, it, expect } from 'vitest';
import { GRADE_PRESETS, colorGradeToFilter, getGradePreset } from './grades';
import { computeEntranceExit } from './render/compositor';

/**
 * Templates v3 — cinematic grades + the six premium transitions.
 *
 * Grades: the named presets resolve to concrete values, and
 * `colorGradeToFilter` is the ONE conversion both render paths share
 * (preview + export draw through the same compositor), so pinning it
 * here pins the grade identically in both.
 *
 * Transitions: the same mechanism the catalog suite uses —
 * `computeEntranceExit` must produce a clearly non-identity adjustment
 * inside the transition window and settle outside it. Both render
 * paths consume this same function, so a preset handled here is
 * handled by preview and export alike.
 */
describe('grades — colorGradeToFilter', () => {
  it('is empty for an absent or all-zero grade (no filter cost, no look change)', () => {
    expect(colorGradeToFilter(undefined)).toBe('');
    expect(colorGradeToFilter({ brightness: 0, contrast: 0, saturation: 0 })).toBe('');
  });

  it('maps -100..100 channel values onto CSS filter factors', () => {
    expect(colorGradeToFilter({ brightness: 2, contrast: 14, saturation: 12 })).toBe(
      'brightness(1.020) contrast(1.140) saturate(1.120)',
    );
    expect(colorGradeToFilter({ brightness: -6, contrast: 22, saturation: -35 })).toBe(
      'brightness(0.940) contrast(1.220) saturate(0.650)',
    );
  });

  it('omits zero channels and clamps out-of-range values', () => {
    expect(colorGradeToFilter({ brightness: 0, contrast: 0, saturation: 38 })).toBe('saturate(1.380)');
    expect(colorGradeToFilter({ brightness: 250, contrast: 0, saturation: 0 })).toBe('brightness(2.000)');
    expect(colorGradeToFilter({ brightness: -250, contrast: 0, saturation: 0 })).toBe('brightness(0.000)');
  });

  it('every named preset resolves and produces a non-empty filter', () => {
    for (const id of ['cinematic-warm', 'clean-commercial', 'moody-noir', 'vivid-party', 'soft-podcast']) {
      const preset = getGradePreset(id);
      expect(preset, id).toBeDefined();
      expect(colorGradeToFilter(preset!.grade), id).not.toBe('');
    }
    expect(getGradePreset('not-a-grade')).toBeUndefined();
    expect(GRADE_PRESETS).toHaveLength(5);
  });
});

describe('premium transitions — computeEntranceExit (shared by preview + export)', () => {
  const W = 1080;
  const H = 1920;
  // 10s item: 0.02s after its start (untilEnd 9.98) = just inside the
  // entrance window; mirrored at the exit; 100s from both edges of a
  // 210s item = fully settled.
  const nearStart = (preset: Parameters<typeof computeEntranceExit>[0]) => computeEntranceExit(preset, 0.02, 9.98, 10, W, H);
  const nearEnd = (preset: Parameters<typeof computeEntranceExit>[0]) => computeEntranceExit(preset, 9.98, 0.02, 10, W, H);
  const settled = (preset: Parameters<typeof computeEntranceExit>[0]) => computeEntranceExit(preset, 100, 100, 210, W, H);

  it('cross-zoom: punches scale + blur at the boundary, settles mid-item', () => {
    const a = nearStart('cross-zoom');
    expect(a.scaleMul).toBeGreaterThan(1.3);
    expect(a.blurPx).toBeGreaterThan(4);
    const mid = settled('cross-zoom');
    expect(mid.scaleMul).toBe(1);
    expect(mid.blurPx).toBe(0);
  });

  it('mask-reveal: the feathered mask is mid-sweep at the boundary, fully open mid-item', () => {
    const a = nearStart('mask-reveal');
    expect(a.maskProgress).toBeDefined();
    expect(a.maskProgress!).toBeLessThan(0.6);
    expect(a.maskProgress!).toBeGreaterThan(0);
    const mid = settled('mask-reveal');
    expect(mid.maskProgress === undefined || mid.maskProgress >= 1).toBe(true);
  });

  it('luma-fade: brightness sweeps hot at the boundary while dissolving', () => {
    const a = nearStart('luma-fade');
    expect(a.brightnessMul).toBeDefined();
    expect(a.brightnessMul!).toBeGreaterThan(1.3);
    expect(a.opacityMul).toBeLessThan(1);
    const mid = settled('luma-fade');
    expect(mid.brightnessMul === undefined || mid.brightnessMul === 1).toBe(true);
  });

  it('film-burn: warm additive burn peaks mid-window at the boundary', () => {
    // The burn is a sine swell across the 0.6s window — sample its peak
    // (0.3s in), not its first frame.
    const a = computeEntranceExit('film-burn', 0.3, 9.7, 10, W, H);
    expect(a.overlayColor).toBe('#ff7a1a');
    expect(a.overlayAlpha).toBeGreaterThan(0.25);
    const mid = settled('film-burn');
    expect(mid.overlayAlpha).toBe(0);
  });

  it('dip-to-gold: dips through brand gold #FFD100 at both boundaries', () => {
    // By design the item itself never fades — the gold wash covers it,
    // ramping to (near-)opaque at the very edge of each boundary, so a
    // cut reads as passing THROUGH solid brand gold.
    const enter = nearStart('dip-to-gold');
    expect(enter.overlayColor).toBe('#FFD100');
    expect(enter.overlayAlpha).toBeGreaterThan(0.5);
    const exit = nearEnd('dip-to-gold');
    expect(exit.overlayColor).toBe('#FFD100');
    expect(exit.overlayAlpha).toBeGreaterThan(0.5);
    expect(exit.opacityMul).toBe(1);
  });

  it('smooth-spin: rotates + settles scale at the boundary', () => {
    const a = nearStart('smooth-spin');
    expect(Math.abs(a.rotationDeltaDeg)).toBeGreaterThan(5);
    expect(a.scaleMul).toBeLessThan(1); // grows from ~0.93 into place
    expect(a.scaleMul).toBeGreaterThan(0.85);
    const mid = settled('smooth-spin');
    expect(mid.rotationDeltaDeg).toBe(0);
  });
});
