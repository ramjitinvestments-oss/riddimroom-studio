/**
 * R24 golden tests — the audit scenarios (~/workspace/audit-r24)
 * made permanent. Each scenario runs the REAL pipeline the page
 * runs (planCampaign → recipe build → stage/homecoming/layout →
 * caption conversion in BOTH modes → buildSocialPosts from the
 * planner texts + resolved context) and asserts the R24 contract:
 *
 *   - the user's hook + CTA appear in every generated post
 *   - no post headline is a countdown number
 *   - the CTA slot holds the piece's CTA (never the sub)
 *   - tags match the RESOLVED context (dentist/product ≠ party)
 *   - 'look' pieces stay silent; site pools are non-empty
 *   - hook ≠ cta in every piece; exactly 5 hashtags, #RiddimRoom ×1
 */
import { describe, expect, it } from 'vitest';
import { createEmptyProject, createTrack, addTrack } from '../timeline/utils';
import type { MediaAsset, Project } from '../../types/timeline';
import { planCampaign, parseEventDate, type CampaignPiece } from './campaign';
import { buildSlamProject, buildCountdownProject, buildNewsflashProject } from './recipes';
import { applyStageBackdrop, applyHomecoming } from './camera';
import { enforceTextLayout } from './layout';
import { convertPromoTextToCaptions } from './viralCaptions';
import { buildSocialPosts, detectPostGenre, truncateAtWord, type SocialPost } from '../export/socialPosts';
import {
  bankSuggestion, fieldAlternates, resolveCampaignContext, type SuggestionContext,
} from './suggest';
import { profileFromScan, approvedFacts, siteCampaignPools } from './siteProfile';
import { extractSite, type SitePageDoc } from './siteExtract';
import { lineFactsApproved, checkFactTexts } from './factCheck';

const art: MediaAsset = {
  id: 'asset-art', kind: 'image', storageUrl: '', fileName: 'art.png', sizeBytes: 1000,
  mimeType: 'image/png', width: 1080, height: 1350, createdAt: 0,
};

function freshProject(name: string): Project {
  let p = createEmptyProject({ ownerUid: 'r24', name, canvasWidth: 1080, canvasHeight: 1920 });
  const specs: Array<[any, string]> = [['video', 'Main Video'], ['image', 'Watermark'], ['text', 'Text'], ['caption', 'Captions'], ['audio', 'Original Audio']];
  specs.forEach(([t, n], i) => { p = addTrack(p, createTrack(t, n, i)); });
  return p;
}

function buildPieceProject(base: string, piece: CampaignPiece, mode: 'words' | 'lines'): Project {
  let project = freshProject(`Viral Promo — ${base} (${piece.label})`);
  const opts = { duration: 12 };
  switch (piece.recipe) {
    case 'slam': case 'spin-slam':
      project = buildSlamProject(project, art, piece.texts, { ...opts, variant: piece.recipe === 'spin-slam' ? 'spin' : 'slam' }); break;
    case 'countdown':
      project = buildCountdownProject(project, art, piece.texts, opts); break;
    case 'newsflash':
      project = buildNewsflashProject(project, art, piece.texts, opts); break;
    default:
      project = buildSlamProject(project, art, piece.texts, opts);
  }
  project = applyStageBackdrop(project);
  project = applyHomecoming(project);
  project = enforceTextLayout(project);
  if (mode === 'words') {
    project = convertPromoTextToCaptions(project,
      [piece.texts.hook1 ?? '', piece.texts.hook2 ?? '', piece.texts.sub ?? '', piece.texts.cta ?? ''], [], undefined, 1);
  }
  return project;
}

function pairsFor(ctx: SuggestionContext, genre: Parameters<typeof fieldAlternates>[2]): Array<[string, string]> {
  const h1 = fieldAlternates('hook1', ctx, genre);
  const h2 = fieldAlternates('hook2', ctx, genre);
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < Math.min(h1.length, h2.length); i++) pairs.push([h1[i], h2[i]]);
  return pairs;
}

const hookOf = (p: CampaignPiece) => [p.texts.hook1 ?? '', p.texts.hook2 ?? ''].filter(Boolean).join(' ').trim();

function expectTagInvariant(posts: SocialPost[]) {
  for (const post of posts) {
    expect(post.hashtags, post.platform).toHaveLength(5);
    expect(new Set(post.hashtags).size, post.platform).toBe(5);
    expect(post.hashtags.filter((h) => h === '#RiddimRoom'), post.platform).toHaveLength(1);
    expect(post.text.match(/#\w+/g) ?? [], post.platform).toHaveLength(5);
  }
}

function expectPostsCarryPiece(posts: SocialPost[], piece: CampaignPiece) {
  const hook = hookOf(piece);
  const cta = (piece.texts.cta ?? '').trim();
  const sub = (piece.texts.sub ?? '').trim();
  for (const post of posts) {
    if (hook) expect(post.text, `${piece.id}/${post.platform} hook`).toContain(hook);
    if (cta) expect(post.text, `${piece.id}/${post.platform} cta`).toContain(cta);
    // No headline is a countdown number (B2): the first line of the
    // TikTok post and the Shorts title are never a bare digit run.
    const firstLine = post.platform === 'shorts' ? (post.title ?? '') : post.text.split('\n')[0];
    expect(firstLine.replace(/ 🔥$/, '').trim(), `${piece.id}/${post.platform} headline`).not.toMatch(/^\d+$/);
  }
  // The CTA slot holds the CTA (B3): on TikTok, when both sub and
  // CTA appear, the sub (detail line) precedes the CTA — the sub
  // never sits in the closing slot.
  const tiktok = posts.find((p) => p.platform === 'tiktok')!;
  if (sub && cta && sub !== cta) {
    expect(tiktok.text.indexOf(sub)).toBeGreaterThanOrEqual(0);
    expect(tiktok.text.indexOf(sub)).toBeLessThan(tiktok.text.indexOf(cta));
  }
}

function expectFieldIntegrity(plan: ReturnType<typeof planCampaign>) {
  for (const piece of plan.pieces) {
    const hook = hookOf(piece).toUpperCase();
    const cta = (piece.texts.cta ?? '').trim().toUpperCase();
    if (hook && cta) expect(hook, `${piece.id} hook==cta`).not.toBe(cta);
  }
}

/* ---------------- S1 — typed event flyer ---------------- */
describe('R24 S1 — typed texts, soca flyer', () => {
  const ctx: SuggestionContext = { kind: 'flyer', fileName: 'soca-fest-flyer.png' };
  const rctx = resolveCampaignContext({ suggestionCtx: ctx, artworkGenre: 'soca' });
  const texts = { hook1: 'SOCA FEST', hook2: 'IS BACK', sub: 'SAT DEC 20 • THE GRAND HALL', cta: 'GET TICKETS AT THE DOOR' };
  const plan = planCampaign({
    texts, masterRecipe: 'slam', masterFormatId: '9:16', kind: 'flyer',
    altHookPairs: pairsFor(ctx, rctx.genre),
    altSubs: fieldAlternates('sub', ctx, rctx.genre),
    altCtas: fieldAlternates('cta', ctx, rctx.genre),
    genre: rctx.genre,
    eventDate: parseEventDate(texts, new Date('2026-10-26T12:00:00')),
  });

  it('resolves soca and plans a countdown (real date evidence)', () => {
    expect(rctx.genre).toBe('soca');
    expect(plan.seriesKind).toBe('countdown');
  });

  it('every post, in BOTH caption modes, leads with the hook and closes with the CTA', () => {
    for (const piece of plan.pieces) {
      const byMode = (['words', 'lines'] as const).map((mode) =>
        buildSocialPosts(buildPieceProject('soca-fest-flyer', piece, mode), {
          texts: piece.texts, genre: rctx.genre, formatLabel: piece.label,
        }));
      // B1: caption conversion can no longer change the posts at all.
      expect(byMode[0].map((p) => p.text)).toEqual(byMode[1].map((p) => p.text));
      for (const posts of byMode) {
        expectPostsCarryPiece(posts, piece);
        expectTagInvariant(posts);
        for (const post of posts) expect(post.hashtags).toContain('#Soca');
      }
    }
  });

  it('field integrity: hook ≠ cta in every piece', () => {
    expectFieldIntegrity(plan);
  });
});

/* ---------------- S2 — no-text product photo ---------------- */
describe('R24 S2 — no-text photo, product purpose', () => {
  const ctx: SuggestionContext = { kind: 'portrait', fileName: 'IMG_2041.jpg', purpose: 'product' };
  const rctx = resolveCampaignContext({ suggestionCtx: ctx });
  const texts = bankSuggestion(ctx);
  const plan = planCampaign({
    texts, masterRecipe: 'slam', masterFormatId: '9:16', kind: 'portrait',
    altHookPairs: pairsFor(ctx, rctx.genre),
    altSubs: fieldAlternates('sub', ctx, rctx.genre),
    altCtas: fieldAlternates('cta', ctx, rctx.genre),
    genre: rctx.genre,
  });

  it('purpose resolves to business — pools never key from the filename', () => {
    expect(rctx.genre).toBe('business');
    expect(rctx.source).toBe('purpose');
    expect(plan.seriesKind).toBe('spotlight');
  });

  it('no piece and no post carries party/ticket copy; tags are business tags', () => {
    for (const piece of plan.pieces) {
      const all = [piece.texts.hook1, piece.texts.hook2, piece.texts.sub, piece.texts.cta].join(' ');
      expect(all).not.toMatch(/TICKET|ONE NIGHT ONLY/);
      const posts = buildSocialPosts(buildPieceProject('IMG_2041', piece, 'words'), {
        texts: piece.texts, genre: rctx.genre, formatLabel: piece.label,
      });
      expectPostsCarryPiece(posts, piece);
      expectTagInvariant(posts);
      for (const post of posts) {
        expect(post.hashtags).toContain('#SmallBusiness');
        expect(post.hashtags).not.toContain('#LiveMusic');
        expect(post.hashtags).not.toContain('#Party');
        expect(post.hashtags).not.toContain('#Fete');
      }
    }
    expectFieldIntegrity(plan);
  });
});

/* ---------------- S3 — site campaign, dental business ---------------- */
const SITE: SitePageDoc = {
  url: 'https://dual.example/', status: 200,
  html: `<html><head><title>Dual Number Dental</title>
  <script type="application/ld+json">
  {"@type":"Dentist","name":"Dual Number Dental","telephone":"(212) 555-0100",
   "hasOfferCatalog":{"@type":"OfferCatalog","itemListElement":[
     {"@type":"Offer","itemOffered":{"@type":"Service","name":"Teeth Whitening"}},
     {"@type":"Offer","itemOffered":{"@type":"Service","name":"Root Canal"}}]}}
  </script></head><body><h1>Dual Number Dental</h1></body></html>`,
};

describe('R24 S3 — site profile, Dual Number Dental', () => {
  const scan = extractSite([SITE]);
  const profile = profileFromScan(scan, {});
  const facts = approvedFacts(profile);
  const offer = profile.offers[0] ?? null;
  const pools = siteCampaignPools(profile, offer);
  const rctx = resolveCampaignContext({ siteProfile: profile });
  const texts = { hook1: 'DUAL NUMBER DENTAL', hook2: 'TEETH WHITENING', sub: 'Root Canal', cta: 'CALL (212) 555-0100' };
  const guard = (line: string) => lineFactsApproved(line, facts, [texts.hook1, texts.hook2, texts.sub, texts.cta]);
  const plan = planCampaign({
    texts, masterRecipe: 'slam', masterFormatId: '9:16', kind: 'flyer',
    altHookPairs: pools.altHookPairs,
    altSubs: [...pools.altSubs],
    altCtas: [...pools.altCtas],
    genre: rctx.genre,
    factGuard: guard,
    eventDate: null,
    eventEvidence: false,
  });

  it('the thin-body page still yields its JSON-LD (extractor fix)', () => {
    expect(scan.readable).toBe(true);
    expect(profile.name?.value).toBe('Dual Number Dental');
    expect(profile.phone?.value).toBe('(212) 555-0100');
    expect(profile.services).toEqual(expect.arrayContaining(['Teeth Whitening', 'Root Canal']));
  });

  it('site pools are non-empty on the fixture', () => {
    expect(pools.altHookPairs.length).toBeGreaterThan(0);
    expect(pools.altSubs).toEqual(expect.arrayContaining(['Teeth Whitening', 'Root Canal']));
    expect(pools.altCtas).toContain('CALL (212) 555-0100');
  });

  it('genre comes from the profile; kind=flyer alone forces no countdown', () => {
    expect(rctx.genre).toBe('business');
    expect(rctx.source).toBe('site');
    expect(plan.seriesKind).toBe('spotlight');
    expect(plan.pieces.some((p) => p.recipe === 'countdown')).toBe(false);
  });

  it('no ticket copy anywhere; posts carry the phone CTA and business tags', () => {
    for (const piece of plan.pieces) {
      const all = [piece.texts.hook1, piece.texts.hook2, piece.texts.sub, piece.texts.cta].join(' ');
      expect(all).not.toMatch(/TICKET/);
      const posts = buildSocialPosts(buildPieceProject('dual-number-dental', piece, 'words'), {
        texts: piece.texts, genre: rctx.genre, formatLabel: piece.label,
      });
      expectPostsCarryPiece(posts, piece);
      expectTagInvariant(posts);
      for (const post of posts) {
        expect(post.text).not.toMatch(/TICKET/i);
        expect(post.hashtags).toContain('#SmallBusiness');
        expect(post.hashtags).not.toContain('#LiveMusic');
      }
    }
    expectFieldIntegrity(plan);
  });

  it('the factual receipt is clean over pieces + posts', () => {
    const receipt = checkFactTexts(
      plan.pieces.map((p) => {
        const posts = buildSocialPosts(buildPieceProject('dual-number-dental', p, 'words'), {
          texts: p.texts, genre: rctx.genre, formatLabel: p.label,
        });
        return {
          label: p.label,
          texts: [p.texts.hook1 ?? '', p.texts.hook2 ?? '', p.texts.sub ?? '', p.texts.cta ?? '',
            ...posts.map((post) => post.text.replace(/#\w+/g, ''))],
        };
      }),
      facts, [texts.hook1, texts.hook2, texts.sub, texts.cta]);
    expect(receipt.clean).toBe(true);
  });
});

/* ---------------- S4 — long hook, Shorts title ---------------- */
describe('R24 S4 — long hook truncation', () => {
  it('the Shorts title truncates at a word boundary, ≤60 chars incl. ellipsis', () => {
    const hook = 'THE BIGGEST SOCA FETE OF THE ENTIRE SEASON IS FINALLY HERE TONIGHT';
    let p = freshProject('Viral Promo — long (Master cut)');
    p = buildSlamProject(p, art, {
      hook1: hook, hook2: 'ONE NIGHT ONLY', sub: 'THE GRAND HALL', cta: 'GET TICKETS AT THE DOOR',
    }, { duration: 12 });
    const posts = buildSocialPosts(p, {
      texts: { hook1: hook, hook2: 'ONE NIGHT ONLY', sub: 'THE GRAND HALL', cta: 'GET TICKETS AT THE DOOR' },
      genre: 'soca', formatLabel: 'Master cut',
    });
    const shorts = posts.find((x) => x.platform === 'shorts')!;
    expect(shorts.title!.length).toBeLessThanOrEqual(60);
    expect(shorts.title).toBe('THE BIGGEST SOCA FETE OF THE ENTIRE SEASON IS FINALLY HERE…');
    const base = shorts.title!.replace(/…$/, '');
    expect(hook.startsWith(base)).toBe(true);
    expect(hook[base.length]).toBe(' '); // cut landed on a boundary, never mid-word
    expect(truncateAtWord('SHORT', 60)).toBe('SHORT');
    expect(truncateAtWord(hook, 60)).toBe(shorts.title);
  });
});

/* ---------------- 'look' purpose — silence by design ---------------- */
describe("R24 — 'look' purpose stays silent", () => {
  it('pools offered to a silent campaign are refused; posts invent no CTA', () => {
    const ctx: SuggestionContext = { kind: 'logo', fileName: 'powerline.png', purpose: 'look', brandName: 'Powerline Sounds' };
    const rctx = resolveCampaignContext({ suggestionCtx: ctx });
    expect(rctx.silent).toBe(true);
    const texts = bankSuggestion(ctx);
    expect(texts.sub).toBe('');
    expect(texts.cta).toBe('');
    const plan = planCampaign({
      texts, masterRecipe: 'slam', masterFormatId: '9:16', kind: 'logo',
      // Pools are deliberately offered — the planner must refuse them.
      altHookPairs: pairsFor(ctx, rctx.genre),
      altSubs: fieldAlternates('sub', ctx, rctx.genre),
      altCtas: fieldAlternates('cta', ctx, rctx.genre),
      genre: rctx.genre,
      silent: rctx.silent,
    });
    for (const piece of plan.pieces) {
      expect(piece.texts.sub ?? '').toBe('');
      expect(piece.texts.cta ?? '').toBe('');
      const posts = buildSocialPosts(buildPieceProject('powerline', piece, 'words'), {
        texts: piece.texts, genre: rctx.genre, formatLabel: piece.label,
      });
      expectTagInvariant(posts);
      for (const post of posts) {
        expect(post.text).not.toMatch(/DM to book|Tickets: link in bio|BOOK YOUR SPOT/i);
      }
    }
  });
});

/* ---------------- WS-C2 keyword bank ---------------- */
describe('R24 — detectPostGenre business/trade coverage', () => {
  it('trades and services resolve to business, never party', () => {
    for (const s of [
      'Dual Number Dental', 'Rapid Flow Plumbing', 'Glow Hair Salon', 'Mario’s Restaurant',
      'City Auto Repair', 'Smith Law Firm', 'Peak Fitness Gym', 'Corner Bakery & Cafe',
      'Bright Smiles Dentist', 'Ace Roofing Contractors',
    ]) {
      expect(detectPostGenre(s), s).toBe('business');
    }
    expect(detectPostGenre('Luxury listing — realtor tour')).toBe('realestate');
    expect(detectPostGenre('Soca Fete Flyer')).toBe('soca');
  });
});
