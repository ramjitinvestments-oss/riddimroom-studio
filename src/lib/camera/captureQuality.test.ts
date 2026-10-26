import { describe, it, expect } from 'vitest';
import {
  buildCaptureAttempts,
  dimensionsForShortSide,
  isLadderRetryableError,
  isPreviewMirrored,
  previewMirrorTransform,
  recorderBitratesForShortSide,
  recorderOptionsForTrackSettings,
  zoomCapabilityFromCapabilities,
} from './captureQuality';

function videoOf(attempt: ReturnType<typeof buildCaptureAttempts>[number]): MediaTrackConstraints {
  return attempt.constraints.video as MediaTrackConstraints;
}

describe('dimensionsForShortSide', () => {
  it('targets the short side and derives the long side from the project aspect', () => {
    expect(dimensionsForShortSide(1920, 1080, 1080)).toEqual({ width: 1920, height: 1080, ratio: 16 / 9 });
    expect(dimensionsForShortSide(1080, 1920, 2160)).toEqual({ width: 2160, height: 3840, ratio: 9 / 16 });
    expect(dimensionsForShortSide(1080, 1080, 1440)).toEqual({ width: 1440, height: 1440, ratio: 1 });
    expect(dimensionsForShortSide(1080, 1350, 1080)).toEqual({ width: 1080, height: 1350, ratio: 1080 / 1350 });
  });

  it('falls back to 9:16 for degenerate canvas dimensions', () => {
    expect(dimensionsForShortSide(0, 0, 1080).ratio).toBe(9 / 16);
  });
});

describe('buildCaptureAttempts (WS-P1 ladder)', () => {
  it('auto + 60fps ladders 2160 -> 1440 -> 1080 at 60, then backs off to 1080@30', () => {
    const attempts = buildCaptureAttempts({ canvasWidth: 1080, canvasHeight: 1920, facingMode: 'user', quality: 'auto', frameRate: 60 });
    expect(attempts.map((a) => [a.shortSide, a.frameRate])).toEqual([
      [2160, 60],
      [1440, 60],
      [1080, 60],
      [1080, 30],
    ]);
  });

  it('4k starts at 2160 just like auto', () => {
    const attempts = buildCaptureAttempts({ canvasWidth: 1920, canvasHeight: 1080, facingMode: 'environment', quality: '4k', frameRate: 30 });
    expect(attempts.map((a) => a.shortSide)).toEqual([2160, 1440, 1080]);
    expect(attempts.every((a) => a.frameRate === 30)).toBe(true);
  });

  it('hd pins the ladder to 1080 — it never asks above HD', () => {
    const attempts = buildCaptureAttempts({ canvasWidth: 1920, canvasHeight: 1080, facingMode: 'user', quality: 'hd', frameRate: 60 });
    expect(attempts.map((a) => [a.shortSide, a.frameRate])).toEqual([
      [1080, 60],
      [1080, 30],
    ]);
    const hd30 = buildCaptureAttempts({ canvasWidth: 1920, canvasHeight: 1080, facingMode: 'user', quality: 'hd', frameRate: 30 });
    expect(hd30).toHaveLength(1);
    expect(hd30[0].shortSide).toBe(1080);
  });

  it('the last rung is the flagged fallback: permissive ideal-1080 at 30fps in the project aspect', () => {
    const attempts = buildCaptureAttempts({ canvasWidth: 1080, canvasHeight: 1920, facingMode: 'user', quality: 'auto', frameRate: 60 });
    const last = attempts[attempts.length - 1];
    expect(last.isFallback).toBe(true);
    expect(attempts.slice(0, -1).every((a) => !a.isFallback)).toBe(true);
    const video = videoOf(last);
    expect(video.width).toEqual({ ideal: 1080 });
    expect(video.height).toEqual({ ideal: 1920 });
    expect(video.aspectRatio).toEqual({ ideal: 9 / 16 });
    expect(video.frameRate).toEqual({ ideal: 30 });
    expect(video.facingMode).toBe('user');
    expect(last.constraints.audio).toBe(true);
  });

  it('every rung uses ideal (never exact/min) constraints and carries the facing mode + audio', () => {
    const attempts = buildCaptureAttempts({ canvasWidth: 1920, canvasHeight: 1080, facingMode: 'environment', quality: 'auto', frameRate: 60 });
    for (const attempt of attempts) {
      const video = videoOf(attempt);
      expect(video.facingMode).toBe('environment');
      expect(attempt.constraints.audio).toBe(true);
      for (const key of ['width', 'height', 'aspectRatio', 'frameRate'] as const) {
        const constraint = video[key] as { ideal?: number };
        expect(typeof constraint.ideal).toBe('number');
      }
    }
    // First rung of a 16:9 project asks for 3840x2160.
    const first = videoOf(attempts[0]);
    expect(first.width).toEqual({ ideal: 3840 });
    expect(first.height).toEqual({ ideal: 2160 });
    expect(first.frameRate).toEqual({ ideal: 60 });
  });
});

describe('isLadderRetryableError', () => {
  it('retries only on OverconstrainedError / NotFoundError', () => {
    expect(isLadderRetryableError({ name: 'OverconstrainedError' })).toBe(true);
    expect(isLadderRetryableError({ name: 'NotFoundError' })).toBe(true);
    expect(isLadderRetryableError({ name: 'NotAllowedError' })).toBe(false);
    expect(isLadderRetryableError(new Error('boom'))).toBe(false);
    expect(isLadderRetryableError(null)).toBe(false);
  });
});

describe('recorder bitrate tiers (WS-P1)', () => {
  it('maps short side to 45 / 16 / 10 Mbps with 192k audio', () => {
    expect(recorderBitratesForShortSide(2160)).toEqual({ tier: 'uhd', videoBitsPerSecond: 45_000_000, audioBitsPerSecond: 192_000 });
    expect(recorderBitratesForShortSide(1441).videoBitsPerSecond).toBe(45_000_000);
    expect(recorderBitratesForShortSide(1440).videoBitsPerSecond).toBe(16_000_000);
    expect(recorderBitratesForShortSide(1081).videoBitsPerSecond).toBe(16_000_000);
    expect(recorderBitratesForShortSide(1080).videoBitsPerSecond).toBe(10_000_000);
    expect(recorderBitratesForShortSide(720).videoBitsPerSecond).toBe(10_000_000);
    expect(recorderBitratesForShortSide(0).videoBitsPerSecond).toBe(10_000_000);
  });

  it('derives the tier from the negotiated track settings short side (either orientation)', () => {
    expect(recorderOptionsForTrackSettings({ width: 3840, height: 2160 }).videoBitsPerSecond).toBe(45_000_000);
    expect(recorderOptionsForTrackSettings({ width: 1080, height: 1920 }).videoBitsPerSecond).toBe(10_000_000);
    expect(recorderOptionsForTrackSettings({ width: 2560, height: 1440 }).videoBitsPerSecond).toBe(16_000_000);
    expect(recorderOptionsForTrackSettings(null).videoBitsPerSecond).toBe(10_000_000);
    expect(recorderOptionsForTrackSettings(undefined).audioBitsPerSecond).toBe(192_000);
  });

  it('passes a preferred mimeType through and omits it when not given', () => {
    expect(recorderOptionsForTrackSettings({ width: 1920, height: 1080 }, 'video/webm;codecs=vp9,opus').mimeType).toBe('video/webm;codecs=vp9,opus');
    expect(recorderOptionsForTrackSettings({ width: 1920, height: 1080 }).mimeType).toBeUndefined();
  });
});

describe('preview mirror decision (WS-P2)', () => {
  it('mirrors the front (user) camera preview only', () => {
    expect(isPreviewMirrored('user')).toBe(true);
    expect(previewMirrorTransform('user')).toBe('scaleX(-1)');
  });

  it('never mirrors the back (environment) camera preview', () => {
    expect(isPreviewMirrored('environment')).toBe(false);
    expect(previewMirrorTransform('environment')).toBe('none');
  });
});

describe('zoomCapabilityFromCapabilities (WS-P4a)', () => {
  it('parses a well-formed zoom capability', () => {
    expect(zoomCapabilityFromCapabilities({ zoom: { min: 1, max: 8, step: 0.5 } })).toEqual({ min: 1, max: 8, step: 0.5 });
  });

  it('returns null when the track exposes no zoom (e.g. iOS Safari)', () => {
    expect(zoomCapabilityFromCapabilities({})).toBeNull();
    expect(zoomCapabilityFromCapabilities(null)).toBeNull();
    expect(zoomCapabilityFromCapabilities(undefined)).toBeNull();
    expect(zoomCapabilityFromCapabilities({ zoom: true })).toBeNull();
  });

  it('returns null for a degenerate range and defaults a missing step', () => {
    expect(zoomCapabilityFromCapabilities({ zoom: { min: 2, max: 2, step: 0.1 } })).toBeNull();
    expect(zoomCapabilityFromCapabilities({ zoom: { min: 1, max: 4 } })).toEqual({ min: 1, max: 4, step: 0.1 });
  });
});
