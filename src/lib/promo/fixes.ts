import type { PromoTexts } from './recipes';

/**
 * Correction memory (R18) — the words a user fixes for an artwork
 * STAY fixed for that artwork. When the same file (name + size) is
 * analyzed again — a re-run, a rebuild, a campaign — the saved
 * wording is reapplied over the fresh read and marked as the user's
 * own. Device-local, fail-soft, capped: the oldest artworks fall
 * off at 24 entries. Only fields the user actually wrote are kept;
 * empty fields are never stored (a cleared field must not blank a
 * future read).
 */

export const ARTWORK_FIXES_KEY = 'riddimroom.artworkFixes.v1';
const MAX_ARTWORKS = 24;

export interface ArtworkFixes {
  texts: Partial<PromoTexts>;
  savedAt: number;
}

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function defaultStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function parseFixesStore(raw: string | null): Record<string, ArtworkFixes> {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as Record<string, ArtworkFixes>;
    if (!data || typeof data !== 'object') return {};
    const out: Record<string, ArtworkFixes> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && value.texts && typeof value.texts === 'object') {
        out[key] = { texts: value.texts, savedAt: typeof value.savedAt === 'number' ? value.savedAt : 0 };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function nonEmptyTexts(texts: Partial<PromoTexts>): Partial<PromoTexts> {
  const out: Partial<PromoTexts> = {};
  for (const f of ['hook1', 'hook2', 'sub', 'cta'] as const) {
    const v = texts[f]?.trim();
    if (v) out[f] = v;
  }
  return out;
}

export function loadArtworkFixes(artKey: string, storage: StorageLike | null = defaultStorage()): Partial<PromoTexts> | null {
  if (!storage || !artKey) return null;
  try {
    const store = parseFixesStore(storage.getItem(ARTWORK_FIXES_KEY));
    const entry = store[artKey];
    if (!entry) return null;
    const texts = nonEmptyTexts(entry.texts);
    return Object.keys(texts).length > 0 ? texts : null;
  } catch {
    return null;
  }
}

export function saveArtworkFixes(artKey: string, texts: Partial<PromoTexts>, storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage || !artKey) return false;
  const kept = nonEmptyTexts(texts);
  if (Object.keys(kept).length === 0) return false;
  try {
    const store = parseFixesStore(storage.getItem(ARTWORK_FIXES_KEY));
    store[artKey] = { texts: kept, savedAt: Date.now() };
    const keys = Object.keys(store).sort((a, b) => store[b].savedAt - store[a].savedAt);
    for (const key of keys.slice(MAX_ARTWORKS)) delete store[key];
    storage.setItem(ARTWORK_FIXES_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}
