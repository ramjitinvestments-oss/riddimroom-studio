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
import { bankAlternatesForGenre } from './suggest';
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
  /** The event's real calendar date, parsed from the artwork's own
      words — schedule labels become actual post dates. */
  eventDate?: Date | null;
  /** R24 (WS-C4): event evidence beyond a parsed date — an event
      kind/offer from a confirmed site profile, or the user's own
      'event' purpose answer. Event-only copy (countdown pieces,
      ticket CTAs) requires evidence: a parsed date, a date printed
      in the words, or this flag. `kind === 'flyer'` alone no longer
      forces a countdown onto a non-event. */
  eventEvidence?: boolean;
  /** R24 (WS-C2/C4): the resolved context says this campaign is
      silent by design (the 'look' purpose — empty sub/CTA). No
      rotation pool may dress a silent piece in borrowed copy. */
  silent?: boolean;
  font?: string;
  /** R21: when a website profile is driving the campaign, the caller
      passes a guard that approves lines whose factual tokens all
      trace to the confirmed profile. Genre-bank alternates that fail
      the guard are dropped, so a bank line can never smuggle an
      unapproved price, date or phone number into a site campaign.
      Caller-supplied pools are the caller's own sources and are not
      filtered here. */
  factGuard?: (line: string) => boolean;
}

const MONTH_INDEX: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Parse the event date out of the artwork's own words — "SAT - DEC
 * 20 - THE GRAND HALL", "DEC 20 2026", "12/20". A yearless date
 * means its NEXT occurrence (a flyer is always for the future).
 * Returns null when no real date is printed.
 */
export function parseEventDate(
  texts: { sub?: string; hook1?: string; hook2?: string },
  now: Date = new Date(),
): Date | null {
  const hay = [texts.sub, texts.hook1, texts.hook2].filter(Boolean).join(' ');
  let month = -1;
  let day = 0;
  let year: number | undefined;
  const named = hay.match(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s*(20\d\d))?/i);
  if (named) {
    month = MONTH_INDEX[named[1].toUpperCase()];
    day = parseInt(named[2], 10);
    year = named[3] ? parseInt(named[3], 10) : undefined;
  } else {
    const numeric = hay.match(/\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/);
    if (!numeric) return null;
    month = parseInt(numeric[1], 10) - 1;
    day = parseInt(numeric[2], 10);
    if (numeric[3]) {
      const y = parseInt(numeric[3], 10);
      year = y < 100 ? 2000 + y : y;
    }
  }
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  let date = new Date(year ?? now.getFullYear(), month, day, 12);
  if (Number.isNaN(date.getTime()) || date.getMonth() !== month) return null;
  if (!year && date.getTime() < now.getTime() - 36 * 3600 * 1000) {
    date = new Date(now.getFullYear() + 1, month, day, 12);
  }
  return date;
}

function fmtDay(d: Date): string {
  return `${WEEKDAY_SHORT[d.getDay()]} ${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
}

function daysBefore(d: Date, n: number): Date {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() - n);
  return x;
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
  const eventDate = input.eventDate ?? null;
  const font = input.font ?? input.texts.font;
  const withFont = (t: Required<Omit<PromoTexts, 'font'>>): PromoTexts => ({ ...t, font });
  const masterPair: [string, string] = [base.hook1, base.hook2];
  const headline = [base.hook1, base.hook2].filter(Boolean).join(' ');
  // R24 (WS-C4): a countdown is event-only copy, and events need
  // evidence — a parsed date, a date printed in the words, or the
  // caller's event evidence. A flyer-shaped image alone is not an
  // event (a dental practice's flyer is not a countdown).
  const event =
    eventDate != null || input.eventEvidence === true || DATE_HINT.test(base.sub) || DATE_HINT.test(headline);
  const seriesKind: CampaignSeriesKind = event ? 'countdown' : 'spotlight';

  // Alternate hook pairs: real alternates only — deduped against the
  // master pair and each other, empties dropped. A silent campaign
  // ('look') takes no alternates at all — its pieces are re-stages
  // of the silent master, not new copy.
  const altPairs: Array<[string, string]> = [];
  for (const pair of input.silent ? [] : (input.altHookPairs ?? [])) {
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
  const bankLines = (field: 'sub' | 'cta'): string[] => {
    if (!input.genre) return [];
    const lines = bankAlternatesForGenre(field, input.genre);
    return input.factGuard ? lines.filter(input.factGuard) : lines;
  };
  const subPool = input.silent ? [] : poolOf(
    [...(input.altSubs ?? []), ...bankLines('sub')],
    base.sub,
  );
  const ctaPool = input.silent ? [] : poolOf(
    [...(input.altCtas ?? []), ...bankLines('cta')],
    base.cta,
  );
  let subIdx = 0;
  let ctaIdx = 0;
  // Rotation pools ROTATE: when a pool wraps, its lines come round
  // again (paired with a different line on the other axis, the set
  // still separates — and the distinctness backstop below gets a
  // real chance to place every piece). An empty pool stays empty.
  const takeSub = (): string | undefined => (subPool.length ? subPool[subIdx++ % subPool.length] : undefined);
  const takeCta = (): string | undefined => (ctaPool.length ? ctaPool[ctaIdx++ % ctaPool.length] : undefined);
  // Hook pairs are consumed through one cursor, so a pair serves
  // exactly one piece (WS-C3: one line serves one field per piece,
  // and one pair serves one piece per set).
  let pairIdx = 0;
  const takePair = (): [string, string] | undefined => altPairs[pairIdx++];

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
    scheduleLabel: event
      ? eventDate
        ? `Post ${fmtDay(eventDate)} — the main push`
        : 'Post on the day — the main push'
      : 'Launch day — the main push',
    hookChanged: false,
  });

  // 2 — alt hook 1 (or a pure rotation cut when no alternate exists).
  const alt1Pair = takePair();
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
    scheduleLabel: event ? (eventDate ? `Post ${fmtDay(daysBefore(eventDate, 5))}` : 'Post 5 days before') : 'Day 2',
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
    countdown('series-7d', 'Countdown — 7 days to go', 'countdown-7-days', ['7 DAYS', 'TO GO'], cd7Sub, base.cta, eventDate ? `Post ${fmtDay(daysBefore(eventDate, 7))}` : 'Post 7 days before');
    countdown('series-48h', 'Countdown — 48 hours to go', 'countdown-48-hours', ['48 HOURS', 'TO GO'], cd48Sub, base.cta, eventDate ? `Post ${fmtDay(daysBefore(eventDate, 2))}` : 'Post 48 hours before');
    // Day-of pushes the ask: its CTA rotates to the next phrasing.
    countdown('series-day', 'Countdown — today is the day', 'countdown-day-of', ['TODAY', 'IS THE DAY'], cdDaySub, takeCta() ?? base.cta, eventDate ? `Post ${fmtDay(eventDate)} — morning` : 'Post on the day — morning');
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
    // R24 (WS-C3): series variants draw their hooks from the
    // alternates pool — a field's line is never PROMOTED into a
    // different field. The old story cut split the sub into a hook
    // (and the offer cut ran the CTA as hook AND CTA); both put one
    // line in two fields of the same piece. With no pool pair left,
    // the variant keeps the master's hook and rotates sub/CTA.
    const storyPair = takePair();
    push({
      id: 'series-story',
      role: 'series',
      label: 'Story cut',
      slug: 'story-cut',
      recipe: 'spin-slam',
      formatId: input.masterFormatId,
      texts: {
        ...base,
        ...(storyPair ? { hook1: storyPair[0], hook2: storyPair[1] } : {}),
        sub: takeSub() ?? base.sub,
        cta: takeCta() ?? base.cta,
      },
      scheduleLabel: 'Day 5',
      hookChanged: !!storyPair,
    });
    const offerPair = takePair();
    push({
      id: 'series-offer',
      role: 'series',
      label: 'Offer cut',
      slug: 'offer-cut',
      recipe: 'slam',
      formatId: input.masterFormatId,
      texts: {
        ...base,
        ...(offerPair ? { hook1: offerPair[0], hook2: offerPair[1] } : {}),
        sub: takeSub() ?? base.sub,
        // The offer cut pushes the ask: its CTA rotates to the next
        // phrasing, while the hook stays a hook.
        cta: takeCta() ?? base.cta,
      },
      scheduleLabel: 'Day 7 — push the call to action',
      hookChanged: !!offerPair,
    });
  }

  // 6 — alt hook/cut 2, on the other rotation.
  const alt2Pair = takePair();
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
    scheduleLabel: event ? (eventDate ? `Post ${fmtDay(daysBefore(eventDate, 1))}` : 'Post the day before') : 'Day 4',
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

  // R24 (WS-C3) — FIELD INTEGRITY: one line serves one field per
  // piece. A piece whose hook equals its CTA, whose hook equals its
  // sub, whose sub equals its CTA, or whose hook is a fragment of
  // its sub (or vice versa) is re-drawn from the pools — hook pair
  // first, then CTA, then sub. The master is the user's own words
  // verbatim and is never re-drawn; format cuts are its re-stage.
  // When every pool is exhausted the piece stands as built — the
  // planner never invents text to force a fix.
  const normLine = (v: string | undefined): string => (v ?? '').trim().toUpperCase();
  const hookTextOf = (t: PromoTexts): string =>
    normLine([t.hook1 ?? '', t.hook2 ?? ''].filter(Boolean).join(' '));
  const violatesIntegrity = (t: PromoTexts): boolean => {
    const hook = hookTextOf(t);
    const sub = normLine(t.sub);
    const cta = normLine(t.cta);
    if (hook && cta && hook === cta) return true;
    if (hook && sub && hook === sub) return true;
    if (sub && cta && sub === cta) return true;
    if (hook && sub && Math.min(hook.length, sub.length) >= 3 && (sub.includes(hook) || hook.includes(sub))) return true;
    return false;
  };
  for (const piece of pieces) {
    if (piece.role === 'format' || piece.id === 'master') continue;
    if (!violatesIntegrity(piece.texts)) continue;
    const t: Required<Omit<PromoTexts, 'font'>> = {
      hook1: piece.texts.hook1 ?? '',
      hook2: piece.texts.hook2 ?? '',
      sub: piece.texts.sub ?? '',
      cta: piece.texts.cta ?? '',
    };
    const tryFix = (mutate: (x: typeof t) => void): boolean => {
      const candidate = { ...t };
      mutate(candidate);
      if (violatesIntegrity(candidate)) return false;
      piece.texts = { ...candidate, font };
      return true;
    };
    const hp = altPairs.find((pr) => !samePair(pr, [t.hook1, t.hook2]) && !samePair(pr, masterPair));
    let fixed = false;
    if (hp) {
      fixed = tryFix((x) => {
        x.hook1 = hp[0];
        x.hook2 = hp[1];
      });
      if (fixed) piece.hookChanged = true;
    }
    if (!fixed) {
      const c2 = takeCta();
      if (c2) fixed = tryFix((x) => { x.cta = c2; });
    }
    if (!fixed) {
      const s2 = takeSub();
      if (s2) fixed = tryFix((x) => { x.sub = s2; });
    }
  }

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
      if (violatesIntegrity(t)) return false; // a rotation may not break field integrity
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
