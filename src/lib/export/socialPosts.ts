/**
 * Social posts for the Share pack — one correct post per platform,
 * written from the project itself: the headline and the call to action
 * are lifted from the text items actually on the video (so the post and
 * the video's ending agree), and the five hashtags are picked from what
 * the video is about. EXACTLY five tags on every post — that's the
 * house rule, enforced by construction and covered by tests.
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

export function detectPostGenre(haystack: string): PostGenre {
  const s = haystack.toLowerCase();
  if (/\bsoca\b|carnival|\bfete\b|trinidad/.test(s)) return 'soca';
  if (/dancehall|reggae|jamaica/.test(s)) return 'dancehall';
  if (/gospel|praise|worship|church|ministry/.test(s)) return 'gospel';
  if (/realtor|real estate|property|listing|homes?\s+for\s+sale/.test(s)) return 'realestate';
  if (/salon|barber|shop|store|sale|business|booking/.test(s)) return 'business';
  return 'caribbean';
}

function cleanLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function buildSocialPosts(project: Project): SocialPost[] {
  const duration = getProjectDuration(project);
  const texts = project.items
    .filter((i) => i.type === 'text')
    .map((i) => ({ text: cleanLine((i as { text: string }).text), start: i.startTime, end: i.endTime, role: (i as { role?: string }).role }))
    .filter((t) => t.text.length > 0)
    .sort((a, b) => a.start - b.start);

  const subject = cleanLine(project.name.replace(/^viral promo\s*[—-]\s*/i, '')) || 'New video';
  const hook = (texts.find((t) => t.role === 'title') ?? texts[0])?.text;
  // The ask the video ends on: the latest text still on screen at the close.
  const closing = texts.filter((t) => t.end >= duration - 0.5).sort((a, b) => b.start - a.start)[0];
  const genre = detectPostGenre([project.name, ...texts.map((t) => t.text)].join(' '));
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
  const shortsTitle = (lead.length > 60 ? `${lead.slice(0, 57)}…` : lead);
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
