import { describe, it, expect, beforeEach } from 'vitest';
import { getPlanLimits, canExportToday, exportsRemainingToday, recordExport, getExportsToday, exportCounterKey, resolveEffectiveTier } from './licensing';

describe('licensing plan limits', () => {
  it('free is limited, lifetime is generous', () => {
    expect(getPlanLimits('free').maxProjectSeconds).toBe(30);
    expect(getPlanLimits('free').dailyExports).toBe(3);
    expect(getPlanLimits('free').watermark).toBe(true);
    expect(getPlanLimits('lifetime').maxProjectSeconds).toBe(600);
    expect(getPlanLimits('lifetime').dailyTranscriptions).toBe(10);
    expect(getPlanLimits('lifetime').watermark).toBe(false);
  });
});

describe('resolveEffectiveTier (owner/admin grant)', () => {
  it('a present server tier is authoritative — never second-guessed', () => {
    expect(resolveEffectiveTier('lifetime', false)).toBe('lifetime');
    expect(resolveEffectiveTier('free', false)).toBe('free');
    expect(resolveEffectiveTier('free', true)).toBe('free');
  });
  it('with no server answer, an admin resolves to lifetime', () => {
    expect(resolveEffectiveTier(null, true)).toBe('lifetime');
    expect(resolveEffectiveTier(undefined, true)).toBe('lifetime');
  });
  it('with no server answer, a non-admin stays free', () => {
    expect(resolveEffectiveTier(null, false)).toBe('free');
    expect(resolveEffectiveTier(undefined, false)).toBe('free');
  });
});

describe('export counter (localStorage soft gate)', () => {
  beforeEach(() => {
    // Vitest runs in node env (no localStorage) — stub an in-memory one.
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      length: 0,
    } as Storage;
    localStorage.clear();
  });
  it('allows 3 free exports then blocks', () => {
    const uid = 'uid-test';
    expect(canExportToday(uid, 'free')).toBe(true);
    expect(exportsRemainingToday(uid, 'free')).toBe(3);
    recordExport(uid); recordExport(uid); recordExport(uid);
    expect(getExportsToday(uid)).toBe(3);
    expect(canExportToday(uid, 'free')).toBe(false);
    expect(exportsRemainingToday(uid, 'free')).toBe(0);
  });
  it('lifetime is unlimited', () => {
    const uid = 'uid-test';
    for (let i = 0; i < 10; i++) recordExport(uid);
    expect(canExportToday(uid, 'lifetime')).toBe(true);
  });
  it('counter key is per-uid per-day', () => {
    expect(exportCounterKey('u1')).toContain('u1');
    expect(exportCounterKey('u1')).not.toBe(exportCounterKey('u2'));
  });
});
