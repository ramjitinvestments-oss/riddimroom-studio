/**
 * RiddimRoom Studio — curated template library (v1).
 *
 * Curated from boltvideoapp's 63-template catalog down to 12 premium,
 * distinct templates. Each template is a *starting point*, not a lock-in:
 * applying one sets the project's caption style, a transition, a motion
 * effect, and a title text item — the user can then edit everything.
 * Templates never change media, timing, or ownership.
 */

export interface StudioTemplate {
  id: string;
  name: string;
  category: 'trending' | 'business' | 'caribbean' | 'cinematic';
  description: string;
  captionStyleId: string;
  transition: string;
  motion: string;
  titleText: string;
  accentColor: string;
  aspectHint: '9:16' | '1:1' | '16:9' | '4:5';
  /** Optional card artwork (Artistly CDN still) shown as the template card's header image; templates without one get a designed monogram fallback header in the panel. */
  thumbnail?: string;
}

export const STUDIO_TEMPLATES: StudioTemplate[] = [
  { id: 'viral-hook', name: 'Viral Hook', category: 'trending', description: 'Punchy opener for Reels / TikTok / Shorts. Bold captions, pop transitions.', captionStyleId: 'viral', transition: 'pop', motion: 'punch-zoom', titleText: 'WATCH THIS', accentColor: '#FFD100', aspectHint: '9:16', thumbnail: 'https://cdn.artistly.ai/images/sd3/7ffcc59451e5629f27adad968af3b7291895fa4f.jpg' },
  { id: 'talking-head', name: 'Talking Head', category: 'trending', description: 'Clean talking-head / explainer. Minimal captions, soft fade, PiP-ready.', captionStyleId: 'minimal-box', transition: 'fade', motion: 'none', titleText: '', accentColor: '#FFFFFF', aspectHint: '9:16', thumbnail: 'https://cdn.artistly.ai/images/sd3/52c6ef0b8c1181fce0ab781e8f95f731a21cf46b.jpg' },
  { id: 'podcast-clip', name: 'Podcast Clip', category: 'business', description: 'Podcast / interview clip with readable captions and a lower-third feel.', captionStyleId: 'podcast', transition: 'fadeup', motion: 'none', titleText: '', accentColor: '#FFFFFF', aspectHint: '9:16' },
  { id: 'product-promo', name: 'Product Promo', category: 'business', description: 'Product spotlight: slow zoom, vignette, premium feel.', captionStyleId: 'tiktok-premium', transition: 'zoom', motion: 'product-focus', titleText: 'NEW DROP', accentColor: '#FFD100', aspectHint: '1:1' },
  { id: 'cinematic-promo', name: 'Cinematic Promo', category: 'cinematic', description: 'Film-dissolve + slow Ken Burns. For trailers and brand films.', captionStyleId: 'cinema', transition: 'film-dissolve', motion: 'ken-burns', titleText: '', accentColor: '#FFE9A8', aspectHint: '16:9', thumbnail: 'https://cdn.artistly.ai/images/sd3/109aa936a39686d3c5dbfea0296847264c470e5a.jpg' },
  { id: 'caribbean-fete', name: 'Caribbean Fete', category: 'caribbean', description: 'High-energy fete / party energy. Fire captions, heartbeat motion.', captionStyleId: 'fire', transition: 'heartbeat', motion: 'subtle-shake', titleText: 'FETE TIME', accentColor: '#FF8A00', aspectHint: '9:16', thumbnail: 'https://cdn.artistly.ai/images/sd3/6e8bb861ef276d4c38e2d2344726150144709e22.jpg' },
  { id: 'soca-energy', name: 'Soca Energy', category: 'caribbean', description: 'Bold yellow captions, bounce, rainbow accents. Pure soca.', captionStyleId: 'bold-yellow', transition: 'bounce', motion: 'dynamic-zoom', titleText: 'SOCA', accentColor: '#FFD100', aspectHint: '9:16' },
  { id: 'glitch-drop', name: 'Glitch Drop', category: 'trending', description: 'Cyber glitch for drops, teasers, and hype cuts.', captionStyleId: 'cyber-glitch', transition: 'glitch', motion: 'none', titleText: 'DROPPING SOON', accentColor: '#FFE14D', aspectHint: '9:16' },
  { id: 'impact-announcement', name: 'Impact Announcement', category: 'business', description: 'Big announcement / sale / launch. Impact captions, snap zoom.', captionStyleId: 'impact', transition: 'snap-zoom', motion: 'punch-zoom', titleText: 'BIG NEWS', accentColor: '#FF5C1A', aspectHint: '1:1' },
  { id: 'story-vlog', name: 'Story Vlog', category: 'trending', description: 'Soft story / vlog. Classic captions, gentle slide, no hype.', captionStyleId: 'classic', transition: 'slide-up', motion: 'slow-zoom-in', titleText: '', accentColor: '#FFFFFF', aspectHint: '9:16' },
  { id: 'rainbow-celebration', name: 'Rainbow Celebration', category: 'caribbean', description: 'Celebration / carnival. Rainbow captions, light sweep.', captionStyleId: 'rainbow', transition: 'rainbow', motion: 'light-sweep', titleText: 'CELEBRATE', accentColor: '#FFD100', aspectHint: '9:16' },
  { id: 'heartfelt', name: 'Heartfelt', category: 'cinematic', description: 'Warm, emotional, testimonial. Heartbeat pulse, soft captions.', captionStyleId: 'heartbeat', transition: 'fade', motion: 'slow-zoom-out', titleText: '', accentColor: '#FF8A5C', aspectHint: '4:5' },
];

export function getTemplate(id: string): StudioTemplate | undefined {
  return STUDIO_TEMPLATES.find((t) => t.id === id);
}

export function templatesByCategory(category: StudioTemplate['category']): StudioTemplate[] {
  return STUDIO_TEMPLATES.filter((t) => t.category === category);
}
