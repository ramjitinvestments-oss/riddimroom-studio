import { describe, expect, it } from 'vitest';
import { campaignGatePrecheck } from './campaignPrecheck';
import { createDefaultProject } from '../projects/persistence';
import { appendMediaToTimeline } from '../timeline/insert';
import type { MediaAsset, Project } from '../../types/timeline';

function projectWithVideo(durationSeconds: number): Project {
  const asset: MediaAsset = {
    id: `asset-${durationSeconds}`,
    kind: 'video',
    storageUrl: 'https://example.com/clip.mp4',
    fileName: 'clip.mp4',
    sizeBytes: 1000,
    mimeType: 'video/mp4',
    durationSeconds,
    width: 1080,
    height: 1920,
    createdAt: 0,
  };
  return appendMediaToTimeline(createDefaultProject('uid-1'), asset);
}

describe('R40 P-37 — campaignGatePrecheck', () => {
  it('marks every over-limit piece before any render, with the gate message and the up-front note', () => {
    const short = projectWithVideo(10);
    const longA = projectWithVideo(45);
    const longB = projectWithVideo(90);
    const check = campaignGatePrecheck([short, longA, longB], 'free');
    expect(check.refused).toEqual([false, true, true]);
    expect(check.refusedCount).toBe(2);
    expect(check.messages[0]).toBeNull();
    expect(check.messages[1]).toContain('Free projects can be up to 30 seconds');
    expect(check.note).toBe("2 of these are over the Free limit and won't render.");
  });

  it('passes everything under the cap, with no note', () => {
    const check = campaignGatePrecheck([projectWithVideo(5), projectWithVideo(20)], 'free');
    expect(check.refused).toEqual([false, false]);
    expect(check.refusedCount).toBe(0);
    expect(check.note).toBeNull();
  });

  it('judges Lifetime pieces against the Lifetime cap and names it', () => {
    // A single item is clamped at the 600s technical ceiling (= the
    // Lifetime cap), so an over-Lifetime project needs two clips in a
    // row: 400 + 400 = 800s of timeline.
    let overLifetime = projectWithVideo(400);
    const second: MediaAsset = {
      id: 'asset-second-400',
      kind: 'video',
      storageUrl: 'https://example.com/clip2.mp4',
      fileName: 'clip2.mp4',
      sizeBytes: 1000,
      mimeType: 'video/mp4',
      durationSeconds: 400,
      width: 1080,
      height: 1920,
      createdAt: 0,
    };
    overLifetime = appendMediaToTimeline(overLifetime, second);
    const check = campaignGatePrecheck([projectWithVideo(45), overLifetime], 'lifetime');
    expect(check.refused).toEqual([false, true]);
    expect(check.note).toBe("1 of these are over the Lifetime limit and won't render.");
  });

  it('an empty campaign pre-checks clean', () => {
    expect(campaignGatePrecheck([], 'free')).toEqual({ refused: [], messages: [], refusedCount: 0, note: null });
  });
});
