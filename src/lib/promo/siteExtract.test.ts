/**
 * R21 fixture suite — ten hand-built sites with known ground truth.
 * The pass/fail line is PRECISION: nothing may be extracted that is
 * not on the page. Recall is asserted on the structured fixtures;
 * conflicts must surface, and unreadable sites must fail honestly.
 */
import { describe, expect, it } from 'vitest';
import { extractSite, type SitePageDoc } from './siteExtract';

const page = (url: string, html: string, status = 200): SitePageDoc => ({ url, html, status });

/* 1 — Plumber with full LocalBusiness JSON-LD */
const PLUMBER = page('https://rapidflowplumbing.com/', `
<html><head><title>Rapid Flow Plumbing | Austin</title>
<meta name="theme-color" content="#0B5FA5">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Plumber","name":"Rapid Flow Plumbing",
 "telephone":"+1 (512) 555-0147","email":"book@rapidflowplumbing.com",
 "slogan":"Fast, honest plumbing",
 "address":{"@type":"PostalAddress","streetAddress":"1200 Congress Ave","addressLocality":"Austin","addressRegion":"TX","postalCode":"78701"},
 "openingHours":"Mo-Fr 08:00-18:00",
 "hasOfferCatalog":{"@type":"OfferCatalog","name":"Services","itemListElement":[
   {"@type":"Offer","itemOffered":{"@type":"Service","name":"Emergency Repairs"}},
   {"@type":"Offer","itemOffered":{"@type":"Service","name":"Water Heater Installation"}},
   {"@type":"Offer","itemOffered":{"@type":"Service","name":"Drain Cleaning"}}]}}
</script></head>
<body><h1>Rapid Flow Plumbing</h1><p>Call (512) 555-0147 today.</p></body></html>`);

/* 2 — Restaurant whose menu is a linked offer page */
const RESTO_HOME = page('https://islandbite.example/', `
<html><head><title>Island Bite Kitchen</title></head><body>
<nav><a href="/menu">Our Menu</a><a href="/about">About</a></nav>
<h1>Island Bite Kitchen</h1><p>Caribbean comfort food, served fresh daily.</p>
</body></html>`);
const RESTO_MENU = page('https://islandbite.example/menu', `
<html><head><title>Menu | Island Bite Kitchen</title></head><body>
<h1>Our Menu</h1>
<ul><li>Jerk Chicken Plate</li><li>Oxtail Stew</li><li>Curry Goat Roti</li></ul>
</body></html>`);

/* 3 — Product page with Product JSON-LD + price */
const SHOP_HOME = page('https://shop.example/', `
<html><head><title>Harbor Candle Co.</title></head><body><h1>Harbor Candle Co.</h1>
<p>Hand-poured candles.</p><a href="/products/sea-glass">Sea Glass Candle</a></body></html>`);
const SHOP_PRODUCT = page('https://shop.example/products/sea-glass', `
<html><head><title>Sea Glass Candle | Harbor Candle Co.</title>
<script type="application/ld+json">
{"@type":"Product","name":"Sea Glass Candle","description":"Soy candle with sea salt scent",
 "image":"https://shop.example/img/sea-glass.jpg",
 "offers":{"@type":"Offer","price":"24.00","priceCurrency":"USD"}}
</script></head><body><h1>Sea Glass Candle</h1></body></html>`);

/* 4 — Event page with a real date */
const EVENT_PAGE = page('https://soca-on-the-lawn.example/', `
<html><head><title>Soca on the Lawn</title>
<script type="application/ld+json">
{"@type":"Event","name":"Soca on the Lawn","startDate":"2026-12-20T18:00:00",
 "description":"An open-air soca celebration"}
</script></head><body><h1>Soca on the Lawn</h1><p>December 20, 2026 at the Grand Hall.</p></body></html>`);

/* 5 — OG-only page */
const OG_PAGE = page('https://brightpath.example/', `
<html><head><title>BrightPath Tutoring — Math & Reading Help</title>
<meta property="og:site_name" content="BrightPath Tutoring">
<meta property="og:description" content="One-on-one tutoring that works">
<meta property="og:image" content="https://brightpath.example/hero.jpg">
<meta name="theme-color" content="#FFD100">
</head><body><h1>Tutoring</h1><p>Reach us at (718) 555-0119 for a free assessment.</p></body></html>`);

/* 6 — Messy page: facts only in body + footer */
const MESSY = page('https://joes-auto.example/', `
<html><head><title>Joe's Auto Repair</title></head><body>
<nav><a href="/services/brakes">Brake Service</a><a href="/services/oil">Oil Changes</a></nav>
<h1>Joe's Auto Repair</h1><p>Family owned since 1998. Walk-ins welcome.</p>
<footer><p>Call us: 347-555-0163 · joe@joes-auto.example</p></footer>
</body></html>`);

/* 7 — Conflict page: two different phone numbers */
const CONFLICT = page('https://dual.example/', `
<html><head><title>Dual Number Dental</title>
<script type="application/ld+json">
{"@type":"Dentist","name":"Dual Number Dental","telephone":"(212) 555-0100"}
</script></head><body>
<header><p>Appointments: (212) 555-0100</p></header>
<h1>Dual Number Dental</h1>
<footer><p>After hours emergencies: (917) 555-0199</p></footer>
</body></html>`);

/* 8 — SPA shell: script-only, no readable content */
const SPA = page('https://spa.example/', `
<html><head><title>App</title><script src="/assets/index-abc123.js"></script></head>
<body><div id="root"></div></body></html>`);

/* 10 — Stale page: retired offer beside the current one (both must extract) */
const STALE = page('https://bakery.example/', `
<html><head><title>Golden Crust Bakery</title></head><body>
<h1>Golden Crust Bakery</h1>
<section><h2>Holiday Fruit Cake — now retired</h2></section>
<a href="/products/sourdough">Fresh Sourdough Loaf</a>
</body></html>`);
const STALE_PRODUCT = page('https://bakery.example/products/sourdough', `
<html><head><title>Fresh Sourdough Loaf | Golden Crust Bakery</title></head>
<body><h1>Fresh Sourdough Loaf</h1><p>Baked daily. Price $8.50 per loaf.</p></body></html>`);

describe('R21 site extraction fixtures', () => {
  it('1. reads a structured local business exactly (precision + recall)', () => {
    const site = extractSite([PLUMBER]);
    expect(site.readable).toBe(true);
    expect(site.name?.value).toBe('Rapid Flow Plumbing');
    expect(site.name?.layer).toBe('jsonld');
    expect(site.phone?.value).toBe('+1 (512) 555-0147');
    expect(site.email?.value).toBe('book@rapidflowplumbing.com');
    expect(site.address?.value).toContain('1200 Congress Ave');
    expect(site.hours).toContain('Mo-Fr 08:00-18:00');
    expect(site.services).toEqual(['Emergency Repairs', 'Water Heater Installation', 'Drain Cleaning']);
    expect(site.palette[0]).toBe('#0B5FA5');
    expect(site.conflicts).toEqual([]);
  });

  it('2. discovers the linked menu page and builds an offer from it', () => {
    const home = extractSite([RESTO_HOME]);
    expect(home.offerLinks).toContain('https://islandbite.example/menu');
    const full = extractSite([RESTO_HOME, RESTO_MENU]);
    const menu = full.offers.find((o) => o.url.endsWith('/menu'));
    expect(menu).toBeTruthy();
    expect(menu!.services).toEqual(expect.arrayContaining(['Jerk Chicken Plate', 'Oxtail Stew', 'Curry Goat Roti']));
  });

  it('3. reads a product price and image from Product JSON-LD', () => {
    const site = extractSite([SHOP_HOME, SHOP_PRODUCT]);
    const product = site.offers.find((o) => o.name === 'Sea Glass Candle');
    expect(product).toBeTruthy();
    expect(product!.price).toBe('$24.00');
    expect(product!.imageUrl).toBe('https://shop.example/img/sea-glass.jpg');
  });

  it('4. reads a real event date for countdown campaigns', () => {
    const site = extractSite([EVENT_PAGE]);
    const ev = site.offers.find((o) => o.name === 'Soca on the Lawn');
    expect(ev).toBeTruthy();
    expect(ev!.date).toBe('2026-12-20T18:00:00');
  });

  it('5. falls back to Open Graph + visible text when there is no schema', () => {
    const site = extractSite([OG_PAGE]);
    expect(site.name?.value).toBe('BrightPath Tutoring');
    expect(site.name?.layer).toBe('meta');
    expect(site.phone?.value).toBe('(718) 555-0119');
    expect(site.images[0]?.role).toBe('og');
    expect(site.images[0]?.url).toBe('https://brightpath.example/hero.jpg');
    expect(site.palette[0]).toBe('#FFD100');
  });

  it('6. reads a messy page from structure + footer without inventing fields', () => {
    const site = extractSite([MESSY]);
    expect(site.name?.value).toBe("Joe's Auto Repair");
    expect(site.phone?.value).toBe('347-555-0163');
    expect(site.email?.value).toBe('joe@joes-auto.example');
    expect(site.services).toEqual(expect.arrayContaining(['Brake Service', 'Oil Changes']));
    expect(site.address).toBeUndefined(); // not on the page — stays empty
  });

  it('7. surfaces two different phone numbers as a conflict, never a silent pick', () => {
    const site = extractSite([CONFLICT]);
    const conflict = site.conflicts.find((c) => c.field === 'phone');
    expect(conflict).toBeTruthy();
    expect(conflict!.values.map((v) => v.value)).toEqual(
      expect.arrayContaining(['(212) 555-0100', '(917) 555-0199']),
    );
  });

  it('8. fails a JavaScript-only shell honestly as an SPA', () => {
    const site = extractSite([SPA]);
    expect(site.readable).toBe(false);
    expect(site.reason).toBe('spa');
  });

  it('9. fails a blocked page honestly', () => {
    const site = extractSite([page('https://walled.example/', '<html></html>', 403)]);
    expect(site.readable).toBe(false);
    expect(site.reason).toBe('blocked');
  });

  it('10. extracts current offers without erasing or inventing the retired one', () => {
    const site = extractSite([STALE, STALE_PRODUCT]);
    const loaf = site.offers.find((o) => o.name === 'Fresh Sourdough Loaf');
    expect(loaf).toBeTruthy();
    expect(loaf!.price).toBe('$8.50');
    // Nothing anywhere claims the retired cake is current: it appears
    // only as page content, never as an extracted offer.
    expect(site.offers.some((o) => /Fruit Cake/i.test(o.name))).toBe(false);
  });

  it('precision sweep: no extracted service contains words absent from its page', () => {
    const site = extractSite([PLUMBER]);
    const pageText = PLUMBER.html.toUpperCase();
    for (const s of site.services) {
      for (const word of s.toUpperCase().split(/\s+/)) {
        expect(pageText).toContain(word);
      }
    }
  });
});
