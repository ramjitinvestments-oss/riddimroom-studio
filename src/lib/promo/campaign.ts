/**
 * The Campaign Engine planner — one upload becomes the whole set.
 *
 * A single promo is a post; a campaign is a presence. This pure
 * planner turns the user's confirmed words + recipe into a set of
 * pieces, each a full promo in its own right:
 *
 *   - the MASTER cut (their recipe, their format, their words)
 *   - two ALT cuts (a different hook when a real alternate exists —
 *     another line the engine read, or the genre bank's next pair —
 *     and always a different recipe rotation, so no two pieces move
 *     the same way)
 *   - a three-piece SERIES: for event art, a countdown ladder
 *     (7 days to go → 48 hours to go → today is the day, the event
 *     headline riding as the sub); for everything else, a spotlight
 *     ladder (newsflash cut → story cut led by the details line →
 *     offer cut led by the CTA)
 *   - two FORMAT cuts (the master re-staged square + wide/vertical),
 *     because a feed post and a story are not the same stage
 *
 * Every piece carries its posting-schedule label: the set is a plan,
 * not a pile of files. The planner is pure and fully tested; the
 * page builds and renders what it returns. Text is never invented
 * beyond the countdown phrases themselves — alt hooks come from the
 * artwork's own unread lines or the vetted genre bank, and every
 * field stays exactly as editable as the single build's.
 */
import type { PromoRecipeId, PromoTexts } from './recipes';
import { bankAlternatesForGenre, splitHeadline } from './suggest';
import type { PostGenre } from '../export/socialPosts';

export type CampaignRole = 'master' | 'alt' | 'series' | 'format';
export type CampaignSeriesKind = 'countdown' | 'spotlight';

export interface CampaignPiece {
  id: string;
  role: CampaignRole;
  /** User-facing name: "Master cut", "Alt hook 1", "Countdown — 7 days to go"… */
  label: string;
  /** File-name slug: "master", "alt-hook-1", "countdown-7-days"… */
  slug: string;
  recipe: PromoRecipeId;
  /** ASPECT_RATIO_OPTIONS id: '9:16' | '16:9' | '1:1' | '4:5'. */
  formatId: string;
  texts: PromoTexts;
  /** When this piece should be posted, in plain words. */
  scheduleLabel: string;
  /** True when the piece's hook differs from the master's. */
  hookChanged: boolean;
}

export interface CampaignPlan {
  seriesKind: CampaignSeriesKind;
  pieces: CampaignPiece[];
}

export interface CampaignInput {
  texts: PromoTexts;
  masterRecipe: PromoRecipeId;
  masterFormatId: string;
  kind: 'logo' | 'portrait' | 'flyer';
  /** Candidate alternate hook pairs, best first (artwork lines, then bank). */
  altHookPairs?: Array<[string, string]>;
  /** Alternate sub lines, best first — pieces rotate through these
      so the supporting words change with the hook. */
  altSubs?: string[];
  /** Alternate CTA lines, best first. */
  altCtas?: string[];
  /** The genre the artwork's own words detected: when the caller
      has no pools, the planner draws them from this genre's bank. */
  genre?: PostGenre;
  font?: string;
}

/** Recipes a campaign piece can build from shared single-art assets. */
const FAST: PromoRecipeId[] = ['slam', 'spin-slam', 'newsflash'];

function rotateRecipe(recipe: PromoRecipeId, steps: number): PromoRecipeId {
  const idx = FAST.indexOf(recipe);
  if (idx === -1) return steps % 2 === 0 ? 'slam' : 'spin-slam';
  return FAST[(idx + steps) % FAST.length];
}

/** Single-art recipes keep their identity in format cuts; the rest fall back to Slam. */
function formatRecipe(master: PromoRecipeId): PromoRecipeId {
  return FAST.includes(master) || master === 'countdown' ? master : 'slam';
}

const DATE_HINT =
  /\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b|\b(MON|TUE|WED|THU|FRI|SAT|SUN)\b|\b\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?\b|\b20\d\d\b/i;

function clean(texts: PromoTexts): Required<Omit<PromoTexts, 'font'>> {
  return {
    hook1: (texts.hook1 ?? '').trim(),
    hook2: (texts.hook2 ?? '').trim(),
    cta: (texts.cta ?? '').trim(),
    sub: (texts.sub ?? '').trim(),
  };
}

function samePair(a: [string, string], b: [string, string]): boolean {
  return a[0].toUpperCase() === b[0].toUpperCase() && a[1].toUpperCase() === b[1].toUpperCase();
}

export function planCampaign(input: CampaignInput): CampaignPlan {
  const base = clean(input.texts);
  const font = input.font ?? input.texts.font;
  const withFont = (t: Required<Omit<PromoTexts, 'font'>>): PromoTexts => ({ ...t, font });
  const masterPair: [string, string] = [base.hook1, base.hook2];
  const headline = [base.hook1, base.hook2].filter(Boolean).join(' ');
  const event = input.kind === 'flyer' || DATE_HINT.test(base.sub) || DATE_HINT.test(headline);
  const seriesKind: CampaignSeriesKind = event ? 'countdown' : 'spotlight';

  // Alternate hook pairs: real alternates only — deduped against the
  // master pair and each other, empties dropped.
  const altPairs: Array<[string, string]> = [];
  for (const pair of input.altHookPairs ?? []) {
    const p: [string, string] = [(pair[0] ?? '').trim(), (pair[1] ?? '').trim()];
    if (!p[0] && !p[1]) continue;
    if (samePair(p, masterPair)) continue;
    if (altPairs.some((q) => samePair(q, p))) continue;
    altPairs.push(p);
  }

  // Rotation pools for sub + CTA: the caller's alternates first,
  // then the detected genre's bank. A pool entry is only ever used
  // when it differs from the master's line — rotating to the same
  // words is not a rotation (owner's R14 verdict: "some captions
  // don't change at all" — the picker had taken the in-use pair).
  const poolOf = (values: string[], masterValue: string): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of values) {
      const t = (v ?? '').trim();
      if (!t || t.toUpperCase() === masterValue.toUpperCase() || seen.has(t.toUpperCase())) continue;
      seen.add(t.toUpperCase());
      out.push(t);
    }
    return out;
  };
  const subPool = poolOf(
    [...(input.altSubs ?? []), ...(input.genre ? bankAlternatesForGenre('sub', input.genre) : [])],
    base.sub,
  );
  const ctaPool = poolOf(
    [...(input.altCtas ?? []), ...(input.genre ? bankAlternatesForGenre('cta', input.genre) : [])],
    base.cta,
  );
  let subIdx = 0;
  let ctaIdx = 0;
  const takeSub = (): string | undefined => subPool[subIdx++];
  const takeCta = (): string | undefined => ctaPool[ctaIdx++];

  const pieces: CampaignPiece[] = [];
  const push = (p: Omit<CampaignPiece, 'texts'> & { texts: Required<Omit<PromoTexts, 'font'>> }) =>
    pieces.push({ ...p, texts: withFont(p.texts) });

  // 1 — the master.
  push({
    id: 'master',
    role: 'master',
    label: 'Master cut',
    slug: 'master',
    recipe: input.masterRecipe,
    formatId: input.masterFormatId,
    texts: base,
    scheduleLabel: event ? 'Post on the day — the main push' : 'Launch day — the main push',
    hookChanged: false,
  });

  // 2 — alt hook 1 (or a pure rotation cut when no alternate exists).
  const alt1Pair = altPairs[0];
  push({
    id: 'alt-1',
    role: 'alt',
    label: alt1Pair ? 'Alt hook 1' : 'Alt cut 1',
    slug: alt1Pair ? 'alt-hook-1' : 'alt-cut-1',
    recipe: rotateRecipe(input.masterRecipe, 1),
    formatId: input.masterFormatId,
    texts: {
      ...base,
      ...(alt1Pair ? { hook1: alt1Pair[0], hook2: alt1Pair[1] } : {}),
      sub: takeSub() ?? base.sub,
      cta: takeCta() ?? base.cta,
    },
    scheduleLabel: event ? 'Post 5 days before' : 'Day 2',
    hookChanged: !!alt1Pair,
  });

  // 3..5 — the series.
  if (event) {
    const cd7Sub = base.sub || headline;
    const cd48Sub = headline && headline !== cd7Sub ? headline : (takeSub() ?? headline);
    const cdDaySub = headline && headline !== cd48Sub ? headline : (takeSub() ?? cd48Sub);
    const countdown = (
      id: string,
      label: string,
      slug: string,
      hooks: [string, string],
      sub: string,
      cta: string,
      scheduleLabel: string,
    ) =>
      push({
        id,
        role: 'series',
        label,
        slug,
        recipe: 'countdown',
        formatId: input.masterFormatId,
        texts: { ...base, hook1: hooks[0], hook2: hooks[1], sub, cta },
        scheduleLabel,
        hookChanged: true,
      });
    countdown('series-7d', 'Countdown — 7 days to go', 'countdown-7-days', ['7 DAYS', 'TO GO'], cd7Sub, base.cta, 'Post 7 days before');
    countdown('series-48h', 'Countdown — 48 hours to go', 'countdown-48-hours', ['48 HOURS', 'TO GO'], cd48Sub, base.cta, 'Post 48 hours before');
    // Day-of pushes the ask: its CTA rotates to the next phrasing.
    countdown('series-day', 'Countdown — today is the day', 'countdown-day-of', ['TODAY', 'IS THE DAY'], cdDaySub, takeCta() ?? base.cta, 'Post on the day — morning');
  } else {
    push({
      id: 'series-news',
      role: 'series',
      label: 'Newsflash cut',
      slug: 'newsflash-cut',
      recipe: 'newsflash',
      formatId: input.masterFormatId,
      texts: { ...base, sub: takeSub() ?? base.sub },
      scheduleLabel: 'Day 3',
      hookChanged: false,
    });
    const [storyHook1, storyHook2] = base.sub ? splitHeadline(base.sub.toUpperCase()) : [base.hook1, base.hook2];
    push({
      id: 'series-story',
      role: 'series',
      label: 'Story cut',
      slug: 'story-cut',
      recipe: 'spin-slam',
      formatId: input.masterFormatId,
      texts: base.sub ? { ...base, hook1: storyHook1, hook2: storyHook2, sub: headline || base.sub } : base,
      scheduleLabel: 'Day 5',
      hookChanged: !!base.sub,
    });
    const [offerHook1, offerHook2] = base.cta ? splitHeadline(base.cta.toUpperCase()) : [base.hook1, base.hook2];
    push({
      id: 'series-offer',
      role: 'series',
      label: 'Offer cut',
      slug: 'offer-cut',
      recipe: 'slam',
      formatId: input.masterFormatId,
      texts: base.cta ? { ...base, hook1: offerHook1, hook2: offerHook2, sub: headline || base.sub } : base,
      scheduleLabel: 'Day 7 — push the call to action',
      hookChanged: !!base.cta,
    });
  }

  // 6 — alt hook/cut 2, on the other rotation.
  const alt2Pair = altPairs[1];
  push({
    id: 'alt-2',
    role: 'alt',
    label: alt2Pair ? 'Alt hook 2' : 'Alt cut 2',
    slug: alt2Pair ? 'alt-hook-2' : 'alt-cut-2',
    recipe: rotateRecipe(input.masterRecipe, 2),
    formatId: input.masterFormatId,
    texts: {
      ...base,
      ...(alt2Pair ? { hook1: alt2Pair[0], hook2: alt2Pair[1] } : {}),
      sub: takeSub() ?? base.sub,
      cta: takeCta() ?? base.cta,
    },
    scheduleLabel: event ? 'Post the day before' : 'Day 4',
    hookChanged: !!alt2Pair,
  });

  // 7..8 — format cuts: the master re-staged for the other stages.
  const formatCandidates = ['1:1', '16:9', '9:16'].filter((f) => f !== input.masterFormatId);
  const formatLabels: Record<string, string> = {
    '1:1': 'Square cut — for the feed',
    '16:9': 'Wide cut — YouTube & screens',
    '9:16': 'Vertical cut — stories & reels',
  };
  formatCandidates.slice(0, 2).forEach((formatId, i) => {
    push({
      id: `format-${i + 1}`,
      role: 'format',
      label: formatLabels[formatId],
      slug: `format-${formatId.replace(':', 'x')}`,
      recipe: formatRecipe(input.masterRecipe),
      formatId,
      texts: base,
      scheduleLabel: 'Same day as the master',
      hookChanged: false,
    });
  });

  // DISTINCTNESS BACKSTOP — the owner's standing rule for the set:
  // no two pieces (format re-stages exempt — they ARE the master on
  // another stage, and they say so) may carry the identical four
  // words. A piece that still collides rotates its sub, then its
  // CTA, then its hook from the pools until it stands apart. Only
  // when every pool is exhausted can a collision survive — the
  // planner never invents text to force one apart.
  const keyOf = (t: PromoTexts) =>
    [t.hook1, t.hook2, t.sub, t.cta].map((v) => (v ?? '').trim().toUpperCase()).join('|');
  const seen = new Set<string>();
  for (const piece of pieces) {
    if (piece.role === 'format') continue;
    if (!seen.has(keyOf(piece.texts))) {
      seen.add(keyOf(piece.texts));
      continue;
    }
    const t: Required<Omit<PromoTexts, 'font'>> = {
      hook1: piece.texts.hook1 ?? '',
      hook2: piece.texts.hook2 ?? '',
      sub: piece.texts.sub ?? '',
      cta: piece.texts.cta ?? '',
    };
    let placed = false;
    const attempt = (): boolean => {
      if (seen.has(keyOf(t))) return false;
      piece.texts = { ...t, font };
      seen.add(keyOf(t));
      placed = true;
      return true;
    };
    const s2 = takeSub();
    if (s2) {
      t.sub = s2;
      attempt();
    }
    if (!placed) {
      const c2 = takeCta();
      if (c2) {
        t.cta = c2;
        attempt();
      }
    }
    if (!placed) {
      const hp = altPairs.find((pr) => !samePair(pr, [t.hook1, t.hook2]) && !samePair(pr, masterPair));
      if (hp) {
        t.hook1 = hp[0];
        t.hook2 = hp[1];
        piece.hookChanged = true;
        attempt();
      }
    }
    if (!placed) seen.add(keyOf(piece.texts));
  }

  return { seriesKind, pieces };
}

/** The delivered file name for a campaign piece: base-campaign-slug.mp4 */
export function campaignFileName(baseName: string, piece: CampaignPiece): string {
  const base = baseName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'promo';
  return `${base}-campaign-${piece.slug}.mp4`;
}
