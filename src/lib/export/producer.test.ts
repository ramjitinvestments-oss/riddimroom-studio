import { describe, it, expect } from 'vitest';
import { buildProducerReport } from './producerReport';
import { buildSocialPosts, detectPostGenre } from './socialPosts';
import { createDefaultProject } from '../projects/persistence';
import { addTextItem, appendMediaToTimeline } from '../timeline/insert';
import { addCaptionItems } from '../timeline/insert';
import { addItem, addMediaAsset, generateTimelineId, getTracksByType } from '../timeline/utils';
import type { AudioTimelineItem, MediaAsset } from '../../types/timeline';

const videoAsset = (id: string): MediaAsset => ({
  id, kind: 'video', storageUrl: `https://x.test/${id}.mp4`, fileName: `${id}.mp4`,
  sizeBytes: 1, mimeType: 'video/mp4', durationSeconds: 12, width: 1080, height: 1920, createdAt: 0,
});
const audioAsset = (id: string): MediaAsset => ({
  id, kind: 'audio', storageUrl: `https://x.test/${id}.wav`, fileName: `${id}.wav`,
  sizeBytes: 1, mimeType: 'audio/wav', durationSeconds: 12, createdAt: 0,
});

function withMusic(p: ReturnType<typeof createDefaultProject>, seconds: number) {
  const track = getTracksByType(p, 'audio')[0];
  const item: AudioTimelineItem = {
    id: generateTimelineId('item'), type: 'audio', trackId: track.id, startTime: 0, endTime: seconds,
    zIndex: 99, visible: true, mediaAssetId: 'beat', role: 'music', volume: 0.9, muted: false,
    trimStart: 0, trimEnd: seconds, fade: { fadeInDuration: 0, fadeOutDuration: 0 },
  };
  return addItem(addMediaAsset(p, audioAsset('beat')), item);
}

function feedReadyProject() {
  let p = createDefaultProject('u1'); // 1080x1920
  p = { ...p, name: 'Viral Promo — Soca Fete Flyer' };
  p = appendMediaToTimeline(p, videoAsset('hero'));
  p = addTextItem(p, { text: 'ONE NIGHT. TWO SOUNDS.', atTime: 0, durationSeconds: 3, role: 'title' });
  p = addTextItem(p, { text: 'TICKETS: LINK IN BIO', atTime: 9, durationSeconds: 3, role: 'overlay' });
  p = addCaptionItems(p, {
    words: [
      { text: 'one', start: 0, end: 0.4 },
      { text: 'night', start: 0.5, end: 0.9 },
    ],
    atTime: 0,
    captionStyleId: 'subtitle',
    source: 'manual',
  });
  p = withMusic(p, 12);
  return p;
}

describe("producer's report", () => {
  it('R40 P-49d: the loudness line leads with the plain verdict, numbers in parentheses after', () => {
    const healthy = buildProducerReport(feedReadyProject(), { rmsDbfs: -14, peakDbfs: -1.2 });
    const beat = healthy.checks.find((c) => c.id === 'beat')!;
    expect(beat.detail.startsWith('Music is on at a healthy phone level (')).toBe(true);
    expect(beat.detail).toContain('average ≈ -14 dB, peak -1.2 dB)');
    const quiet = buildProducerReport(feedReadyProject(), { rmsDbfs: -40, peakDbfs: -9 });
    expect(quiet.checks.find((c) => c.id === 'beat')!.detail.startsWith('Music is on, but it is very quiet')).toBe(true);
    // No check line anywhere in the report leads with a dB number.
    for (const report of [healthy, quiet]) {
      for (const check of report.checks) {
        expect(check.detail.trimStart()).not.toMatch(/^-?\d+\s*dB/);
      }
    }
  });

  it('a feed-ready promo scores A with no fixes', () => {
    const report = buildProducerReport(feedReadyProject(), { rmsDbfs: -14, peakDbfs: -1.2 });
    expect(report.score).toBeGreaterThanOrEqual(90);
    expect(report.grade).toBe('A');
    expect(report.fixes).toEqual([]);
    expect(report.checks.find((c) => c.id === 'hook')?.status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'cta')?.detail).toContain('LINK IN BIO');
  });

  it('a bare silent clip fails hook/captions/beat with actionable fixes', () => {
    let p = createDefaultProject('u1');
    p = { ...p, canvasWidth: 1920, canvasHeight: 1080 };
    p = appendMediaToTimeline(p, videoAsset('plain'));
    const report = buildProducerReport(p);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
    expect(byId.captions).toBe('fail');
    expect(byId.beat).toBe('fail');
    expect(byId.format).toBe('warn');
    expect(report.fixes.length).toBeGreaterThanOrEqual(3);
    expect(report.score).toBeLessThan(60);
  });

  it('loudness from the finished file is reported honestly', () => {
    const report = buildProducerReport(feedReadyProject(), { rmsDbfs: -40, peakDbfs: -9 });
    const beat = report.checks.find((c) => c.id === 'beat');
    expect(beat?.status).toBe('warn');
    expect(beat?.detail).toContain('-40');
  });
});

describe('social posts — exactly 5 tags, always', () => {
  it('every platform post carries exactly five unique hashtags incl. #RiddimRoom', () => {
    const posts = buildSocialPosts(feedReadyProject());
    expect(posts).toHaveLength(4);
    for (const post of posts) {
      expect(post.hashtags, post.platform).toHaveLength(5);
      expect(new Set(post.hashtags).size).toBe(5);
      expect(post.hashtags).toContain('#RiddimRoom');
      const inText = post.text.match(/#\w+/g) ?? [];
      expect(inText, post.platform).toHaveLength(5);
    }
  });

  it('genre detection + CTA reuse from the video itself', () => {
    expect(detectPostGenre('Soca Fete Flyer')).toBe('soca');
    expect(detectPostGenre('Luxury listing — realtor tour')).toBe('realestate');
    const posts = buildSocialPosts(feedReadyProject());
    const tiktok = posts.find((p) => p.platform === 'tiktok')!;
    expect(tiktok.hashtags).toContain('#Soca');
    expect(tiktok.text).toContain('TICKETS: LINK IN BIO');
    const shorts = posts.find((p) => p.platform === 'shorts')!;
    expect(shorts.title!.length).toBeLessThanOrEqual(60);
  });
});
