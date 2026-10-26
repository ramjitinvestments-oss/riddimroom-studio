import { describe, expect, it } from 'vitest';
import { extractSite, type SitePageDoc } from './siteExtract';
import { approvedFacts, parseSiteProfile, profileFromScan, siteCampaignPools } from './siteProfile';
import { checkFactTexts, factTokens, lineFactsApproved } from './factCheck';

const CONFLICT_SITE: SitePageDoc = {
  url: 'https://dual.example/',
  status: 200,
  html: `<html><head><title>Dual Number Dental</title>
  <script type="application/ld+json">
  {"@type":"Dentist","name":"Dual Number Dental","telephone":"(212) 555-0100",
   "hasOfferCatalog":{"@type":"OfferCatalog","itemListElement":[
     {"@type":"Offer","itemOffered":{"@type":"Service","name":"Teeth Whitening"}},
     {"@type":"Offer","itemOffered":{"@type":"Service","name":"Root Canal"}}]}}
  </script></head><body><h1>Dual Number Dental</h1>
  <footer><p>Emergencies: (917) 555-0199</p></footer></body></html>`,
};

describe('R21 site profile', () => {
  it('keeps the user’s conflict pick with its site provenance', () => {
    const scan = extractSite([CONFLICT_SITE]);
    const profile = profileFromScan(scan, { picks: { phone: '(917) 555-0199' } });
    expect(profile.phone?.value).toBe('(917) 555-0199');
    expect(profile.phone?.source).toBe('site');
    expect(profile.name?.value).toBe('Dual Number Dental');
  });

  it('a typed edit overrides the scan and is marked as the user’s', () => {
    const scan = extractSite([CONFLICT_SITE]);
    const profile = profileFromScan(scan, { edits: { phone: '(646) 555-0123' } });
    expect(profile.phone?.value).toBe('(646) 555-0123');
    expect(profile.phone?.source).toBe('user');
  });

  it('clearing a field keeps it empty — never refilled', () => {
    const scan = extractSite([CONFLICT_SITE]);
    const profile = profileFromScan(scan, { edits: { phone: '' } });
    expect(profile.phone).toBeNull();
  });

  it('pools are built only from approved facts', () => {
    const scan = extractSite([CONFLICT_SITE]);
    const profile = profileFromScan(scan, { picks: { phone: '(212) 555-0100' } });
    const pools = siteCampaignPools(profile, null);
    expect(pools.altSubs).toEqual(expect.arrayContaining(['Teeth Whitening', 'Root Canal']));
    expect(pools.altCtas).toContain('CALL (212) 555-0100');
    expect(pools.altCtas.join(' ')).not.toContain('555-0199');
  });

  it('round-trips through storage serialization', () => {
    const scan = extractSite([CONFLICT_SITE]);
    const profile = profileFromScan(scan, {});
    const parsed = parseSiteProfile(JSON.stringify(profile));
    expect(parsed?.name?.value).toBe('Dual Number Dental');
    expect(parsed?.services).toEqual(profile.services);
    expect(parseSiteProfile('{"nope":1}')).toBeNull();
    expect(parseSiteProfile(null)).toBeNull();
  });
});

describe('R21 factual receipt', () => {
  const scan = extractSite([CONFLICT_SITE]);
  const profile = profileFromScan(scan, { picks: { phone: '(212) 555-0100' } });
  const facts = approvedFacts(profile);

  it('passes a campaign whose numbers all trace to the profile', () => {
    const receipt = checkFactTexts(
      [{ label: 'Master cut', texts: ['DUAL NUMBER DENTAL', 'Teeth Whitening', 'CALL (212) 555-0100'] }],
      facts,
    );
    expect(receipt.clean).toBe(true);
    expect(receipt.summaryLine).toBe('Facts checked against your website');
  });

  it('catches a planted wrong phone number and a planted price', () => {
    const receipt = checkFactTexts(
      [{ label: 'Alt hook 1', texts: ['CALL (212) 555-9999', 'YOURS FOR $39'] }],
      facts,
    );
    expect(receipt.clean).toBe(false);
    expect(receipt.flags.map((f) => f.token)).toEqual(expect.arrayContaining(['(212) 555-9999', '$39']));
    expect(receipt.flags.length).toBeGreaterThanOrEqual(2);
    expect(receipt.flags[0].label).toBe('Alt hook 1');
  });

  it('does not flag creative counts or the approved phone re-split', () => {
    expect(lineFactsApproved('TOP 5 REASONS TO SMILE', facts)).toBe(true);
    expect(lineFactsApproved('CALL 212 555 0100 TODAY', facts)).toBe(true);
  });

  it('tokenizes prices and phone fragments as factual', () => {
    const tokens = factTokens('ONLY $24.00 — CALL 555-0147');
    expect(tokens.map((t) => t.digits)).toEqual(expect.arrayContaining(['2400', '5550147']));
  });
});
