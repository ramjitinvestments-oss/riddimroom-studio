/**
 * RiddimRoom Studio — template library v2: 20 ultra-premium viral templates.
 *
 * Two kinds:
 * - `hook` (10) — 1.5–4s micro-templates. Applying one INSERTS its text
 *   elements (kinetic reveals, entrance/exit presets) into the currently
 *   open project at the playhead, optionally restyles its captions, adds a
 *   motion effect to the media playing underneath, and can animate a PiP
 *   frame. A hook never creates a project and never touches media the user
 *   already placed (beyond the documented motion/PiP touches).
 * - `full` (10) — 15–45s edit blueprints. Each declares named media slots
 *   whose durations sum to the target length; applying one to a project
 *   restyles captions, gives the project's clips (in timeline order) the
 *   per-slot motion effects, sets the template transition on clip
 *   entrances/exits, and drops in headline / sub / CTA / outro placeholder
 *   text (only for roles the project doesn't already have). A suggested
 *   built-in loop is named for musical formats — it is a suggestion shown
 *   in the panel, never auto-added audio.
 *
 * Placeholder copy rendered INTO projects is brand-neutral ("YOUR TITLE")
 * and never uses the word "fete" (video-rendering rule) — Caribbean flavor
 * lives in template names/descriptions, which are UI text only.
 */

export type TemplateKind = 'hook' | 'full';

export type TemplateCategory =
  | 'Music Video'
  | 'Ad'
  | 'Commercial'
  | 'Event Promo'
  | 'Podcast'
  | 'YouTube'
  | 'Viral Social'
  | 'Store Service';

export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  'Viral Social',
  'Music Video',
  'Ad',
  'Commercial',
  'Event Promo',
  'Podcast',
  'YouTube',
  'Store Service',
];

export type TemplateAspectRatio = '9:16' | '1:1' | '16:9' | '4:5';

/** One named media slot of a full-edit template (a segment of the edit plan). */
export interface TemplateSlot {
  name: string;
  durationSeconds: number;
  /** Motion effect id from `lib/motionEffects.ts` ('none' allowed). */
  motion: string;
}

/** One text element a hook inserts into the open project. Times are offsets from the insertion point. */
export interface HookElement {
  text: string;
  role: 'title' | 'lower-third' | 'overlay' | 'subtitle';
  offsetSeconds: number;
  durationSeconds: number;
  fontSize: number;
  color: string;
  /** Percent coordinates (0–100), matching the timeline's Transform units. */
  position: { x: number; y: number };
  /** AnimationPreset id — transitions-catalog presets plus text kinetic reveals ('typewriter', 'word-by-word', 'karaoke'). */
  entrance: string;
  exit?: string;
}

export interface StudioTemplate {
  id: string;
  name: string;
  kind: TemplateKind;
  category: TemplateCategory;
  description: string;
  /** Target length in seconds (hooks: 1.5–4; full edits: 15–45). */
  durationSeconds: number;
  aspectRatios: TemplateAspectRatio[];
  /** Caption style id from `lib/captions/styles.ts`. '' = leave captions as they are. */
  captionStyleId: string;
  /** Transition preset id from `lib/transitions.ts` (or a kinetic reveal for hook titles). */
  transition: string;
  /** Motion effect id from `lib/motionEffects.ts` — for full templates the default under the per-slot motions; for hooks, the motion added to media under the hook. 'none' allowed. */
  motion: string;
  accentColor: string;
  /** Optional card artwork (Artistly CDN still); templates without one get a designed monogram fallback header in the panel. */
  thumbnail?: string;
  // — Full edits only —
  slots?: TemplateSlot[];
  headlineText?: string;
  subText?: string;
  ctaText?: string;
  outroText?: string;
  /** Built-in loop id from `lib/media/loops.ts` suggested as the soundtrack. */
  suggestedLoopId?: string;
  // — Hooks only —
  elements?: HookElement[];
  /** End-transform animation applied to the project's PiP item (if one is on screen) — the PiP glides to this frame by the end of its span. */
  pipEndTransform?: { position: { x: number; y: number }; scale: number; opacity: number; eased?: boolean };
}

const CDN = 'https://cdn.artistly.ai/images/sd3';

export const STUDIO_TEMPLATES: StudioTemplate[] = [
  // ───────────────────────────── HOOKS (1.5–4s) ─────────────────────────────
  {
    id: 'gold-smash-intro', name: 'Gold Smash Intro', kind: 'hook', category: 'Viral Social',
    description: 'A gold title smash with a punch-zoom on your clip. The premium channel ident.',
    durationSeconds: 2.5, aspectRatios: ['9:16', '1:1', '16:9'],
    captionStyleId: 'gold-premium', transition: 'pop', motion: 'punch-zoom', accentColor: '#FFD100',
    thumbnail: `${CDN}/7ffcc59451e5629f27adad968af3b7291895fa4f.jpg`,
    elements: [
      { text: 'YOUR TITLE', role: 'title', offsetSeconds: 0, durationSeconds: 2.5, fontSize: 84, color: '#FFD100', position: { x: 50, y: 42 }, entrance: 'pop', exit: 'fade' },
      { text: 'WATCH THIS', role: 'subtitle', offsetSeconds: 0.35, durationSeconds: 2.15, fontSize: 36, color: '#FFF6E3', position: { x: 50, y: 56 }, entrance: 'fadeup' },
    ],
  },
  {
    id: 'glitch-hook', name: 'Glitch Hook', kind: 'hook', category: 'Viral Social',
    description: 'Cyber-glitch text over a micro-shaken clip. Built for drops and teasers.',
    durationSeconds: 2, aspectRatios: ['9:16', '1:1'],
    captionStyleId: 'cyber-glitch', transition: 'glitch', motion: 'subtle-shake', accentColor: '#FFE14D',
    elements: [
      { text: 'WAIT FOR IT', role: 'title', offsetSeconds: 0, durationSeconds: 2, fontSize: 76, color: '#FFD100', position: { x: 50, y: 44 }, entrance: 'glitch', exit: 'glitch' },
      { text: "DON'T SCROLL", role: 'subtitle', offsetSeconds: 0.5, durationSeconds: 1.5, fontSize: 34, color: '#FFFFFF', position: { x: 50, y: 58 }, entrance: 'glitch' },
    ],
  },
  {
    id: 'fete-countdown', name: 'Fete Countdown', kind: 'hook', category: 'Event Promo',
    description: '3 · 2 · 1 · GO — a bouncing countdown that launches any party clip.',
    durationSeconds: 3.5, aspectRatios: ['9:16', '1:1'],
    captionStyleId: 'soca-pop', transition: 'heartbeat', motion: 'dynamic-zoom', accentColor: '#FFD100',
    thumbnail: `${CDN}/6e8bb861ef276d4c38e2d2344726150144709e22.jpg`,
    elements: [
      { text: '3', role: 'title', offsetSeconds: 0, durationSeconds: 0.9, fontSize: 130, color: '#FFD100', position: { x: 50, y: 45 }, entrance: 'pop' },
      { text: '2', role: 'title', offsetSeconds: 0.9, durationSeconds: 0.9, fontSize: 130, color: '#FFF6E3', position: { x: 50, y: 45 }, entrance: 'pop' },
      { text: '1', role: 'title', offsetSeconds: 1.8, durationSeconds: 0.9, fontSize: 130, color: '#FF8A00', position: { x: 50, y: 45 }, entrance: 'pop' },
      { text: "LET'S GO!", role: 'title', offsetSeconds: 2.7, durationSeconds: 0.8, fontSize: 84, color: '#FFD100', position: { x: 50, y: 45 }, entrance: 'bounce' },
    ],
  },
  {
    id: 'breaking-news', name: 'Breaking News', kind: 'hook', category: 'Store Service',
    description: 'A news-style lower third that slides in — announcements that feel official.',
    durationSeconds: 3, aspectRatios: ['16:9', '9:16', '1:1'],
    captionStyleId: 'minimal-box', transition: 'slide-left', motion: 'none', accentColor: '#FF5C1A',
    elements: [
      { text: 'JUST ANNOUNCED', role: 'lower-third', offsetSeconds: 0, durationSeconds: 3, fontSize: 40, color: '#FFFFFF', position: { x: 32, y: 76 }, entrance: 'slide-left' },
      { text: 'YOUR HEADLINE HERE', role: 'lower-third', offsetSeconds: 0.25, durationSeconds: 2.75, fontSize: 30, color: '#FFD100', position: { x: 32, y: 84 }, entrance: 'slide-left' },
    ],
  },
  {
    id: 'price-pop', name: 'Price Pop', kind: 'hook', category: 'Ad',
    description: 'Sale price that bounces in over your product shot. Pure conversion energy.',
    durationSeconds: 2, aspectRatios: ['1:1', '9:16', '4:5'],
    captionStyleId: 'bold-yellow', transition: 'snap-zoom', motion: 'product-focus', accentColor: '#FFD100',
    elements: [
      { text: 'SALE', role: 'subtitle', offsetSeconds: 0, durationSeconds: 2, fontSize: 38, color: '#FFF6E3', position: { x: 50, y: 30 }, entrance: 'fadeup' },
      { text: '$00', role: 'title', offsetSeconds: 0.15, durationSeconds: 1.85, fontSize: 110, color: '#FFD100', position: { x: 50, y: 46 }, entrance: 'bounce' },
      { text: 'SHOP NOW', role: 'overlay', offsetSeconds: 0.6, durationSeconds: 1.4, fontSize: 36, color: '#FFFFFF', position: { x: 50, y: 62 }, entrance: 'pop' },
    ],
  },
  {
    id: 'new-drop-alert', name: 'New Drop Alert', kind: 'hook', category: 'Store Service',
    description: 'Flash + heartbeat alert for launches. Impossible to scroll past.',
    durationSeconds: 2.5, aspectRatios: ['9:16', '1:1'],
    captionStyleId: 'fire', transition: 'flash', motion: 'flash', accentColor: '#FF8A00',
    elements: [
      { text: 'NEW DROP', role: 'title', offsetSeconds: 0, durationSeconds: 2.5, fontSize: 88, color: '#FF8A00', position: { x: 50, y: 44 }, entrance: 'flash' },
      { text: 'OUT NOW', role: 'subtitle', offsetSeconds: 0.4, durationSeconds: 2.1, fontSize: 40, color: '#FFF6E3', position: { x: 50, y: 58 }, entrance: 'heartbeat' },
    ],
  },
  {
    id: 'split-reveal', name: 'Split Reveal', kind: 'hook', category: 'Viral Social',
    description: 'BEFORE / AFTER slide in from opposite sides — and your PiP glides across.',
    durationSeconds: 3, aspectRatios: ['9:16', '16:9'],
    captionStyleId: 'bold-outline', transition: 'slideSplit', motion: 'none', accentColor: '#FFFFFF',
    elements: [
      { text: 'BEFORE', role: 'title', offsetSeconds: 0, durationSeconds: 3, fontSize: 64, color: '#FFFFFF', position: { x: 27, y: 50 }, entrance: 'slide-left' },
      { text: 'AFTER', role: 'title', offsetSeconds: 0.3, durationSeconds: 2.7, fontSize: 64, color: '#FFD100', position: { x: 73, y: 50 }, entrance: 'slide-right' },
    ],
    pipEndTransform: { position: { x: 78, y: 24 }, scale: 0.9, opacity: 1, eased: true },
  },
  {
    id: 'karaoke-teaser', name: 'Karaoke Teaser', kind: 'hook', category: 'Music Video',
    description: 'A lyric line revealed word-by-word over a slow push-in. Tease the chorus.',
    durationSeconds: 4, aspectRatios: ['9:16', '16:9'],
    captionStyleId: 'karaoke-gold', transition: 'word-by-word', motion: 'slow-zoom-in', accentColor: '#FFD100',
    elements: [
      { text: 'YOUR LYRICS HERE', role: 'title', offsetSeconds: 0, durationSeconds: 4, fontSize: 56, color: '#FFD100', position: { x: 50, y: 68 }, entrance: 'word-by-word' },
      { text: 'FULL SONG OUT NOW', role: 'subtitle', offsetSeconds: 2.2, durationSeconds: 1.8, fontSize: 30, color: '#FFFFFF', position: { x: 50, y: 78 }, entrance: 'fadeup' },
    ],
  },
  {
    id: 'bounce-text-hook', name: 'Bounce Text Hook', kind: 'hook', category: 'Viral Social',
    description: 'The classic scroll-stopper: giant bouncing text, zero subtlety, all retention.',
    durationSeconds: 2, aspectRatios: ['9:16'],
    captionStyleId: 'viral', transition: 'bounce', motion: 'none', accentColor: '#FFFFFF',
    elements: [
      { text: 'STOP SCROLLING', role: 'title', offsetSeconds: 0, durationSeconds: 2, fontSize: 72, color: '#FFFFFF', position: { x: 50, y: 40 }, entrance: 'bounce' },
      { text: 'WATCH TILL THE END', role: 'subtitle', offsetSeconds: 0.45, durationSeconds: 1.55, fontSize: 34, color: '#FFD100', position: { x: 50, y: 54 }, entrance: 'pop' },
    ],
  },
  {
    id: 'letterbox-reveal', name: 'Letterbox Reveal', kind: 'hook', category: 'YouTube',
    description: 'A cinematic title dissolving in over a slow Ken Burns drift. Film energy, instantly.',
    durationSeconds: 4, aspectRatios: ['16:9'],
    captionStyleId: 'cinema', transition: 'film-dissolve', motion: 'ken-burns', accentColor: '#FFE9A8',
    thumbnail: `${CDN}/109aa936a39686d3c5dbfea0296847264c470e5a.jpg`,
    elements: [
      { text: 'YOUR TITLE', role: 'title', offsetSeconds: 0, durationSeconds: 4, fontSize: 68, color: '#FFE9A8', position: { x: 50, y: 48 }, entrance: 'film-dissolve' },
      { text: 'A SHORT FILM', role: 'subtitle', offsetSeconds: 1.2, durationSeconds: 2.8, fontSize: 28, color: '#FFFFFF', position: { x: 50, y: 60 }, entrance: 'fade' },
    ],
  },

  // ───────────────────────── FULL EDITS (15–45s) ─────────────────────────
  {
    id: 'viral-hook-story', name: 'Viral Hook Story', kind: 'full', category: 'Viral Social',
    description: 'The 30-second retention arc: hook, setup, build, payoff, CTA. For Reels, TikTok, Shorts.',
    durationSeconds: 30, aspectRatios: ['9:16'],
    captionStyleId: 'viral', transition: 'pop', motion: 'dynamic-zoom', accentColor: '#FFD100',
    thumbnail: `${CDN}/7ffcc59451e5629f27adad968af3b7291895fa4f.jpg`,
    suggestedLoopId: 'dancehall-riddim',
    slots: [
      { name: 'Hook', durationSeconds: 3, motion: 'punch-zoom' },
      { name: 'Setup', durationSeconds: 6, motion: 'dynamic-zoom' },
      { name: 'Build', durationSeconds: 8, motion: 'parallax' },
      { name: 'Payoff', durationSeconds: 8, motion: 'slow-zoom-in' },
      { name: 'CTA', durationSeconds: 5, motion: 'product-focus' },
    ],
    headlineText: 'WATCH THIS', subText: "You won't believe the end", ctaText: 'FOLLOW FOR MORE',
  },
  {
    id: 'music-video', name: 'Music Video', kind: 'full', category: 'Music Video',
    description: 'A full 45-second music-video cut: wide intro, verse, chorus, bridge, vignette outro.',
    durationSeconds: 45, aspectRatios: ['16:9', '9:16'],
    captionStyleId: 'karaoke-gold', transition: 'whip-pan', motion: 'parallax', accentColor: '#FFD100',
    suggestedLoopId: 'soca-groove',
    slots: [
      { name: 'Intro', durationSeconds: 5, motion: 'ken-burns' },
      { name: 'Verse', durationSeconds: 12, motion: 'parallax' },
      { name: 'Chorus', durationSeconds: 12, motion: 'dynamic-zoom' },
      { name: 'Bridge', durationSeconds: 8, motion: 'slow-zoom-out' },
      { name: 'Outro', durationSeconds: 8, motion: 'vignette' },
    ],
    headlineText: 'YOUR SONG TITLE', subText: 'ARTIST NAME', outroText: 'STREAMING EVERYWHERE',
  },
  {
    id: 'product-ad-15', name: 'Product Ad 15', kind: 'full', category: 'Ad',
    description: 'A tight 15-second product ad: problem, hero shot, offer, CTA. Feed-ready.',
    durationSeconds: 15, aspectRatios: ['1:1', '9:16'],
    captionStyleId: 'tiktok-premium', transition: 'snap-zoom', motion: 'product-focus', accentColor: '#FFD100',
    suggestedLoopId: 'chill-island',
    slots: [
      { name: 'Problem', durationSeconds: 3, motion: 'subtle-shake' },
      { name: 'Product Hero', durationSeconds: 6, motion: 'product-focus' },
      { name: 'Offer', durationSeconds: 4, motion: 'punch-zoom' },
      { name: 'CTA', durationSeconds: 2, motion: 'flash' },
    ],
    headlineText: 'NEW DROP', subText: 'Premium quality. Limited run.', ctaText: 'SHOP NOW — LINK IN BIO',
  },
  {
    id: 'commercial-30', name: 'Commercial 30', kind: 'full', category: 'Commercial',
    description: 'A polished 30-second brand commercial with a film dissolve and a clean end card.',
    durationSeconds: 30, aspectRatios: ['16:9'],
    captionStyleId: 'gold-premium', transition: 'film-dissolve', motion: 'ken-burns', accentColor: '#FFE9A8',
    thumbnail: `${CDN}/109aa936a39686d3c5dbfea0296847264c470e5a.jpg`,
    suggestedLoopId: 'chill-island',
    slots: [
      { name: 'Open', durationSeconds: 6, motion: 'ken-burns' },
      { name: 'Story', durationSeconds: 10, motion: 'parallax' },
      { name: 'Product', durationSeconds: 8, motion: 'product-focus' },
      { name: 'End Card', durationSeconds: 6, motion: 'vignette' },
    ],
    headlineText: 'YOUR BRAND', subText: 'Quality you can feel', outroText: 'YOUR BRAND — SHOP TODAY',
  },
  {
    id: 'event-promo', name: 'Event Promo', kind: 'full', category: 'Event Promo',
    description: 'A 20-second party promo: hype open, lineup, details, ticket CTA. Heartbeat energy.',
    durationSeconds: 20, aspectRatios: ['9:16'],
    captionStyleId: 'fire', transition: 'heartbeat', motion: 'dynamic-zoom', accentColor: '#FF8A00',
    thumbnail: `${CDN}/6e8bb861ef276d4c38e2d2344726150144709e22.jpg`,
    suggestedLoopId: 'soca-groove',
    slots: [
      { name: 'Hype Open', durationSeconds: 4, motion: 'dynamic-zoom' },
      { name: 'Lineup', durationSeconds: 6, motion: 'punch-zoom' },
      { name: 'Details', durationSeconds: 6, motion: 'subtle-shake' },
      { name: 'CTA', durationSeconds: 4, motion: 'flash' },
    ],
    headlineText: 'THE BIG PARTY', subText: 'SAT NIGHT • YOUR VENUE', ctaText: 'GET YOUR TICKETS',
  },
  {
    id: 'podcast-clip', name: 'Podcast Clip', kind: 'full', category: 'Podcast',
    description: 'A 30-second podcast clip: quotable cold open, readable captions, lower-third feel.',
    durationSeconds: 30, aspectRatios: ['9:16', '16:9'],
    captionStyleId: 'podcast', transition: 'fadeup', motion: 'slow-zoom-in', accentColor: '#FFFFFF',
    thumbnail: `${CDN}/52c6ef0b8c1181fce0ab781e8f95f731a21cf46b.jpg`,
    slots: [
      { name: 'Cold Open', durationSeconds: 5, motion: 'slow-zoom-in' },
      { name: 'Conversation', durationSeconds: 15, motion: 'spotlight' },
      { name: 'Insight', durationSeconds: 7, motion: 'slow-zoom-in' },
      { name: 'Outro', durationSeconds: 3, motion: 'vignette' },
    ],
    subText: 'PODCAST NAME — EP. 1', outroText: 'FULL EPISODE OUT NOW',
  },
  {
    id: 'youtube-intro', name: 'YouTube Intro', kind: 'full', category: 'YouTube',
    description: 'A 20-second channel opener: light-leak ident, title card, montage, welcome.',
    durationSeconds: 20, aspectRatios: ['16:9'],
    captionStyleId: 'minimal-clean', transition: 'light-leak', motion: 'slow-zoom-in', accentColor: '#FFD100',
    suggestedLoopId: 'chill-island',
    slots: [
      { name: 'Channel Ident', durationSeconds: 4, motion: 'light-sweep' },
      { name: 'Title Card', durationSeconds: 6, motion: 'slow-zoom-in' },
      { name: 'Preview Montage', durationSeconds: 7, motion: 'parallax' },
      { name: 'Welcome', durationSeconds: 3, motion: 'vignette' },
    ],
    headlineText: 'YOUR CHANNEL', subText: 'NEW VIDEO EVERY WEEK', ctaText: 'SUBSCRIBE',
  },
  {
    id: 'before-after', name: 'Before / After', kind: 'full', category: 'Ad',
    description: 'A 15-second transformation ad with a slide-split reveal and a product-focus finish.',
    durationSeconds: 15, aspectRatios: ['9:16'],
    captionStyleId: 'bold-outline', transition: 'slideSplit', motion: 'product-focus', accentColor: '#FFFFFF',
    slots: [
      { name: 'Before', durationSeconds: 5, motion: 'vignette' },
      { name: 'Transform', durationSeconds: 2, motion: 'flash' },
      { name: 'After', durationSeconds: 5, motion: 'product-focus' },
      { name: 'CTA', durationSeconds: 3, motion: 'punch-zoom' },
    ],
    headlineText: 'THE GLOW UP', ctaText: 'TRY IT YOURSELF',
  },
  {
    id: 'testimonial', name: 'Testimonial', kind: 'full', category: 'Store Service',
    description: 'A warm 25-second testimonial: quote open, story, result, store end card.',
    durationSeconds: 25, aspectRatios: ['4:5', '9:16'],
    captionStyleId: 'heartbeat', transition: 'fade', motion: 'slow-zoom-in', accentColor: '#FF8A5C',
    suggestedLoopId: 'chill-island',
    slots: [
      { name: 'Quote Open', durationSeconds: 5, motion: 'slow-zoom-in' },
      { name: 'Story', durationSeconds: 12, motion: 'ken-burns' },
      { name: 'Result', durationSeconds: 5, motion: 'spotlight' },
      { name: 'End Card', durationSeconds: 3, motion: 'vignette' },
    ],
    headlineText: 'REAL RESULTS', subText: '— A HAPPY CUSTOMER', outroText: 'YOUR STORE NAME',
  },
  {
    id: 'lyric-visualizer', name: 'Lyric Visualizer', kind: 'full', category: 'Music Video',
    description: 'A 30-second lyric visualizer: smoky dissolves, drifting visuals, rainbow lyric captions.',
    durationSeconds: 30, aspectRatios: ['9:16', '16:9'],
    captionStyleId: 'rainbow', transition: 'smoke', motion: 'parallax', accentColor: '#FFD100',
    suggestedLoopId: 'dancehall-riddim',
    slots: [
      { name: 'Intro', durationSeconds: 4, motion: 'vignette' },
      { name: 'Verse Visual', durationSeconds: 10, motion: 'parallax' },
      { name: 'Chorus Visual', durationSeconds: 10, motion: 'dynamic-zoom' },
      { name: 'Outro', durationSeconds: 6, motion: 'slow-zoom-out' },
    ],
    headlineText: 'YOUR SONG TITLE', subText: 'LYRIC VIDEO',
  },
];

export function getTemplate(id: string): StudioTemplate | undefined {
  return STUDIO_TEMPLATES.find((t) => t.id === id);
}

export function templatesByCategory(category: TemplateCategory): StudioTemplate[] {
  return STUDIO_TEMPLATES.filter((t) => t.category === category);
}

export function templatesByKind(kind: TemplateKind): StudioTemplate[] {
  return STUDIO_TEMPLATES.filter((t) => t.kind === kind);
}
