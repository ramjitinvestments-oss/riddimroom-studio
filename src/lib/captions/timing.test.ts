import { describe, it, expect } from 'vitest';
import {
  CAPTION_GAP_SECONDS,
  captionWindowsOverlap,
  countCaptionOverlaps,
  resolveProjectCaptionOverlaps,
  serializeCaptionWindows,
} from './timing';
import { convertPromoTextToCaptions } from '../promo/viralCaptions';
import { buildSlamProject } from '../promo/recipes';
import { createDefaultProject } from '../projects/persistence';
import { addItem, generateTimelineId, getTracksByType } from '../timeline/utils';
import type { CaptionTimelineItem, MediaAsset, Project } from '../../types/timeline';

const asset: MediaAsset = {
  id: 'art1', type: 'image', fileName: 'poster.png', fileSize: 10, mimeType: 'image/png',
  storageUrl: 'https://example.com/poster.png', width: 1080, height: 1920,
} as unknown as MediaAsset;

function captionItem(project: Project, start: number, end: number, text: string): CaptionTimelineItem {
  const track = getTracksByType(project, 'caption')[0];
  return {
    id: generateTimelineId('item'),
    type: 'caption',
    trackId: track.id,
    startTime: start,
    endTime: end,
    zIndex: 5,
    visible: true,
    words: [{ text, start: 0, end: Math.max(0.1, end - start) }],
    captionStyleId: 'viral-gold-pop',
    source: 'manual',
    editable: true,
  };
}

describe('serializeCaptionWindows (R20)', () => {
  it('the measured promo overlap becomes a clean sequence', () => {
    // R17's real converted windows: hooks overlap, sub+CTA share the finale.
    const out = serializeCaptionWindows(
      [
        { startTime: 0.25, endTime: 2.15 }, // hook 1
        { startTime: 0.85, endTime: 2.75 }, // hook 2
        { startTime: 7.64, endTime: 12 }, // CTA
        { startTime: 8.19, endTime: 12 }, // sub
      ],
      { totalDuration: 12 },
    );
    expect(out[0]).toEqual({ startTime: 0.25, endTime: 0.85 });
    expect(out[1].startTime).toBeCloseTo(0.93, 2);
    expect(out[2].endTime).toBeCloseTo(8.24, 2);
    expect(out[3]).toEqual({ startTime: 8.32, endTime: 12 });
    for (let i = 0; i < out.length; i++) {
      expect(out[i].endTime - out[i].startTime).toBeGreaterThanOrEqual(0.6);
      for (let j = i + 1; j < out.length; j++) {
        expect(captionWindowsOverlap(out[i], out[j])).toBe(false);
      }
    }
  });

  it('already-clean windows pass through untouched', () => {
    const input = [
      { startTime: 0, endTime: 2 },
      { startTime: 3, endTime: 5 },
    ];
    expect(serializeCaptionWindows(input, { totalDuration: 10 })).toEqual(input);
  });

  it('property: randomized overlaps serialize disjoint, ordered, in-bounds', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let trial = 0; trial < 300; trial++) {
      const n = 2 + Math.floor(rand() * 4);
      const total = 30;
      const windows = Array.from({ length: n }, () => {
        const start = rand() * 20;
        return { startTime: start, endTime: start + 0.8 + rand() * 4 };
      });
      const out = serializeCaptionWindows(windows, { totalDuration: total });
      const sorted = [...out].sort((a, b) => a.startTime - b.startTime);
      for (let i = 0; i < sorted.length; i++) {
        expect(sorted[i].startTime).toBeGreaterThanOrEqual(0);
        expect(sorted[i].endTime).toBeLessThanOrEqual(total + 0.001);
        expect(sorted[i].endTime - sorted[i].startTime).toBeGreaterThanOrEqual(0.59);
        if (i > 0) {
          expect(sorted[i].startTime - sorted[i - 1].endTime).toBeGreaterThanOrEqual(CAPTION_GAP_SECONDS - 0.002);
        }
      }
    }
  });
});

describe('resolveProjectCaptionOverlaps (R20)', () => {
  it('clamps stacked cues and drops micro-cues', () => {
    let project = createDefaultProject('u1', 'T', 1080, 1920, { watermarkEnabled: false });
    project = addItem(project, captionItem(project, 0, 4, 'FIRST'));
    const micro = captionItem(project, 3.9, 4.05, 'MICRO');
    project = addItem(project, micro);
    project = addItem(project, captionItem(project, 3.95, 8, 'SECOND'));
    expect(countCaptionOverlaps(project)).toBeGreaterThan(0);
    const { project: fixed, removedIds } = resolveProjectCaptionOverlaps(project);
    expect(removedIds).toContain(micro.id);
    expect(countCaptionOverlaps(fixed)).toBe(0);
    const caps = fixed.items.filter((i) => i.type === 'caption').sort((a, b) => a.startTime - b.startTime);
    expect(caps).toHaveLength(2);
    expect(caps[0].endTime).toBeLessThanOrEqual(caps[1].startTime - CAPTION_GAP_SECONDS + 0.001);
  });
});

describe('promo conversion (R20 regression)', () => {
  it('converted slam captions never share the screen', () => {
    const base = createDefaultProject('u1', 'Viral', 1080, 1920, { watermarkEnabled: false });
    const project = buildSlamProject(base, asset, {
      hook1: 'ONE NIGHT.', hook2: 'TWO SOUNDS.', sub: 'SAT - DEC 20', cta: 'TICKETS OUT NOW',
    }, { duration: 12 });
    const beats = Array.from({ length: 24 }, (_, i) => i * 0.5);
    const out = convertPromoTextToCaptions(project, ['ONE NIGHT.', 'TWO SOUNDS.', 'SAT - DEC 20', 'TICKETS OUT NOW'], beats);
    expect(countCaptionOverlaps(out)).toBe(0);
    const caps = out.items.filter((i) => i.type === 'caption');
    expect(caps.length).toBeGreaterThanOrEqual(3);
  });
});
