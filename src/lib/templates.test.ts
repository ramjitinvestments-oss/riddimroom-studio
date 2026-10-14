import { describe, it, expect } from 'vitest';
import { STUDIO_TEMPLATES, getTemplate, templatesByKind } from './templates';
import { applyHookToProject, applyTemplateToProject } from './templates/apply';
import { createDefaultProject } from './projects/persistence';
import { addCaptionItems, appendMediaToTimeline } from './timeline/insert';
import { mergeCaptionItems, updateItem } from './timeline/utils';
import { validateProject } from './timeline/validation';
import { CAPTION_STYLES } from './captions/styles';
import { TRANSITION_PRESETS } from './transitions';
import { MOTION_EFFECTS } from './motionEffects';
import { LOOP_DEFS } from './media/loops';
import type { MediaAsset } from '../types/timeline';

const KINETIC_REVEALS = ['typewriter', 'word-by-word', 'karaoke'];
const transitionIds = new Set<string>([...TRANSITION_PRESETS.map((p) => p.id), ...KINETIC_REVEALS, 'none']);
const motionIds = new Set<string>([...MOTION_EFFECTS.map((e) => e.id), 'none']);
const captionStyleIds = new Set(CAPTION_STYLES.map((s) => s.id));
const loopIds = new Set(LOOP_DEFS.map((l) => l.id));

const HOOK_IDS = [
  'gold-smash-intro', 'glitch-hook', 'fete-countdown', 'breaking-news', 'price-pop',
  'new-drop-alert', 'split-reveal', 'karaoke-teaser', 'bounce-text-hook', 'letterbox-reveal',
];
const FULL_IDS = [
  'viral-hook-story', 'music-video', 'product-ad-15', 'commercial-30', 'event-promo',
  'podcast-clip', 'youtube-intro', 'before-after', 'testimonial', 'lyric-visualizer',
];

function videoAsset(durationSeconds: number): MediaAsset {
  return {
    id: 'asset-video-1',
    kind: 'video',
    storageUrl: 'https://example.com/video.mp4',
    fileName: 'video.mp4',
    sizeBytes: 1_000_000,
    mimeType: 'video/mp4',
    durationSeconds,
    width: 1080,
    height: 1920,
    createdAt: 0,
  };
}

function projectWithCaptionAndClip() {
  let project = createDefaultProject('uid-1');
  project = appendMediaToTimeline(project, videoAsset(30));
  project = addCaptionItems(project, {
    words: [{ text: 'hello', start: 0, end: 0.5 }],
    atTime: 0,
    captionStyleId: 'classic',
    source: 'manual',
  });
  return project;
}

describe('templates v2 — catalog integrity', () => {
  it('has exactly 20 templates with unique ids — 10 hooks + 10 full edits', () => {
    expect(STUDIO_TEMPLATES).toHaveLength(20);
    expect(new Set(STUDIO_TEMPLATES.map((t) => t.id)).size).toBe(20);
    expect(templatesByKind('hook')).toHaveLength(10);
    expect(templatesByKind('full')).toHaveLength(10);
  });

  it('contains exactly the required 20 ids', () => {
    expect(templatesByKind('hook').map((t) => t.id).sort()).toEqual([...HOOK_IDS].sort());
    expect(templatesByKind('full').map((t) => t.id).sort()).toEqual([...FULL_IDS].sort());
  });

  it('hook durations are within 1.5–4s and full durations within 15–45s', () => {
    for (const t of templatesByKind('hook')) {
      expect(t.durationSeconds, t.id).toBeGreaterThanOrEqual(1.5);
      expect(t.durationSeconds, t.id).toBeLessThanOrEqual(4);
    }
    for (const t of templatesByKind('full')) {
      expect(t.durationSeconds, t.id).toBeGreaterThanOrEqual(15);
      expect(t.durationSeconds, t.id).toBeLessThanOrEqual(45);
    }
  });

  it('every referenced transition / motion / caption style / loop id exists in its catalog', () => {
    for (const t of STUDIO_TEMPLATES) {
      if (t.captionStyleId) expect(captionStyleIds.has(t.captionStyleId), `${t.id} captionStyleId`).toBe(true);
      expect(transitionIds.has(t.transition), `${t.id} transition`).toBe(true);
      expect(motionIds.has(t.motion), `${t.id} motion`).toBe(true);
      if (t.suggestedLoopId) expect(loopIds.has(t.suggestedLoopId), `${t.id} suggestedLoopId`).toBe(true);
      for (const slot of t.slots ?? []) {
        expect(motionIds.has(slot.motion), `${t.id} slot ${slot.name} motion`).toBe(true);
      }
      for (const el of t.elements ?? []) {
        expect(transitionIds.has(el.entrance), `${t.id} element entrance`).toBe(true);
        if (el.exit) expect(transitionIds.has(el.exit), `${t.id} element exit`).toBe(true);
        // Rendered placeholder text never uses the word "fete" (video rule).
        expect(el.text.toLowerCase()).not.toContain('fete');
      }
      for (const text of [t.headlineText, t.subText, t.ctaText, t.outroText]) {
        if (text) expect(text.toLowerCase()).not.toContain('fete');
      }
    }
  });

  it('full-template slot durations sum to the target duration ±10%', () => {
    for (const t of templatesByKind('full')) {
      expect(t.slots?.length, t.id).toBeGreaterThan(0);
      const sum = (t.slots ?? []).reduce((acc, s) => acc + s.durationSeconds, 0);
      expect(Math.abs(sum - t.durationSeconds), `${t.id}: slots ${sum}s vs target ${t.durationSeconds}s`)
        .toBeLessThanOrEqual(t.durationSeconds * 0.1);
    }
  });

  it('hooks carry elements that fit inside the hook duration', () => {
    for (const t of templatesByKind('hook')) {
      expect(t.elements?.length, t.id).toBeGreaterThan(0);
      for (const el of t.elements ?? []) {
        expect(el.offsetSeconds + el.durationSeconds, `${t.id} "${el.text}"`).toBeLessThanOrEqual(t.durationSeconds + 0.001);
      }
    }
  });

  it('each kind is genuinely varied: distinct transitions and caption styles within the kind', () => {
    for (const kind of ['hook', 'full'] as const) {
      const list = templatesByKind(kind);
      expect(new Set(list.map((t) => t.transition)).size, `${kind} transitions`).toBe(list.length);
      expect(new Set(list.map((t) => t.captionStyleId)).size, `${kind} caption styles`).toBe(list.length);
    }
  });

  it('getTemplate returns undefined for unknown id', () => {
    expect(getTemplate('nope')).toBeUndefined();
  });
});

describe('templates v2 — full apply', () => {
  it('restyles captions, applies slot motion + transition to clips, adds placeholders, stays valid', () => {
    const project = projectWithCaptionAndClip();
    const template = getTemplate('music-video')!;
    const next = applyTemplateToProject(project, template);

    const caption = next.items.find((i) => i.type === 'caption');
    expect(caption?.type === 'caption' ? caption.captionStyleId : undefined).toBe('karaoke-gold');

    const video = next.items.find((i) => i.type === 'video');
    // First clip takes the first slot's motion (Intro = ken-burns) and the template transition.
    expect(video?.type === 'video' ? video.motion?.type : undefined).toBe('ken-burns');
    expect(video?.type === 'video' ? video.animation?.entrance : undefined).toBe('whip-pan');

    // Placeholders: headline + sub + outro added.
    const texts = next.items.filter((i) => i.type === 'text').map((i) => (i.type === 'text' ? i.text : ''));
    expect(texts).toContain('YOUR SONG TITLE');
    expect(texts).toContain('ARTIST NAME');
    expect(texts).toContain('STREAMING EVERYWHERE');

    // Media assets untouched; project still validates.
    expect(next.mediaAssets).toEqual(project.mediaAssets);
    expect(validateProject(next).valid).toBe(true);
  });

  it('re-applying does not duplicate placeholder texts', () => {
    const project = projectWithCaptionAndClip();
    const template = getTemplate('commercial-30')!;
    const once = applyTemplateToProject(project, template);
    const twice = applyTemplateToProject(once, template);
    const texts = twice.items.filter((i) => i.type === 'text');
    expect(texts).toHaveLength(once.items.filter((i) => i.type === 'text').length);
  });
});

describe('templates v2 — hook apply', () => {
  it('inserts hook text elements at the given time with their reveal animations', () => {
    const project = projectWithCaptionAndClip();
    const template = getTemplate('gold-smash-intro')!;
    const next = applyHookToProject(project, template, 5);

    const title = next.items.find((i) => i.type === 'text' && i.type === 'text' && (i as { text?: string }).text === 'YOUR TITLE');
    expect(title?.type === 'text' ? title.startTime : -1).toBeCloseTo(5, 5);
    expect(title?.type === 'text' ? title.animation?.entrance : undefined).toBe('pop');

    const sub = next.items.find((i) => i.type === 'text' && (i as { text?: string }).text === 'WATCH THIS');
    expect(sub?.type === 'text' ? sub.startTime : -1).toBeCloseTo(5.35, 5);

    // Hook restyles existing captions and pushes motion onto the clip underneath.
    const caption = next.items.find((i) => i.type === 'caption');
    expect(caption?.type === 'caption' ? caption.captionStyleId : undefined).toBe('gold-premium');
    const video = next.items.find((i) => i.type === 'video');
    expect(video?.type === 'video' ? video.motion?.type : undefined).toBe('punch-zoom');

    expect(validateProject(next).valid).toBe(true);
  });

  it('countdown hook inserts its beats in sequence', () => {
    const project = projectWithCaptionAndClip();
    const next = applyHookToProject(project, getTemplate('fete-countdown')!, 0);
    const beats = next.items
      .filter((i) => i.type === 'text')
      .map((i) => (i.type === 'text' ? { text: i.text, start: i.startTime } : null))
      .filter(Boolean)
      .sort((a, b) => a!.start - b!.start);
    expect(beats.map((b) => b!.text)).toEqual(['3', '2', '1', "LET'S GO!"]);
    expect(beats.map((b) => Math.round(b!.start * 10) / 10)).toEqual([0, 0.9, 1.8, 2.7]);
  });

  it('split-reveal sets the end-transform glide on a PiP item on screen', () => {
    let project = projectWithCaptionAndClip();
    const video = project.items.find((i) => i.type === 'video')!;
    project = updateItem(project, video.id, {
      pip: { shape: 'circle', borderWidth: 4, borderColor: '#FFFFFF', shadow: true, isPip: true },
    });
    const next = applyHookToProject(project, getTemplate('split-reveal')!, 0);
    const pip = next.items.find((i) => i.type === 'video');
    expect(pip?.type === 'video' ? pip.endTransform?.position : undefined).toEqual({ x: 78, y: 24 });
  });

  it('applyTemplateToProject delegates hooks to insertion at t=0', () => {
    const project = projectWithCaptionAndClip();
    const next = applyTemplateToProject(project, getTemplate('bounce-text-hook')!);
    expect(next.items.some((i) => i.type === 'text' && (i as { text?: string }).text === 'STOP SCROLLING')).toBe(true);
  });
});

describe('mergeCaptionItems', () => {
  it('merges words and removes the second item', () => {
    let project = createDefaultProject('uid-1');
    project = addCaptionItems(project, { words: [{ text: 'one', start: 0, end: 0.4 }], atTime: 0, captionStyleId: 'classic', source: 'manual' });
    project = addCaptionItems(project, { words: [{ text: 'two', start: 0, end: 0.4 }], atTime: 1, captionStyleId: 'classic', source: 'manual' });
    const ids = project.items.filter((i) => i.type === 'caption').map((i) => i.id);
    expect(ids).toHaveLength(2);
    const next = mergeCaptionItems(project, ids[0], ids[1]);
    const captions = next.items.filter((i) => i.type === 'caption');
    expect(captions).toHaveLength(1);
    if (captions[0].type === 'caption') {
      expect(captions[0].words.map((w) => w.text)).toEqual(['one', 'two']);
    }
  });
  it('no-ops for same id or non-caption', () => {
    const project = createDefaultProject('uid-1');
    expect(mergeCaptionItems(project, 'a', 'a')).toBe(project);
    expect(mergeCaptionItems(project, 'missing', 'also-missing')).toBe(project);
  });
});
