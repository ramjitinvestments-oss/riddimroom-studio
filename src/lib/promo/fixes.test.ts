import { describe, expect, it } from 'vitest';
import { loadArtworkFixes, parseFixesStore, saveArtworkFixes } from './fixes';

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe('artwork correction memory', () => {
  it('round-trips the fields the user wrote, skipping empties', () => {
    const s = fakeStorage();
    expect(saveArtworkFixes('art.png:123', { hook1: 'MY HOOK', sub: '', cta: 'CALL ME' }, s)).toBe(true);
    expect(loadArtworkFixes('art.png:123', s)).toEqual({ hook1: 'MY HOOK', cta: 'CALL ME' });
    expect(loadArtworkFixes('other.png:9', s)).toBeNull();
  });

  it('nothing to keep, nothing stored', () => {
    const s = fakeStorage();
    expect(saveArtworkFixes('a:1', { hook1: '  ' }, s)).toBe(false);
    expect(loadArtworkFixes('a:1', s)).toBeNull();
  });

  it('a corrupt store parses to empty, never throws', () => {
    expect(parseFixesStore('{nope')).toEqual({});
    expect(parseFixesStore(null)).toEqual({});
  });
});
