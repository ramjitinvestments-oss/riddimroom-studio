/**
 * Brand kit (v9 close-out) — the repeat-business defaults for the Promo
 * flow: call-to-action, sub-line and skin, saved on THIS device
 * (localStorage) and prefilled into the Promo page so a returning
 * business doesn't retype its identity on every promo. Deliberately
 * device-local for v1: no backend, no rules change, nothing leaves the
 * phone. Pure parse/serialize helpers are unit-tested; the storage
 * wrappers are thin and fail-soft (a full/blocked storage never breaks
 * the page).
 */
import type { PromoSkinId } from './recipes';

export interface BrandKit {
  ctaText: string;
  subText: string;
  skinId: PromoSkinId;
}

export const BRAND_KIT_STORAGE_KEY = 'riddimroom.brandKit.v1';

const SKIN_IDS: PromoSkinId[] = ['dancehall-raw', 'soca-shine', 'gospel-light', 'corporate-clean'];

export function parseBrandKit(raw: string | null): BrandKit | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<BrandKit>;
    if (typeof data.ctaText !== 'string' || typeof data.subText !== 'string') return null;
    if (!SKIN_IDS.includes(data.skinId as PromoSkinId)) return null;
    return { ctaText: data.ctaText, subText: data.subText, skinId: data.skinId as PromoSkinId };
  } catch {
    return null;
  }
}

export function loadBrandKit(): BrandKit | null {
  try {
    return parseBrandKit(window.localStorage.getItem(BRAND_KIT_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveBrandKit(kit: BrandKit): boolean {
  try {
    window.localStorage.setItem(BRAND_KIT_STORAGE_KEY, JSON.stringify(kit));
    return true;
  } catch {
    return false;
  }
}
