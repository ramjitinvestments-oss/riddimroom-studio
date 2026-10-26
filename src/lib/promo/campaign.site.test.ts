/**
 * R21 — the planner's fact guard: with a website profile driving the
 * campaign, a genre-bank line carrying an unapproved number must
 * never reach a piece, while caller pools (approved site facts) and
 * digit-free bank lines still rotate.
 */
import { describe, expect, it } from 'vitest';
import { planCampaign } from './campaign';
import { approvedFacts, profileFromScan } from './siteProfile';
import { extractSite, type SitePageDoc } from './siteExtract';
import { lineFactsApproved } from './factCheck';

const SITE: SitePageDoc = {
  url: 'https://dual.example/',
  status: 200,
  html: `<html><head><title>Dual Number Dental</title>
  <script type="application/ld+json">
  {"@type":"Dentist","name":"Dual Number Dental","telephone":"(212) 555-0100",
   "hasOfferCatalog":{"@type":"OfferCatalog","itemListElement":[
     {"@type":"Offer","itemOffered":{"@type":"Service","name":"Teeth Whitening"}},
     {"@type":"Offer","itemOffered":{"@type":"Service","name":"Root Canal"}}]}}
  </script></head><body><h1>Dual Number Dental</h1></body></html>`,
};

describe('R21 campaign fact guard', () => {
  it('no piece carries a digit string absent from the approved profile', () => {
    const profile = profileFromScan(extractSite([SITE]), {});
    const facts = approvedFacts(profile);
    const guard = (line: string) => lineFactsApproved(line, facts);
    const plan = planCampaign({
      texts: { hook1: 'DUAL NUMBER DENTAL', hook2: 'TEETH WHITENING', sub: 'Root Canal', cta: 'CALL (212) 555-0100' },
      masterRecipe: 'slam',
      masterFormatId: '9:16',
      kind: 'flyer',
      genre: 'business',
      factGuard: guard,
    });
    const approvedDigits = new Set(['2125550100', '212', '5550100']);
    for (const piece of plan.pieces) {
      for (const text of Object.values(piece.texts)) {
        if (!text) continue;
        for (const run of text.match(/\d[\d,./:-]*\d|\d/g) ?? []) {
          const digits = run.replace(/\D/g, '');
          if (digits.length < 3) continue;
          expect(
            approvedDigits.has(digits) || '2125550100'.includes(digits),
            `piece ${piece.label} carries unapproved digits "${run}" in "${text}"`,
          ).toBe(true);
        }
      }
    }
  });

  it('without the guard the planner behaves exactly as before', () => {
    const plan = planCampaign({
      texts: { hook1: 'DUAL NUMBER DENTAL', hook2: 'TEETH WHITENING', sub: 'Root Canal', cta: 'CALL (212) 555-0100' },
      masterRecipe: 'slam',
      masterFormatId: '9:16',
      kind: 'flyer',
      genre: 'business',
    });
    expect(plan.pieces.length).toBeGreaterThan(1);
  });
});
