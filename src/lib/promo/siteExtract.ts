/**
 * R21 — Website fact extraction for URL campaigns (accuracy-first).
 *
 * Pure, zero-dependency, deterministic: this module NEVER invents a
 * fact. Every value it returns was copied verbatim from the page HTML
 * it was handed, and every value carries its provenance (which page,
 * which extraction layer). Layers run in trust order:
 *
 *   jsonld  — structured data the business published about itself
 *   meta    — Open Graph / Twitter / theme-color declarations
 *   structure — headings, nav, lists, links (the visible skeleton)
 *   text    — patterns over the visible text (footer contact blocks)
 *
 * Conflicts are REPORTED, never resolved: two different phone numbers
 * on the site produce a conflict entry and the user picks. Pages that
 * cannot be read (blocked, JavaScript-only shells) produce
 * `readable: false` with an honest reason — the caller falls back to
 * the upload flow instead of filling fields from a guess.
 *
 * $0 rule: no AI, no external service — string work only.
 */

export type ExtractLayer = 'jsonld' | 'meta' | 'structure' | 'text';

export interface SourcedValue {
  value: string;
  layer: ExtractLayer;
  sourceUrl: string;
}

export interface SiteImage {
  url: string;
  alt: string;
  role: 'og' | 'logo' | 'hero' | 'product' | 'image';
}

export interface SiteOfferDraft {
  name: string;
  description?: string;
  price?: string;
  date?: string;
  url: string;
  services: string[];
  imageUrl?: string;
}

export interface SiteConflict {
  field: 'phone' | 'email';
  values: SourcedValue[];
}

export interface SitePageDoc {
  url: string;
  html: string;
  status: number;
}

export interface ExtractedSite {
  url: string;
  readable: boolean;
  /** Why the site could not be read, when readable is false. */
  reason?: 'blocked' | 'http-error' | 'spa' | 'empty';
  name?: SourcedValue;
  tagline?: SourcedValue;
  phone?: SourcedValue;
  email?: SourcedValue;
  address?: SourcedValue;
  hours: string[];
  /** Verbatim service names, best source first, deduped. */
  services: string[];
  offers: SiteOfferDraft[];
  images: SiteImage[];
  palette: string[];
  fonts: string[];
  conflicts: SiteConflict[];
  /** Same-domain offer pages discovered on the homepage. */
  offerLinks: string[];
}

/* ------------------------------------------------------------------ */
/* Small HTML helpers (tokenizer-grade, not a full DOM — by design)    */
/* ------------------------------------------------------------------ */

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&rsquo;': '’', '&lsquo;': '‘',
  '&rdquo;': '”', '&ldquo;': '“', '&mdash;': '—', '&ndash;': '–',
  '&copy;': '©', '&reg;': '®', '&trade;': '™', '&hellip;': '…',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITY_MAP[m.toLowerCase()] ?? m);
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Visible text: scripts, styles and svg removed before stripping. */
export function visibleText(html: string): string {
  const noCode = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  return stripTags(noCode);
}

function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

function metaContent(html: string, keys: string[]): string | null {
  const tags = html.match(/<meta[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const a = parseAttrs(tag);
    const key = (a.property ?? a.name ?? '').toLowerCase();
    if (keys.includes(key) && a.content) return a.content.trim();
  }
  return null;
}

function resolveUrl(raw: string, base: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* JSON-LD                                                             */
/* ------------------------------------------------------------------ */

function jsonLdNodes(html: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node && typeof node === 'object') {
          const rec = node as Record<string, unknown>;
          out.push(rec);
          if (Array.isArray(rec['@graph'])) rec['@graph'].forEach(walk);
        }
      };
      walk(parsed);
    } catch {
      /* A broken JSON-LD block is ignored — never guessed at. */
    }
  }
  return out;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function addressToString(addr: unknown): string | null {
  if (typeof addr === 'string') return addr.trim() || null;
  if (addr && typeof addr === 'object') {
    const a = addr as Record<string, unknown>;
    const parts = [str(a.streetAddress), str(a.addressLocality), str(a.addressRegion), str(a.postalCode)]
      .filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }
  return null;
}

function offerNamesFromNode(node: Record<string, unknown>): string[] {
  const names: string[] = [];
  const collect = (v: unknown, depth: number): void => {
    if (Array.isArray(v)) return v.forEach((x) => collect(x, depth));
    if (v && typeof v === 'object') {
      const rec = v as Record<string, unknown>;
      const offered = rec.itemOffered as Record<string, unknown> | undefined;
      if (offered && str(offered.name)) names.push(str(offered.name)!);
      else if (depth > 0 && /service/i.test(String(rec['@type'] ?? '')) && str(rec.name)) {
        names.push(str(rec.name)!);
      }
      Object.values(rec).forEach((x) => collect(x, depth + 1));
    }
  };
  collect(node.hasOfferCatalog, 0);
  collect(node.makesOffer, 0);
  return names;
}

/* ------------------------------------------------------------------ */
/* Patterns                                                            */
/* ------------------------------------------------------------------ */

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PRICE_RE = /\$\s?\d[\d,]*(?:\.\d{2})?\b/;
const DATE_RE = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/;

export function normalizePhoneDigits(raw: string): string {
  const d = raw.replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

function findPhones(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PHONE_RE)) {
    const v = m[0].trim();
    if (normalizePhoneDigits(v).length === 10 && !out.includes(v)) out.push(v);
  }
  return out;
}

function findEmails(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(EMAIL_RE)) {
    const v = m[0].trim();
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

const GENERIC_LINK_TEXT = new Set([
  'home', 'about', 'about us', 'contact', 'contact us', 'book now', 'book online',
  'learn more', 'read more', 'get started', 'sign in', 'log in', 'login', 'sign up',
  'menu', 'blog', 'news', 'gallery', 'reviews', 'testimonials', 'faq', 'faqs',
  'privacy', 'privacy policy', 'terms', 'cart', 'checkout', 'account', 'search',
  'call now', 'call us', 'email us', 'directions', 'get directions', 'view all',
  'see all', 'more', 'back', 'next', 'previous', 'submit', 'shop now', 'buy now',
]);

/** A plausible service/offer label: short, word-like, not a sentence. */
function isServiceLabel(text: string): boolean {
  const t = text.trim();
  if (t.length < 3 || t.length > 48) return false;
  if (GENERIC_LINK_TEXT.has(t.toLowerCase())) return false;
  if (/[.!?]$/.test(t)) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  if (t.split(/\s+/).length > 6) return false;
  if (/\d{4,}/.test(t)) return false; // years / long numbers are not labels
  return true;
}

function anchorTexts(html: string): Array<{ text: string; href: string }> {
  const out: Array<{ text: string; href: string }> = [];
  const re = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const text = stripTags(m[3] ?? '');
    if (text) out.push({ text, href: m[1] ?? m[2] ?? '' });
  }
  return out;
}

function headingTexts(html: string, levels: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(${levels})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const t = stripTags(m[2] ?? '');
    if (t) out.push(t);
  }
  return out;
}

const OFFER_LINK_RE = /service|offer|product|menu|pricing|price|package|treatment|event|booking|shop|store|catalog/i;

export function discoverOfferLinks(html: string, baseUrl: string, cap = 6): string[] {
  const out: string[] = [];
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return out;
  }
  for (const a of anchorTexts(html)) {
    const resolved = resolveUrl(a.href, baseUrl);
    if (!resolved) continue;
    const u = new URL(resolved);
    if (u.origin !== base.origin) continue;
    if (u.pathname === base.pathname && !u.search) continue; // the homepage itself
    if (!OFFER_LINK_RE.test(u.pathname) && !OFFER_LINK_RE.test(a.text)) continue;
    const clean = u.origin + u.pathname;
    if (!out.includes(clean)) out.push(clean);
    if (out.length >= cap) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Images, palette, fonts                                              */
/* ------------------------------------------------------------------ */

function extractImages(html: string, pageUrl: string, nodes: Array<Record<string, unknown>>): SiteImage[] {
  const out: SiteImage[] = [];
  const push = (raw: string | null, alt: string, role: SiteImage['role']) => {
    if (!raw) return;
    const url = resolveUrl(raw, pageUrl);
    if (!url || url.startsWith('data:')) return;
    if (out.some((i) => i.url === url)) return;
    out.push({ url, alt, role });
  };
  push(metaContent(html, ['og:image', 'twitter:image']), 'Featured image', 'og');
  for (const node of nodes) {
    const img = node.image;
    if (typeof img === 'string') push(img, str(node.name) ?? '', 'product');
    if (img && typeof img === 'object') push(str((img as Record<string, unknown>).url), '', 'product');
  }
  const imgRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  let heroClaimed = out.some((i) => i.role === 'og');
  while ((m = imgRe.exec(html))) {
    const a = parseAttrs(m[0]);
    const raw = a.src ?? a['data-src'] ?? a['data-lazy-src'];
    if (!raw || raw.startsWith('data:')) continue;
    const w = Number(a.width ?? 0);
    const h = Number(a.height ?? 0);
    if ((w > 0 && w < 160) || (h > 0 && h < 60)) continue; // icons / spacers
    const hint = `${raw} ${a.alt ?? ''} ${a.class ?? ''}`.toLowerCase();
    let role: SiteImage['role'] = 'image';
    if (hint.includes('logo')) role = 'logo';
    else if (!heroClaimed && (w >= 800 || out.length <= 1)) {
      role = 'hero';
      heroClaimed = true;
    }
    push(raw, a.alt ?? '', role);
  }
  const rank: Record<SiteImage['role'], number> = { og: 0, logo: 1, hero: 2, product: 3, image: 4 };
  return out.sort((x, y) => rank[x.role] - rank[y.role]).slice(0, 12);
}

function extractPalette(html: string): string[] {
  const out: string[] = [];
  const theme = metaContent(html, ['theme-color']);
  if (theme && /^#?[0-9a-f]{3,8}$/i.test(theme.trim())) {
    out.push(theme.trim().startsWith('#') ? theme.trim().toUpperCase() : `#${theme.trim().toUpperCase()}`);
  }
  const counts = new Map<string, number>();
  for (const m of html.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
    const hex = m[0].toUpperCase();
    if (hex === '#FFFFFF' || hex === '#000000') continue;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  for (const [hex] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    if (!out.includes(hex)) out.push(hex);
    if (out.length >= 5) break;
  }
  return out;
}

const GENERIC_FONTS = new Set(['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'inherit', 'initial']);

function extractFonts(html: string): string[] {
  const counts = new Map<string, number>();
  for (const m of html.matchAll(/font-family\s*:\s*([^;}"']+)/gi)) {
    const first = m[1].split(',')[0].trim().replace(/^["']|["']$/g, '');
    if (!first || GENERIC_FONTS.has(first.toLowerCase())) continue;
    counts.set(first, (counts.get(first) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([f]) => f);
}

/* ------------------------------------------------------------------ */
/* The extractor                                                       */
/* ------------------------------------------------------------------ */

export function extractSite(pages: SitePageDoc[]): ExtractedSite {
  const home = pages[0];
  const base: ExtractedSite = {
    url: home?.url ?? '',
    readable: false,
    services: [],
    offers: [],
    images: [],
    palette: [],
    fonts: [],
    conflicts: [],
    offerLinks: [],
    hours: [],
  };
  if (!home) return { ...base, reason: 'empty' };
  if (home.status === 403 || home.status === 401) return { ...base, reason: 'blocked' };
  if (home.status >= 400) return { ...base, reason: 'http-error' };

  const html = home.html ?? '';
  const text = visibleText(html);
  // R24 (WS-C4): mine the JSON-LD BEFORE judging the body. A small
  // business page can carry almost no visible text yet publish its
  // whole identity as structured data — the old thin-body rejection
  // threw that data away (it labelled a dentist's page "spa") and
  // the campaign pools came back empty. Structured data rescues a
  // thin page; a script shell with NO structured data still fails
  // honestly as an SPA.
  const nodes = jsonLdNodes(html);
  if (text.length < 40) {
    const hasStructured = nodes.some(
      (n) => str(n.name) || str(n.telephone) || str(n.email) || offerNamesFromNode(n).length > 0,
    );
    if (!hasStructured) {
      return { ...base, reason: /<script/i.test(html) ? 'spa' : 'empty' };
    }
  }
  const bizNode = nodes.find((n) => /business|organization|store|restaurant|service/i.test(String(n['@type'] ?? ''))) ?? nodes[0];

  /* --- name (jsonld > og:site_name > title > h1) --- */
  let name: SourcedValue | undefined;
  const ldName = bizNode ? str(bizNode.name) : null;
  if (ldName) name = { value: ldName, layer: 'jsonld', sourceUrl: home.url };
  const ogSite = metaContent(html, ['og:site_name']);
  if (!name && ogSite) name = { value: ogSite, layer: 'meta', sourceUrl: home.url };
  const titleRaw = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const titleName = stripTags(titleRaw).split(/\s*[|–—·»-]\s*/)[0]?.trim();
  if (!name && titleName) name = { value: titleName, layer: 'structure', sourceUrl: home.url };
  const h1 = headingTexts(html, 'h1')[0];
  if (!name && h1) name = { value: h1, layer: 'structure', sourceUrl: home.url };

  /* --- tagline --- */
  let tagline: SourcedValue | undefined;
  const slogan = bizNode ? str(bizNode.slogan) : null;
  if (slogan) tagline = { value: slogan, layer: 'jsonld', sourceUrl: home.url };
  const ogDesc = metaContent(html, ['og:description', 'description']);
  if (!tagline && ogDesc && ogDesc.length <= 90) tagline = { value: ogDesc, layer: 'meta', sourceUrl: home.url };

  /* --- phones & emails: collect ALL candidates (conflicts matter) --- */
  const phoneCandidates: SourcedValue[] = [];
  const addPhone = (value: string, layer: ExtractLayer, sourceUrl: string) => {
    if (normalizePhoneDigits(value).length !== 10) return;
    if (!phoneCandidates.some((p) => normalizePhoneDigits(p.value) === normalizePhoneDigits(value))) {
      phoneCandidates.push({ value: value.trim(), layer, sourceUrl });
    }
  };
  const emailCandidates: SourcedValue[] = [];
  const addEmail = (value: string, layer: ExtractLayer, sourceUrl: string) => {
    const v = value.trim();
    if (!emailCandidates.some((e) => e.value.toLowerCase() === v.toLowerCase())) {
      emailCandidates.push({ value: v, layer, sourceUrl });
    }
  };
  for (const page of pages) {
    const pNodes = jsonLdNodes(page.html);
    for (const n of pNodes) {
      if (str(n.telephone)) addPhone(str(n.telephone)!, 'jsonld', page.url);
      if (str(n.email)) addEmail(str(n.email)!, 'jsonld', page.url);
    }
    const pText = visibleText(page.html);
    for (const p of findPhones(pText)) addPhone(p, 'text', page.url);
    for (const e of findEmails(pText)) addEmail(e, 'text', page.url);
    for (const a of anchorTexts(page.html)) {
      if (a.href.startsWith('tel:')) addPhone(a.href.replace(/^tel:/, '').replace(/%20/g, ' '), 'structure', page.url);
      if (a.href.startsWith('mailto:')) addEmail(a.href.replace(/^mailto:/, '').split('?')[0], 'structure', page.url);
    }
  }
  const conflicts: SiteConflict[] = [];
  if (phoneCandidates.length > 1) conflicts.push({ field: 'phone', values: phoneCandidates });
  if (emailCandidates.length > 1) conflicts.push({ field: 'email', values: emailCandidates });
  const layerRank: Record<ExtractLayer, number> = { jsonld: 0, meta: 1, structure: 2, text: 3 };
  const byTrust = (a: SourcedValue, b: SourcedValue) => layerRank[a.layer] - layerRank[b.layer];
  const phone = [...phoneCandidates].sort(byTrust)[0];
  const email = [...emailCandidates].sort(byTrust)[0];

  /* --- address & hours (jsonld only — too easy to garble from text) --- */
  let address: SourcedValue | undefined;
  const hours: string[] = [];
  if (bizNode) {
    const a = addressToString(bizNode.address);
    if (a) address = { value: a, layer: 'jsonld', sourceUrl: home.url };
    const oh = bizNode.openingHours;
    if (typeof oh === 'string') hours.push(oh);
    if (Array.isArray(oh)) for (const h of oh) if (typeof h === 'string') hours.push(h);
  }

  /* --- services --- */
  const serviceSet: string[] = [];
  const addService = (s: string | null) => {
    if (!s) return;
    const t = s.trim();
    if (!isServiceLabel(t)) return;
    if (!serviceSet.some((x) => x.toLowerCase() === t.toLowerCase())) serviceSet.push(t);
  };
  if (bizNode) offerNamesFromNode(bizNode).forEach(addService);
  for (const n of nodes) {
    const t = String(n['@type'] ?? '');
    if (/product|service/i.test(t)) addService(str(n.name));
  }
  // Nav / list link labels on the homepage are service candidates.
  for (const a of anchorTexts(html)) {
    if (OFFER_LINK_RE.test(a.href) || /service/i.test(a.href)) addService(a.text);
  }

  /* --- offers: JSON-LD products/events anywhere + offer pages --- */
  const offers: SiteOfferDraft[] = [];
  const pushOffer = (o: SiteOfferDraft) => {
    if (!o.name || offers.some((x) => x.name.toLowerCase() === o.name.toLowerCase() && x.url === o.url)) return;
    offers.push(o);
  };
  for (const page of pages) {
    const pNodes = jsonLdNodes(page.html);
    for (const n of pNodes) {
      const t = String(n['@type'] ?? '');
      const nName = str(n.name);
      if (!nName) continue;
      if (/product/i.test(t)) {
        const offersObj = (Array.isArray(n.offers) ? n.offers[0] : n.offers) as Record<string, unknown> | undefined;
        const priceRaw = offersObj ? offersObj.price : undefined;
        const currency = offersObj && typeof offersObj.priceCurrency === 'string' ? offersObj.priceCurrency : '';
        const price = typeof priceRaw === 'number' || typeof priceRaw === 'string'
          ? `${currency === 'USD' || !currency ? '$' : `${currency} `}${priceRaw}`
          : undefined;
        const img = typeof n.image === 'string' ? resolveUrl(n.image, page.url) ?? undefined : undefined;
        pushOffer({ name: nName, description: str(n.description) ?? undefined, price, url: page.url, services: [], imageUrl: img });
      }
      if (/event/i.test(t)) {
        const img = typeof n.image === 'string' ? resolveUrl(n.image, page.url) ?? undefined : undefined;
        pushOffer({ name: nName, description: str(n.description) ?? undefined, date: str(n.startDate) ?? undefined, url: page.url, services: [], imageUrl: img });
      }
    }
    if (page.url !== home.url) {
      // A linked offer page with no structured offer still becomes a
      // draft offer from its own heading — labelled structure, and the
      // user confirms it before anything is generated from it.
      const pH1 = headingTexts(page.html, 'h1')[0];
      const pTitle = stripTags((page.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')).split(/\s*[|–—·-]\s*/)[0]?.trim();
      const offerName = pH1 ?? pTitle;
      if (offerName && offerName.toLowerCase() !== (name?.value ?? '').toLowerCase()) {
        const pText = visibleText(page.html);
        const priceMatch = pText.match(PRICE_RE);
        const dateMatch = pText.match(DATE_RE);
        const pageServices: string[] = [];
        for (const li of page.html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
          const t = stripTags(li[1] ?? '');
          if (isServiceLabel(t) && !pageServices.includes(t)) pageServices.push(t);
          if (pageServices.length >= 12) break;
        }
        const ogImg = metaContent(page.html, ['og:image']);
        pushOffer({
          name: offerName,
          price: priceMatch ? priceMatch[0].replace(/\s+/g, ' ').trim() : undefined,
          date: dateMatch ? dateMatch[0].trim() : undefined,
          url: page.url,
          services: pageServices,
          imageUrl: ogImg ? resolveUrl(ogImg, page.url) ?? undefined : undefined,
        });
        pageServices.forEach(addService);
      }
    }
  }

  return {
    url: home.url,
    readable: true,
    name,
    tagline,
    phone,
    email,
    address,
    hours,
    services: serviceSet.slice(0, 16),
    offers: offers.slice(0, 8),
    images: extractImages(html, home.url, nodes),
    palette: extractPalette(html),
    fonts: extractFonts(html),
    conflicts,
    offerLinks: discoverOfferLinks(html, home.url),
  };
}
