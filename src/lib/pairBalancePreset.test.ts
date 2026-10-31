import { describe, expect, it } from 'vitest';
import { matchingPairBalancePreset, type PairContext } from './pairLayout';

function ctx(mainVolume: number | null, secondVolume: number | null): PairContext {
  const member = (id: string, volume: number | null) =>
    volume === null ? { id, type: 'image' } : { id, type: 'video', volume };
  return {
    pairId: 'pair-1',
    main: member('m', mainVolume),
    second: member('s', secondVolume),
    layout: 'split',
    orientation: 'side',
    dividerStyle: 'none',
    dividerWidthPx: 0,
    matchOn: false,
    legacy: false,
  } as unknown as PairContext;
}

describe('R40 P-25 — pair balance preset selected state is derived from real volumes', () => {
  it('matches each preset exactly', () => {
    expect(matchingPairBalancePreset(ctx(1.0, 0.25))).toBe('scene');
    expect(matchingPairBalancePreset(ctx(0.8, 0.8))).toBe('equal');
    expect(matchingPairBalancePreset(ctx(0.25, 1.0))).toBe('you');
  });

  it('matches within a small epsilon (slider rounding)', () => {
    expect(matchingPairBalancePreset(ctx(0.995, 0.255))).toBe('scene');
  });

  it('returns null for a hand-set mix that matches no preset', () => {
    expect(matchingPairBalancePreset(ctx(0.5, 0.5))).toBeNull();
    expect(matchingPairBalancePreset(ctx(0.9, 0.1))).toBeNull();
  });

  it('ignores image members, exactly like applyPairBalance does', () => {
    expect(matchingPairBalancePreset(ctx(null, 0.25))).toBe('scene');
    expect(matchingPairBalancePreset(ctx(0.8, null))).toBe('equal');
  });
});
