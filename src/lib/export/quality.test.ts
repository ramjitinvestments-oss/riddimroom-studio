import { describe, it, expect } from 'vitest';
import { resolveExportDimensions, resolveExportSettings } from './quality';

describe('resolveExportDimensions', () => {
  it('native returns the project dimensions unchanged', () => {
    expect(resolveExportDimensions(1920, 1080, 'native')).toEqual({ width: 1920, height: 1080 });
    expect(resolveExportDimensions(1080, 1920, 'native')).toEqual({ width: 1080, height: 1920 });
  });

  it('1080p of a 1080p project is the native size (scale 1)', () => {
    expect(resolveExportDimensions(1920, 1080, '1080p')).toEqual({ width: 1920, height: 1080 });
  });

  it('720p scales a 16:9 project down to 1280x720', () => {
    expect(resolveExportDimensions(1920, 1080, '720p')).toEqual({ width: 1280, height: 720 });
  });

  it('480p of a portrait 9:16 project targets the short edge and keeps dimensions even', () => {
    // scale = 480/1080; height 1920 * 480/1080 = 853.33 -> 854 (even, H.264-safe)
    expect(resolveExportDimensions(1080, 1920, '480p')).toEqual({ width: 480, height: 854 });
  });

  it('never upscales: 1080p of a 720p project stays native', () => {
    expect(resolveExportDimensions(1280, 720, '1080p')).toEqual({ width: 1280, height: 720 });
  });
});

describe('resolveExportSettings', () => {
  it('high tier carries the pre-picker transcode values (CRF 20, 192k audio)', () => {
    const resolved = resolveExportSettings(1920, 1080, { resolution: 'native', frameRate: 30, quality: 'high' });
    expect(resolved.crf).toBe(20);
    expect(resolved.audioBitsPerSecond).toBe(192_000);
    expect(resolved.frameRate).toBe(30);
    expect(resolved.width).toBe(1920);
    expect(resolved.height).toBe(1080);
  });

  it('video bitrate ladders down across tiers and with smaller outputs', () => {
    const high = resolveExportSettings(1920, 1080, { resolution: 'native', frameRate: 30, quality: 'high' });
    const medium = resolveExportSettings(1920, 1080, { resolution: 'native', frameRate: 30, quality: 'medium' });
    const low = resolveExportSettings(1920, 1080, { resolution: 'native', frameRate: 30, quality: 'low' });
    expect(high.videoBitsPerSecond).toBeGreaterThan(medium.videoBitsPerSecond);
    expect(medium.videoBitsPerSecond).toBeGreaterThan(low.videoBitsPerSecond);
    expect(medium.crf).toBeGreaterThan(high.crf);
    expect(low.crf).toBeGreaterThan(medium.crf);

    const small = resolveExportSettings(1920, 1080, { resolution: '480p', frameRate: 30, quality: 'high' });
    expect(small.videoBitsPerSecond).toBeLessThan(high.videoBitsPerSecond);
    expect(small.width).toBe(854);
    expect(small.height).toBe(480);
  });

  it('higher frame rates raise the video bitrate and pass the fps through', () => {
    const at30 = resolveExportSettings(1920, 1080, { resolution: 'native', frameRate: 30, quality: 'high' });
    const at60 = resolveExportSettings(1920, 1080, { resolution: 'native', frameRate: 60, quality: 'high' });
    expect(at60.frameRate).toBe(60);
    expect(at60.videoBitsPerSecond).toBeGreaterThan(at30.videoBitsPerSecond);
  });
});
