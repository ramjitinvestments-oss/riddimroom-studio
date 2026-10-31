import { beforeEach, describe, expect, it } from 'vitest';
import { exportsRemainingLabel, exportsRemainingToday, recordExport } from './licensing';

describe('R40 P-20 — exports-remaining copy can never show a raw unlimited count', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      length: 0,
    } as Storage;
    localStorage.clear();
  });

  it('the raw counter is still unlimited for Lifetime (the gate needs it)', () => {
    expect(exportsRemainingToday('u1', 'lifetime')).toBe(Number.POSITIVE_INFINITY);
  });

  it('the label for Lifetime is the shared unlimited wording', () => {
    expect(exportsRemainingLabel('u1', 'lifetime')).toBe('Unlimited exports (Lifetime)');
  });

  it('the label for Free is a real finite count', () => {
    expect(exportsRemainingLabel('u1', 'free')).toBe('3 exports left today');
    recordExport('u1');
    expect(exportsRemainingLabel('u1', 'free')).toBe('2 exports left today');
    recordExport('u1');
    recordExport('u1');
    expect(exportsRemainingLabel('u1', 'free')).toBe('0 exports left today');
  });

  it('no tier label contains the raw unlimited marker', () => {
    for (const tier of ['free', 'lifetime'] as const) {
      expect(exportsRemainingLabel('u1', tier)).not.toContain('Infinity');
    }
  });
});
