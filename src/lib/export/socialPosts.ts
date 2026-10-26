/**
 * Social posts for the Share pack — one correct post per platform.
 *
 * R24 (WS-C1): when the caller hands over the piece's planner texts
 * (PromoTexts from the campaign planner), the post is written from
 * THOSE — it leads with the piece's real hook and closes with the
 * piece's real CTA, in both caption modes and every recipe. The old
 * path scraped rendered text items, which lost the user's words
 * entirely once the caption conversion deleted the text items (and
 * let a countdown number headline the post, and the sub land in the
 * CTA slot). The scrape remains only as the fallback for projects
 * that carry no planner texts (e.g. a hand-built editor project).
 *
 * The five hashtags are picked from the RESOLVED campaign context
 * (site profile → user purpose → artwork analysis → filename),
 * never from a second, divergent detection in the results path.
 * EXACTLY five tags on every post — that's the house rule, enforced
 * by construction and covered by tests.
 *
 * Written copy follows the brand rules: "fete" is correct in text
 * (only AI-rendered video type avoids it), patois is spelled right,
 * and #RiddimRoom always rides along.
 */
import type { Project } from '../../types/timeline';
import { getProjectDuration } from '../timeline/utils';

export type SocialPlatform = 'tiktok' | 'shorts' | 'whatsapp' | 'facebook';

export interface SocialPost {
  platform: SocialPlatform;
  label: string;
  /** Shorts only: the tappable title line (≤60 chars). */
  title?: string;
  /** The full copyable post text, hashtags included. */
  text: string;
  hashtags: string[];
}

export type PostGenre = 'soca' | 'dancehall' | 'gospel' | 'realestate' | 'business' | 'caribbean';

const GENRE_TAGS: Record<PostGenre, string[]> = {
  soca: ['#Soca', '#Carnival', '#Trinidad', '#Fete', '#RiddimRoom'],
  dancehall: ['#Dancehall', '#Jamaica', '#Reggae', '#Caribbean', '#RiddimRoom'],
  gospel: ['#Gospel', '#Praise', '#Worship', '#Caribbean', '#RiddimRoom'],
  realestate: ['#Realtor', '#RealEstate', '#PropertyTour', '#Homes', '#RiddimRoom'],
  business: ['#SmallBusiness', '#Entrepreneur', '#SupportLocal', '#Business', '#RiddimRoom'],
  caribbean: ['#Caribbean', '#Events', '#LiveMusic', '#Party', '#RiddimRoom'],
};

const GENRE_DEFAULT_CTA: Record<PostGenre, string> = {
  soca: 'Tickets: link in bio',
  dancehall: 'Tickets: link in bio',
  gospel: 'All are welcome — details in bio',
  realestate: 'DM to book your viewing',
  business: 'DM to book',
  caribbean: 'Tickets: link in bio',
};

/**
 * Genre from a text haystack. R24 (WS-C2): business/trade coverage
 * is a keyword bank — dental, plumbing, salon, real estate,
 * restaurant, auto, legal, fitness, retail and friends resolve to
 * the business (or real-estate) tag set instead of collapsing to
 * party tags. Specific trades are checked before the generic
 * business words, and the party genres keep priority for art that
 * actually names them.
 */
export function detectPostGenre(haystack: string): PostGenre {
  const s = haystack.toLowerCase();
  if (/\bsoca\b|carnival|\bfete\b|trinidad/.test(s)) return 'soca';
  if (/dancehall|reggae|jamaica/.test(s)) return 'dancehall';
  if (/gospel|praise|worship|church|ministry/.test(s)) return 'gospel';
  if (/realtor|real estate|realty|property|listing|homes?\s+for\s+sale|mortgage|landlord/.test(s)) return 'realestate';
  // Trades & services — a business, whatever the filename says.
  if (/dental|dentist|orthodont|teeth|smile studio|clinic|medical|doctor|pharmacy|therapy|chiropract|veterinar/.test(s)) return 'business';
  if (/plumb|electric|hvac|roofing|contractor|construction|handyman|landscap|cleaning|pest control|auto repair|mechanic|car wash|body shop/.test(s)) return 'business';
  if (/salon|barber|nails|beauty|hair studio|braids/.test(s)) return 'business';
  if (/restaurant|cafe|café|bakery|catering|food truck|coffee shop|pizzeria|kitchen/.test(s)) return 'business';
  if (/law firm|attorney|lawyer|legal services|accounting|tax service|insurance|financial/.test(s)) return 'business';
  if (/fitness|\bgym\b|yoga|pilates|personal train|crossfit/.test(s)) return 'business';
  if (/boutique|retail|florist|photograph|tutor|daycare|pet groom/.test(s)) return 'business';
  if (/salon|barber|shop|store|sale|business|booking/.test(s)) return 'business';
  return 'caribbean';
}

function cleanLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * R24 (WS-C5 / B8): truncate at a word boundary — never mid-word.
 * The result (ellipsis included) never exceeds `max`.
 */
export function truncateAtWord(text: string, max = 60): string {
  const t = cleanLine(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const base = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:!?—-]+$/, '');
  return `${base}…`;
}

/** The planner texts a campaign piece carries (PromoTexts shape). */
export interface SocialPostTexts {
  hook1?: string;
  hook2?: string;
  sub?: string;
  cta?: string;
}

export interface SocialPostOptions {
  /** The piece's PromoTexts, straight from the planner (WS-C1). */
  texts?: SocialPostTexts;
  /** The resolved campaign context genre (WS-C2) — wins over any
      detection from the project itself. */
  genre?: PostGenre;
  /** The piece's user-facing label ("Countdown — 7 days to go"). */
  formatLabel?: string;
}

function composePosts(args: {
  lead: string;
  detail: string;
  cta: string;
  genre: PostGenre;
}): SocialPost[] {
  const { lead, detail, cta, genre } = args;
  const hashtags = GENRE_TAGS[genre];
  const tagLine = hashtags.join(' ');
  const mid = [detail, cta].filter(Boolean).join(' — ');

  const tiktok: SocialPost = {
    platform: 'tiktok',
    label: 'TikTok / Reels',
    text: [`${lead} 🔥`, detail, cta, tagLine].filter(Boolean).join('\n'),
    hashtags,
  };
  const shortsTitle = truncateAtWord(lead, 60);
  const shorts: SocialPost = {
    platform: 'shorts',
    label: 'YouTube Shorts',
    title: shortsTitle,
    text: [shortsTitle, '', `${lead}${mid ? ` — ${mid}` : ''}`, tagLine].join('\n'),
    hashtags,
  };
  const whatsapp: SocialPost = {
    platform: 'whatsapp',
    label: 'WhatsApp',
    text: `${[lead, detail, cta].filter(Boolean).join(' — ')}. 🎬\n${tagLine}`,
    hashtags,
  };
  const facebook: SocialPost = {
    platform: 'facebook',
    label: 'Facebook',
    text: [lead, cta ? `${mid} — full details in the comments.` : detail, tagLine].filter(Boolean).join('\n'),
    hashtags,
  };
  return [tiktok, shorts, whatsapp, facebook];
}

export function buildSocialPosts(project: Project, options?: SocialPostOptions): SocialPost[] {
  const subject = cleanLine(project.name.replace(/^viral promo\s*[—-]\s*/i, '')) || 'New video';

  /* --- WS-C1: planner texts path — the campaign results path. --- */
  if (options?.texts) {
    const t = options.texts;
    const hook = cleanLine([t.hook1 ?? '', t.hook2 ?? ''].filter(Boolean).join(' '));
    const sub = cleanLine(t.sub ?? '');
    const pieceCta = cleanLine(t.cta ?? '');
    const genre =
      options.genre ?? detectPostGenre([hook, sub, pieceCta, subject].join(' '));
    // A piece whose design is silent (empty sub AND empty CTA — the
    // 'look' purpose) stays silent: no genre default is invented.
    const silent = !pieceCta && !sub;
    const cta = pieceCta || (silent ? '' : GENRE_DEFAULT_CTA[genre]);
    const fallbackSubject =
      options.formatLabel && !subject.includes(options.formatLabel)
        ? `${subject} (${options.formatLabel})`
        : subject;
    return composePosts({
      lead: hook || fallbackSubject,
      detail: sub && sub.toUpperCase() !== hook.toUpperCase() ? sub : '',
      cta,
      genre,
    });
  }

  /* --- Legacy scrape path (no planner texts — editor projects). --- */
  const duration = getProjectDuration(project);
  const texts = project.items
    .filter((i) => i.type === 'text')
    .map((i) => ({ text: cleanLine((i as { text: string }).text), start: i.startTime, end: i.endTime, role: (i as { role?: string }).role }))
    .filter((t) => t.text.length > 0)
    .sort((a, b) => a.start - b.start);

  const hook = (texts.find((t) => t.role === 'title') ?? texts[0])?.text;
  // The ask the video ends on: the latest text still on screen at the close.
  const closing = texts.filter((t) => t.end >= duration - 0.5).sort((a, b) => b.start - a.start)[0];
  const genre = options?.genre ?? detectPostGenre([project.name, ...texts.map((t) => t.text)].join(' '));
  const cta = closing && closing !== texts[0] ? closing.text : (GENRE_DEFAULT_CTA[genre]);
  const hashtags = GENRE_TAGS[genre];
  const tagLine = hashtags.join(' ');
  const lead = hook && hook.toLowerCase() !== subject.toLowerCase() ? hook : subject;

  const tiktok: SocialPost = {
    platform: 'tiktok',
    label: 'TikTok / Reels',
    text: `${lead} 🔥\n${cta}\n${tagLine}`,
    hashtags,
  };
  const shortsTitle = truncateAtWord(lead, 60);
  const shorts: SocialPost = {
    platform: 'shorts',
    label: 'YouTube Shorts',
    title: shortsTitle,
    text: `${shortsTitle}\n\n${subject} — ${cta}\n${tagLine}`,
    hashtags,
  };
  const whatsapp: SocialPost = {
    platform: 'whatsapp',
    label: 'WhatsApp',
    text: `${subject} — ${cta}. 🎬\n${tagLine}`,
    hashtags,
  };
  const facebook: SocialPost = {
    platform: 'facebook',
    label: 'Facebook',
    text: `${lead}\n${cta} — full details in the comments.\n${tagLine}`,
    hashtags,
  };
  return [tiktok, shorts, whatsapp, facebook];
}

/**
 * The trending-sound play (R17) — how a finished promo actually
 * rides a trend. No app can legally bake a trending commercial
 * song into an exported file (platform music licences cover in-app
 * personal use; business accounts get a commercial library), so
 * the professional workflow is: export from Studio, then attach
 * the sound natively where the discovery happens.
 */
export function buildSoundGuide(): string[] {
  return [
    'In TikTok or Instagram, start the post with your Studio video, then tap "Add sound" and pick the trending track — your video joins that sound\'s page, where the discovery happens.',
    'If your promo already carries your own track, that is your sound — post it as-is. Never bake a trending song you have no rights to into the file itself.',
    'Post early in the trend: sounds usually peak within days, and the first wave of videos on a rising sound gets the push.',
    'Keep the baked-in words: your captions are already animated word by word, so the video still sells itself to everyone watching on mute.',
  ];
}
