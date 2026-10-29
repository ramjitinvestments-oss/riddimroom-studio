import { describe, it, expect } from 'vitest';
import { STUDIO_TEMPLATES, getTemplate, templatesByKind } from './templates';
import { applyFullTemplate, applyHookToProject, applyTemplateToProject } from './templates/apply';
import { GRADE_PRESETS, getGradePreset } from './grades';
import { createDefaultProject } from './projects/persistence';
import { addCaptionItems, addTextItem, appendMediaToTimeline } from './timeline/insert';
import { mergeCaptionItems, setItemSpeed, updateItem } from './timeline/utils';
import { validateProject } from './timeline/validation';
import { CAPTION_STYLES } from './captions/styles';
import { TRANSITION_PRESETS } from './transitions';
import { MOTION_EFFECTS } from './motionEffects';
import { addPipOverlay } from './pip';
import type { MediaAsset, Project } from '../types/timeline';

const KINETIC_REVEALS = ['typewriter', 'word-by-word', 'karaoke'];
const transitionIds = new Set<string>([...TRANSITION_PRESETS.map((p) => p.id), ...KINETIC_REVEALS, 'none']);
const motionIds = new Set<string>([...MOTION_EFFECTS.map((e) => e.id), 'none']);
const captionStyleIds = new Set(CAPTION_STYLES.map((s) => s.id));

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

function imageAsset(): MediaAsset {
  return {
    id: 'asset-image-1',
    kind: 'image',
    storageUrl: 'https://example.com/image.jpg',
    fileName: 'image.jpg',
    sizeBytes: 100_000,
    mimeType: 'image/jpeg',
    durationSeconds: 0,
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
      if (t.suggestedLoopId) expect(typeof t.suggestedLoopId, `${t.id} suggestedLoopId`).toBe('string');
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

  it('v3: every full template carries a cinematic grade that resolves to a preset', () => {
    for (const t of templatesByKind('full')) {
      expect(t.grade, t.id).toBeTruthy();
      expect(getGradePreset(t.grade), t.id).toBeDefined();
    }
    // Every named grade in the catalog has concrete values for all
    // three channels.
    for (const preset of GRADE_PRESETS) {
      expect(typeof preset.grade.brightness, preset.id).toBe('number');
      expect(typeof preset.grade.contrast, preset.id).toBe('number');
      expect(typeof preset.grade.saturation, preset.id).toBe('number');
    }
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
    // R37: music-video carries a per-slot transition sequence — the
    // first clip enters through the Intro slot's 'smoke'; as the only
    // slotted item its exit falls back to the template default
    // 'film-burn' (the v3 premium transition this assertion pinned
    // before per-slot sequences existed).
    expect(video?.type === 'video' ? video.animation?.entrance : undefined).toBe('smoke');
    expect(video?.type === 'video' ? video.animation?.exit : undefined).toBe('film-burn');

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

// ─── Templates v3: real slot trims, music auto-fit, grades ───────────

function audioLoopAsset(): MediaAsset {
  return {
    id: 'loop-asset-1',
    fileName: 'soca-groove.wav',
    storageUrl: 'https://example.com/loop.wav',
    kind: 'audio',
    mimeType: 'audio/wav',
    sizeBytes: 1,
    durationSeconds: 8,
    createdAt: 1,
  };
}

function byId(project: Project, id: string) {
  return project.items.find((i) => i.id === id)!;
}

describe('templates v3 — real slot trims', () => {
  it('video longer than its slot: window becomes the slot length, anchored at trimStart', () => {
    let project = createDefaultProject('uid-1');
    project = appendMediaToTimeline(project, videoAsset(30));
    const video = project.items.find((i) => i.type === 'video')!;
    const result = applyFullTemplate(project, getTemplate('music-video')!); // slots 5,7,8,6,7 = 33
    const item = byId(result.project, video.id);
    expect(item.type === 'video' ? item.trimStart : -1).toBe(0);
    expect(item.type === 'video' ? item.trimEnd : -1).toBe(5);
    expect(item.endTime - item.startTime).toBeCloseTo(5, 6);
    expect(result.reelStartSeconds).toBe(0);
    expect(result.reelEndSeconds).toBeCloseTo(5, 6);
    expect(result.shortenedClips.map((c) => c.itemId)).toEqual([video.id]);
    expect(result.musicAdded).toBe(false); // no loopAsset supplied
    expect(validateProject(result.project).valid).toBe(true);
  });

  it('window anchored near the source end shifts back to end at the source end', () => {
    let project = createDefaultProject('uid-1');
    project = appendMediaToTimeline(project, videoAsset(30));
    const video = project.items.find((i) => i.type === 'video')!;
    project = updateItem(project, video.id, { trimStart: 28, trimEnd: 30, duration: 2 });
    const result = applyFullTemplate(project, getTemplate('commercial-30')!); // slot 0 = 6s
    const item = byId(result.project, video.id);
    expect(item.type === 'video' ? item.trimStart : -1).toBe(24);
    expect(item.type === 'video' ? item.trimEnd : -1).toBe(30);
    expect(item.endTime - item.startTime).toBeCloseTo(6, 6);
  });

  it('video shorter than its slot uses the full source', () => {
    let project = createDefaultProject('uid-1');
    project = appendMediaToTimeline(project, videoAsset(2));
    const video = project.items.find((i) => i.type === 'video')!;
    const result = applyFullTemplate(project, getTemplate('product-ad-15')!); // slot 0 = 3s > 2s source
    const item = byId(result.project, video.id);
    expect(item.type === 'video' ? item.trimStart : -1).toBe(0);
    expect(item.type === 'video' ? item.trimEnd : -1).toBe(2);
    expect(item.endTime - item.startTime).toBeCloseTo(2, 6);
    expect(result.reelEndSeconds).toBeCloseTo(2, 6);
    expect(result.shortenedClips).toEqual([]); // nothing was shortened away
  });

  it('re-packs slotted items contiguously (gaps closed), images take the slot exactly', () => {
    let project = createDefaultProject('uid-1');
    project = appendMediaToTimeline(project, videoAsset(20));
    project = appendMediaToTimeline(project, imageAsset(), { role: 'photo' });
    project = appendMediaToTimeline(project, videoAsset(20));
    const [v1, img, v2] = project.items.filter((i) => i.type === 'video' || i.type === 'image');
    project = updateItem(project, v2.id, { startTime: 25, endTime: 45 }); // a gap before v2
    const result = applyFullTemplate(project, getTemplate('commercial-30')!); // slots 6,10,8,6
    const r1 = byId(result.project, v1.id);
    const rImg = byId(result.project, img.id);
    const r2 = byId(result.project, v2.id);
    expect(r1.startTime).toBe(0);
    expect(r1.endTime - r1.startTime).toBeCloseTo(6, 6);
    expect(rImg.startTime).toBeCloseTo(6, 6);
    expect(rImg.endTime - rImg.startTime).toBeCloseTo(10, 6); // image = slot exactly
    expect(r2.startTime).toBeCloseTo(16, 6);
    expect(r2.endTime - r2.startTime).toBeCloseTo(8, 6);
    expect(result.reelEndSeconds).toBeCloseTo(24, 6);
    expect(validateProject(result.project).valid).toBe(true);
  });

  it('items beyond the slot count take the LAST slot duration + treatment', () => {
    let project = createDefaultProject('uid-1');
    for (let k = 0; k < 6; k++) project = appendMediaToTimeline(project, videoAsset(20));
    const result = applyFullTemplate(project, getTemplate('product-ad-15')!); // slots 3,6,4,2
    const videos = result.project.items.filter((i) => i.type === 'video');
    expect(videos.map((i) => Math.round((i.endTime - i.startTime) * 100) / 100)).toEqual([3, 6, 4, 2, 2, 2]);
    expect(videos.map((i) => i.startTime)).toEqual([0, 3, 9, 13, 15, 17]);
    expect(result.reelEndSeconds).toBeCloseTo(19, 6);
    // The extra items still get the template grade. Entrances follow
    // the R37 per-slot transition sequence (Problem shake → Hero
    // dip-to-gold → Offer pop → CTA flash); extras beyond the slot
    // count clamp to the last slot, so they enter on 'flash' too.
    expect(videos.map((v) => (v.type === 'video' ? v.animation?.entrance : undefined))).toEqual([
      'shake', 'dip-to-gold', 'pop', 'flash', 'flash', 'flash',
    ]);
    for (const v of videos) {
      expect(v.type === 'video' ? v.colorGrade : undefined).toEqual(getGradePreset('clean-commercial')!.grade);
    }
  });

  it('fewer items than slots: no placeholder media is created', () => {
    let project = createDefaultProject('uid-1');
    project = appendMediaToTimeline(project, videoAsset(30));
    const before = project.items.filter((i) => i.type === 'video' || i.type === 'image').length;
    const result = applyFullTemplate(project, getTemplate('commercial-30')!); // 5 slots, 1 item
    const after = result.project.items.filter((i) => i.type === 'video' || i.type === 'image').length;
    expect(after).toBe(before);
  });

  it('keeps speed semantics: slot window is slotDuration × speed of source time', () => {
    let project = createDefaultProject('uid-1');
    project = appendMediaToTimeline(project, videoAsset(30));
    const video = project.items.find((i) => i.type === 'video')!;
    project = setItemSpeed(project, video.id, 2);
    const result = applyFullTemplate(project, getTemplate('music-video')!); // slot 0 = 5s on-timeline
    const item = byId(result.project, video.id);
    expect(item.type === 'video' ? item.trimEnd - item.trimStart : -1).toBeCloseTo(10, 6); // 5s × 2× speed
    expect(item.endTime - item.startTime).toBeCloseTo(5, 6);
  });

  it('PiP, audio, captions, and user text are NOT retimed; template texts anchor to the reel', () => {
    let project = createDefaultProject('uid-1');
    project = appendMediaToTimeline(project, videoAsset(20)); // main clip
    project = addPipOverlay(project, videoAsset(10), { atTime: 2 }); // PiP overlay
    project = addCaptionItems(project, {
      words: [{ text: 'hello', start: 1, end: 1.5 }],
      atTime: 1,
      captionStyleId: 'classic',
      source: 'manual',
    });
    project = addTextItem(project, { text: 'My own title', atTime: 12, durationSeconds: 3 });
    const pip = project.items.find((i) => i.type === 'video' && i.pip)!;
    const caption = project.items.find((i) => i.type === 'caption')!;
    const userText = project.items.find((i) => i.type === 'text' && i.text === 'My own title')!;
    const result = applyFullTemplate(project, getTemplate('commercial-30')!);
    const rPip = byId(result.project, pip.id);
    expect(rPip.startTime).toBe(pip.startTime);
    expect(rPip.endTime).toBe(pip.endTime);
    const rCaption = byId(result.project, caption.id);
    expect(rCaption.startTime).toBe(caption.startTime);
    expect(rCaption.endTime).toBe(caption.endTime);
    const rText = byId(result.project, userText.id);
    expect(rText.startTime).toBe(12);
    // Template headline anchors at the reel start (within the small
    // ≤0.2s lead-in the text plan uses); CTA/outro end at the reel end.
    const headline = result.project.items.find((i) => i.type === 'text' && i.role === 'title')!;
    expect(headline.startTime).toBeGreaterThanOrEqual(result.reelStartSeconds);
    expect(headline.startTime).toBeLessThanOrEqual(result.reelStartSeconds + 0.2);
    // CTA/outro texts carry role 'overlay' and are found by content:
    // the outro must END at the reel end.
    const outro = result.project.items.find((i) => i.type === 'text' && i.text === 'YOUR BRAND — SHOP TODAY')!;
    expect(outro.endTime).toBeCloseTo(result.reelEndSeconds, 6);
    expect(validateProject(result.project).valid).toBe(true);
  });

  it('applies the template grade project-wide — slotted AND PiP (v9 uniform look)', () => {
    let project = createDefaultProject('uid-1');
    project = appendMediaToTimeline(project, videoAsset(20));
    project = addPipOverlay(project, videoAsset(10), { atTime: 1 });
    const result = applyFullTemplate(project, getTemplate('music-video')!); // grade: moody-noir
    const main = result.project.items.find((i) => i.type === 'video' && !i.pip)!;
    const pip = result.project.items.find((i) => i.type === 'video' && i.pip)!;
    expect(main.type === 'video' ? main.colorGrade : undefined).toEqual(getGradePreset('moody-noir')!.grade);
    expect(pip.type === 'video' ? pip.colorGrade : undefined).toEqual(getGradePreset('moody-noir')!.grade);
  });
});

describe('templates v3 — music auto-fit', () => {
  it('adds the suggested loop fitted to the reel when the project has no music', () => {
    let project = createDefaultProject('uid-1');
    project = appendMediaToTimeline(project, videoAsset(30));
    const loop = audioLoopAsset(); // 8s source
    const result = applyFullTemplate(project, getTemplate('viral-hook-story')!, { loopAsset: loop });
    // Single clip → slot 0 = 3s reel; the 8s loop is longer → trim mode.
    expect(result.musicAdded).toBe(true);
    expect(result.reelEndSeconds).toBeCloseTo(3, 6);
    const music = result.project.items.find((i) => i.type === 'audio' && i.role === 'music')!;
    expect(music.startTime).toBeCloseTo(result.reelStartSeconds, 6);
    expect(music.endTime).toBeCloseTo(result.reelEndSeconds, 6);
    expect(music.type === 'audio' ? music.loop : undefined).toBeFalsy();
    expect(music.type === 'audio' ? music.trimEnd : -1).toBeCloseTo(3, 6);
    expect(music.type === 'audio' ? music.fade?.fadeOutDuration : -1).toBeCloseTo(0.5, 6);
    expect(result.project.mediaAssets[loop.id]).toBeDefined(); // asset registered, no dangling ref
    expect(validateProject(result.project).valid).toBe(true);
  });

  it('loops the music when the reel is longer than the loop source', () => {
    let project = createDefaultProject('uid-1');
    project = appendMediaToTimeline(project, videoAsset(30));
    project = appendMediaToTimeline(project, videoAsset(30));
    const loop = audioLoopAsset(); // 8s
    const result = applyFullTemplate(project, getTemplate('viral-hook-story')!, { loopAsset: loop });
    // Reel = 3 + 6 = 9s > 8s source → loop mode, full source window.
    expect(result.reelEndSeconds).toBeCloseTo(9, 6);
    const music = result.project.items.find((i) => i.type === 'audio' && i.role === 'music')!;
    expect(music.type === 'audio' ? music.loop : undefined).toBe(true);
    expect(music.type === 'audio' ? music.trimEnd : -1).toBeCloseTo(8, 6);
    expect(music.endTime - music.startTime).toBeCloseTo(9, 6);
  });

  it('never touches existing music, even when a loop asset is supplied', () => {
    let project = createDefaultProject('uid-1');
    project = appendMediaToTimeline(project, videoAsset(30));
    project = appendMediaToTimeline(project, audioLoopAsset(), { role: 'music' });
    const existing = project.items.find((i) => i.type === 'audio')!;
    const result = applyFullTemplate(project, getTemplate('viral-hook-story')!, { loopAsset: audioLoopAsset() });
    expect(result.musicAdded).toBe(false);
    const audios = result.project.items.filter((i) => i.type === 'audio');
    expect(audios).toHaveLength(1);
    expect(byId(result.project, existing.id).startTime).toBe(existing.startTime);
    expect(byId(result.project, existing.id).endTime).toBe(existing.endTime);
  });

  it('adds no music without a supplied loop asset (pure apply stays asset-free)', () => {
    let project = createDefaultProject('uid-1');
    project = appendMediaToTimeline(project, videoAsset(30));
    const result = applyFullTemplate(project, getTemplate('viral-hook-story')!);
    expect(result.musicAdded).toBe(false);
    expect(result.project.items.some((i) => i.type === 'audio')).toBe(false);
  });
});

describe('v9 preset FRAME — crop-to-preset, project-wide grade, canvas switch', () => {
  const videoAsset = (id: string, w: number, h: number): MediaAsset => ({
    id, kind: 'video', storageUrl: `https://x.test/${id}.mp4`, fileName: `${id}.mp4`,
    sizeBytes: 1, mimeType: 'video/mp4', durationSeconds: 30, width: w, height: h, createdAt: 0,
  });

  it('computeFrameCrop: wide source into a vertical frame crops the sides, centred', async () => {
    const { computeFrameCrop } = await import('./templates/apply');
    const crop = computeFrameCrop(1920, 1080, 9 / 16, 0.38)!;
    expect(crop.width).toBeCloseTo(31.64, 1);
    expect(crop.x).toBeCloseTo(34.18, 1);
    expect(crop.height).toBe(100);
    expect(crop.y).toBe(0);
  });

  it('computeFrameCrop: tall source into a wide frame biases the window upward for video', async () => {
    const { computeFrameCrop } = await import('./templates/apply');
    const crop = computeFrameCrop(1080, 1920, 16 / 9, 0.38)!;
    expect(crop.width).toBe(100);
    expect(crop.height).toBeCloseTo(31.64, 1);
    // window centre at 38% of height: y = 38 - 15.82 = 22.18
    expect(crop.y).toBeCloseTo(22.18, 1);
    expect(computeFrameCrop(1920, 1080, 16 / 9)).toBeUndefined();
  });

  it('every full template carries a frame matching its first-listed aspect', () => {
    for (const t of templatesByKind('full')) {
      expect(t.frame, t.id).toBeDefined();
      expect(t.frame!.aspect).toBe(t.aspectRatios[0]);
    }
  });

  it('apply crops the slotted video to the frame AND grades non-slotted media too', () => {
    let p = createDefaultProject('u1');
    p = appendMediaToTimeline(p, videoAsset('hero', 1920, 1080));
    // a PiP overlay video: not slotted, no frame crop — but graded
    p = addPipOverlay(p, videoAsset('pipvid', 1280, 720), { atTime: 0 });
    const result = applyFullTemplate(p, getTemplate('viral-hook-story')!);
    const hero = result.project.items.find((i) => i.type === 'video' && i.mediaAssetId === 'hero')!;
    const heroV = hero.type === 'video' ? hero : undefined;
    expect(heroV?.crop).toBeDefined();
    expect(heroV?.crop?.width).toBeCloseTo(31.64, 1);
    expect(heroV?.colorGrade).toEqual(getGradePreset('vivid-party')!.grade);
    const pip = result.project.items.find((i) => i.type === 'video' && i.mediaAssetId === 'pipvid')!;
    const pipV = pip.type === 'video' ? pip : undefined;
    expect(pipV?.crop).toBeUndefined();
    expect(pipV?.colorGrade).toEqual(getGradePreset('vivid-party')!.grade);
    // the panel's Reframe step is driven by framedItems: hero in, PiP out
    expect(result.framedItems.map((f) => f.itemId)).toEqual([hero.id]);
    expect(validateProject(result.project).valid).toBe(true);
  });

  it('switchToFrame moves the canvas to the frame aspect in the same apply', () => {
    let p = createDefaultProject('u1'); // 1080x1920 default
    p = { ...p, canvasWidth: 1920, canvasHeight: 1080 };
    p = appendMediaToTimeline(p, videoAsset('hero', 1920, 1080));
    const plain = applyFullTemplate(p, getTemplate('viral-hook-story')!);
    expect(plain.canvasSwitched).toBe(false);
    expect(plain.project.canvasWidth).toBe(1920);
    const switched = applyFullTemplate(p, getTemplate('viral-hook-story')!, { switchToFrame: true });
    expect(switched.canvasSwitched).toBe(true);
    expect(switched.project.canvasWidth).toBe(1080);
    expect(switched.project.canvasHeight).toBe(1920);
  });

  it('card-stage templates place slotted heroes as inset cards', () => {
    let p = createDefaultProject('u1');
    p = appendMediaToTimeline(p, videoAsset('prod', 1080, 1080));
    const result = applyFullTemplate(p, getTemplate('product-ad-15')!);
    const hero = result.project.items.find((i) => i.type === 'video')!;
    expect(hero.type === 'video' ? hero.position : undefined).toEqual({ x: 50, y: 44 });
    expect(hero.type === 'video' ? hero.scale : undefined).toBe(0.84);
  });
});
