/**
 * R21 — the confirmed website profile + offer catalog (client side).
 *
 * A scan is a DRAFT. Nothing in here becomes campaign material until
 * the user reviews it on the profile screen and confirms: conflicts
 * resolved by their pick, fields editable, and every surviving value
 * keeps the provenance it arrived with (site layer + source page, or
 * 'user' when they typed/replaced it).
 *
 * Persistence follows the brand-kit pattern exactly: device-local
 * localStorage, pure parse/serialize helpers, fail-soft wrappers.
 * No Firestore in v1 — cross-device sync rides the coordinated
 * release session like everything else.
 */
import type { ExtractedSite, ExtractLayer, SiteImage } from './siteExtract';

export interface ProfileField {
  value: string;
  source: 'site' | 'user';
  sourceUrl?: string;
  layer?: ExtractLayer;
}

export interface SiteOffer {
  id: string;
  name: string;
  description?: string;
  price?: string;
  date?: string;
  url: string;
  services: string[];
  imageUrl?: string;
}

export interface SiteProfile {
  url: string;
  /** ISO timestamp of the scan this profile was confirmed from. */
  fetchedAt: string;
  name: ProfileField | null;
  tagline: ProfileField | null;
  phone: ProfileField | null;
  email: ProfileField | null;
  address: ProfileField | null;
  services: string[];
  hours: string[];
  palette: string[];
  fonts: string[];
  images: SiteImage[];
  offers: SiteOffer[];
}

export type ProfileFieldKey = 'name' | 'tagline' | 'phone' | 'email' | 'address';

export interface ApprovedFacts {
  businessName: string;
  services: string[];
  phones: string[];
  emails: string[];
  prices: string[];
  dates: string[];
  addresses: string[];
  offerNames: string[];
  /** Every approved string, for factual-token harvesting. */
  allText: string[];
}

/**
 * Build the profile the user is confirming: scan values by default,
 * conflict picks where they chose one, and typed edits (source 'user')
 * wherever they replaced a value. An edit to an empty string clears
 * the field — clearing is a decision, not a gap to refill.
 */
export function profileFromScan(
  scan: ExtractedSite,
  opts: {
    picks?: Partial<Record<'phone' | 'email', string>>;
    edits?: Partial<Record<ProfileFieldKey, string>>;
    fetchedAt?: string;
  } = {},
): SiteProfile {
  const fromScan = (sv: { value: string; layer: ExtractLayer; sourceUrl: string } | undefined): ProfileField | null =>
    sv ? { value: sv.value, source: 'site', sourceUrl: sv.sourceUrl, layer: sv.layer } : null;

  const pickField = (
    key: 'phone' | 'email',
    current: ProfileField | null,
  ): ProfileField | null => {
    const pick = opts.picks?.[key];
    if (!pick) return current;
    const conflict = scan.conflicts.find((c) => c.field === key);
    const chosen = conflict?.values.find((v) => v.value === pick);
    return chosen ? { value: chosen.value, source: 'site', sourceUrl: chosen.sourceUrl, layer: chosen.layer } : current;
  };

  const applyEdit = (key: ProfileFieldKey, current: ProfileField | null): ProfileField | null => {
    const edit = opts.edits?.[key];
    if (edit === undefined) return current;
    const v = edit.trim();
    if (!v) return null;
    return { value: v, source: 'user' };
  };

  return {
    url: scan.url,
    fetchedAt: opts.fetchedAt ?? new Date().toISOString(),
    name: applyEdit('name', fromScan(scan.name)),
    tagline: applyEdit('tagline', fromScan(scan.tagline)),
    phone: applyEdit('phone', pickField('phone', fromScan(scan.phone))),
    email: applyEdit('email', pickField('email', fromScan(scan.email))),
    address: applyEdit('address', fromScan(scan.address)),
    services: [...scan.services],
    hours: [...scan.hours],
    palette: [...scan.palette],
    fonts: [...scan.fonts],
    images: [...scan.images],
    offers: scan.offers.map((o, i) => ({
      id: `offer-${i}`,
      name: o.name,
      description: o.description,
      price: o.price,
      date: o.date,
      url: o.url,
      services: [...o.services],
      imageUrl: o.imageUrl,
    })),
  };
}

/** The approved record the campaign generator and fact-check live by. */
export function approvedFacts(profile: SiteProfile): ApprovedFacts {
  const prices: string[] = [];
  const dates: string[] = [];
  const allText: string[] = [];
  const pushText = (v: string | undefined | null) => {
    if (v && v.trim()) allText.push(v.trim());
  };
  pushText(profile.name?.value);
  pushText(profile.tagline?.value);
  pushText(profile.phone?.value);
  pushText(profile.email?.value);
  pushText(profile.address?.value);
  profile.services.forEach(pushText);
  profile.hours.forEach(pushText);
  for (const offer of profile.offers) {
    pushText(offer.name);
    pushText(offer.description);
    pushText(offer.price);
    pushText(offer.date);
    offer.services.forEach(pushText);
    if (offer.price) prices.push(offer.price);
    if (offer.date) dates.push(offer.date);
  }
  return {
    businessName: profile.name?.value ?? '',
    services: [...profile.services],
    phones: profile.phone ? [profile.phone.value] : [],
    emails: profile.email ? [profile.email.value] : [],
    prices,
    dates,
    addresses: profile.address ? [profile.address.value] : [],
    offerNames: profile.offers.map((o) => o.name),
    allText,
  };
}

export interface SiteCampaignPools {
  altHookPairs: Array<[string, string]>;
  altSubs: string[];
  altCtas: string[];
}

/**
 * Campaign line pools built ONLY from approved website facts. Creative
 * framing words ("CALL", "YOURS FOR") carry no facts of their own;
 * every name, service, price and number below arrived via the
 * confirmed profile.
 */
export function siteCampaignPools(profile: SiteProfile, offer: SiteOffer | null): SiteCampaignPools {
  const business = profile.name?.value ?? '';
  const tagline = profile.tagline?.value ?? '';
  const offerServices = offer && offer.services.length ? offer.services : profile.services;

  const altHookPairs: Array<[string, string]> = [];
  const addPair = (a: string, b: string) => {
    const pair: [string, string] = [a.trim(), b.trim()];
    if (!pair[0] || !pair[1] || pair[0].toUpperCase() === pair[1].toUpperCase()) return;
    if (!altHookPairs.some((p) => p[0].toUpperCase() === pair[0].toUpperCase() && p[1].toUpperCase() === pair[1].toUpperCase())) {
      altHookPairs.push(pair);
    }
  };
  if (offer) addPair(offer.name, tagline || offerServices[0] || business);
  if (business) addPair(business, tagline || offerServices[0] || '');

  const altSubs = [...new Set(offerServices.map((s) => s.trim()).filter(Boolean))];

  const altCtas: string[] = [];
  if (profile.phone?.value) altCtas.push(`CALL ${profile.phone.value}`);
  if (offer?.price) altCtas.push(`YOURS FOR ${offer.price}`);
  if (profile.email?.value) altCtas.push(`EMAIL ${profile.email.value}`);

  return { altHookPairs, altSubs, altCtas };
}

/* ------------------------------------------------------------------ */
/* Persistence (brand-kit pattern: pure parse + fail-soft storage)     */
/* ------------------------------------------------------------------ */

export const SITE_PROFILE_STORAGE_KEY = 'riddimroom.siteProfile.v1';

function parseField(raw: unknown): ProfileField | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Partial<ProfileField>;
  if (typeof f.value !== 'string' || !f.value.trim()) return null;
  return {
    value: f.value,
    source: f.source === 'user' ? 'user' : 'site',
    sourceUrl: typeof f.sourceUrl === 'string' ? f.sourceUrl : undefined,
    layer: f.layer,
  };
}

export function parseSiteProfile(raw: string | null): SiteProfile | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<SiteProfile>;
    if (typeof d.url !== 'string' || typeof d.fetchedAt !== 'string') return null;
    if (!Array.isArray(d.offers) || !Array.isArray(d.services)) return null;
    return {
      url: d.url,
      fetchedAt: d.fetchedAt,
      name: parseField(d.name),
      tagline: parseField(d.tagline),
      phone: parseField(d.phone),
      email: parseField(d.email),
      address: parseField(d.address),
      services: d.services.filter((s): s is string => typeof s === 'string'),
      hours: Array.isArray(d.hours) ? d.hours.filter((s): s is string => typeof s === 'string') : [],
      palette: Array.isArray(d.palette) ? d.palette.filter((s): s is string => typeof s === 'string') : [],
      fonts: Array.isArray(d.fonts) ? d.fonts.filter((s): s is string => typeof s === 'string') : [],
      images: Array.isArray(d.images) ? (d.images as SiteImage[]) : [],
      offers: (d.offers as SiteOffer[]).filter((o) => o && typeof o.name === 'string'),
    };
  } catch {
    return null;
  }
}

export function loadSiteProfile(): SiteProfile | null {
  try {
    return parseSiteProfile(window.localStorage.getItem(SITE_PROFILE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveSiteProfile(profile: SiteProfile): boolean {
  try {
    window.localStorage.setItem(SITE_PROFILE_STORAGE_KEY, JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}

export function clearSiteProfile(): void {
  try {
    window.localStorage.removeItem(SITE_PROFILE_STORAGE_KEY);
  } catch {
    /* storage unavailable — nothing to clear */
  }
}
