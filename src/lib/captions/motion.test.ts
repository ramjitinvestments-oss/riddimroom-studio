import { describe, it, expect } from 'vitest';
import { captionMotionForStyleHint, captionMotionSelection, resolveCaptionMotion, setAllCaptionMotion } from './motion';
import { getCaptionStyle } from './styles';
import { createDefaultProject } from '../projects/persistence';
import { addItem, generateTimelineId, getTracksByType } from '../timeline/utils';
import type { CaptionTimelineItem, Project } from '../../types/timeline';

describe('captionMotionForStyleHint — the styles’ hint vocabulary maps to Fade/Pop/Rise only', () => {
  it('loud hints pop, fadeup rises, everything else fades', () => {
    expect(captionMotionForStyleHint('pop')).toBe('pop');
    expect(captionMotionForStyleHint('bounce')).toBe('pop');
    expect(captionMotionForStyleHint('fire')).toBe('pop');
    expect(captionMotionForStyleHint('fadeup')).toBe('rise');
    expect(captionMotionForStyleHint('fade')).toBe('fade');
    // The karaoke highlight is the motion inside these cues — the block must not fight it.
    expect(captionMotionForStyleHint('word-by-word')).toBe('fade');
    expect(captionMotionForStyleHint('glitch')).toBe('fade');
    expect(captionMotionForStyleHint('heartbeat')).toBe('fade');
    expect(captionMotionForStyleHint('rainbow')).toBe('fade');
    expect(captionMotionForStyleHint(undefined)).toBe('fade');
    expect(captionMotionForStyleHint('something-new')).toBe('fade');
  });

  it('the R42 launch templates get their planned motion from their styles alone', () => {
    // Plan Phase C launch set — no template data changes, the styles carry it.
    expect(captionMotionForStyleHint(getCaptionStyle('viral').animation)).toBe('pop'); // Viral Hook Story
    expect(captionMotionForStyleHint(getCaptionStyle('tiktok-premium').animation)).toBe('pop'); // Product Ad 15
    expect(captionMotionForStyleHint(getCaptionStyle('fire').animation)).toBe('pop'); // Event Promo
    expect(captionMotionForStyleHint(getCaptionStyle('podcast').animation)).toBe('fade'); // Podcast Clip
    expect(captionMotionForStyleHint(getCaptionStyle('karaoke-gold').animation)).toBe('fade'); // Music Video / Lyric Visualizer
  });
});

function caption(project: Project, overrides: Partial<CaptionTimelineItem> = {}): CaptionTimelineItem {
  const track = getTracksByType(project, 'caption')[0];
  return {
    id: generateTimelineId('item'),
    type: 'caption',
    trackId: track.id,
    startTime: 0,
    endTime: 3,
    zIndex: 5,
    visible: true,
    words: [{ text: 'Hello', start: 0, end: 3 }],
    captionStyleId: 'viral',
    source: 'manual',
    editable: true,
    ...overrides,
  };
}

describe('resolveCaptionMotion — override wins, style decides by default, off is motionless', () => {
  const project = createDefaultProject('Motion');
  it('follows the style when there is no override', () => {
    expect(resolveCaptionMotion(caption(project))).toBe('pop'); // viral → pop
    expect(resolveCaptionMotion(caption(project, { captionStyleId: 'classic' }))).toBe('fade');
    expect(resolveCaptionMotion(caption(project, { captionStyleId: 'minimal-box' }))).toBe('rise');
  });
  it('an override beats the style, and off returns null (the old hard cut)', () => {
    expect(resolveCaptionMotion(caption(project, { animation: 'fade' }))).toBe('fade');
    expect(resolveCaptionMotion(caption(project, { animation: 'rise' }))).toBe('rise');
    expect(resolveCaptionMotion(caption(project, { animation: 'off' }))).toBeNull();
  });
});

describe('setAllCaptionMotion / captionMotionSelection — the one-tap bulk control', () => {
  function projectWithCaptions(): Project {
    let p = createDefaultProject('Bulk');
    p = addItem(p, caption(p));
    p = addItem(p, caption(p, { startTime: 4, endTime: 7 }));
    return p;
  }

  it('sets every cue in one transform and leaves other items untouched by reference', () => {
    const p = projectWithCaptions();
    const visualBefore = p.items.find((i) => i.type !== 'caption');
    const next = setAllCaptionMotion(p, 'rise');
    const cues = next.items.filter((i) => i.type === 'caption') as CaptionTimelineItem[];
    expect(cues.every((c) => c.animation === 'rise')).toBe(true);
    expect(next.items.find((i) => i.type !== 'caption')).toBe(visualBefore);
    expect(captionMotionSelection(next)).toBe('rise');
  });

  it("'style' clears the override key entirely (absent = follow the style)", () => {
    const p = setAllCaptionMotion(projectWithCaptions(), 'pop');
    const cleared = setAllCaptionMotion(p, 'style');
    const cues = cleared.items.filter((i) => i.type === 'caption') as CaptionTimelineItem[];
    expect(cues.every((c) => !('animation' in c))).toBe(true);
    expect(captionMotionSelection(cleared)).toBe('style');
  });

  it('selection reports mixed when cues disagree', () => {
    let p = projectWithCaptions();
    const first = p.items.find((i) => i.type === 'caption') as CaptionTimelineItem;
    const silenced: CaptionTimelineItem = { ...first, animation: 'off' };
    p = { ...p, items: p.items.map((i) => (i.id === first.id ? silenced : i)) };
    expect(captionMotionSelection(p)).toBe('mixed');
    expect(captionMotionSelection(createDefaultProject('Empty'))).toBe('style');
  });
});
