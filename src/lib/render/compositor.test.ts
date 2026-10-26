import { describe, it, expect } from 'vitest';
import { computeAudioGainAtTime, computeFadeOpacity, computeLoopedSourceTime, croppedCoverSourceRect, coverSourceRect, effectiveAudioEndTime, framingSlackPx, hasActiveFraming, interpolateTransform, pipBoxPx, resolveCropOffset, resolveCropZoom } from './compositor';
import type { Transform } from '../../types/timeline';

/**
 * "Universal 30-second media standard" focused tests — spec item 9 ("Add
 * focused tests for: fade clamping"). `computeFadeOpacity` is the single
 * shared function driving both visual opacity fades (video/image/text) AND
 * audio gain fades (standalone AudioTimelineItem, and — after this same
 * pass's fix — a video's own embedded audio in both PreviewPane.tsx and
 * canvas2dRenderer.ts), so these tests exercise the pure math once rather
 * than duplicating it per call site. `sinceStart + untilEnd` always equals
 * the item's own duration in real call sites (see the function's own doc
 * comment for why), so tests below construct that relationship explicitly.
 */

describe('computeFadeOpacity — clamped to min(3s, clip duration)', () => {
  it('returns full opacity when no fade is configured', () => {
    expect(computeFadeOpacity(undefined, 5, 5)).toBe(1);
  });

  it('ramps in normally when the configured fade is within both caps', () => {
    // 10s clip, 1s in, 2s fade-in configured -> half-way through the ramp.
    const opacity = computeFadeOpacity({ fadeInDuration: 2, fadeOutDuration: 0 }, 1, 9);
    expect(opacity).toBeCloseTo(0.5, 5);
  });

  it('reaches full opacity by the END of a short clip even if the configured fade-in is longer than the clip (the original bug)', () => {
    // 2s clip, fade-in configured at 5s (exceeds both MAX_FADE_SECONDS=3 and
    // the clip's own 2s length). Before this fix, an unclamped ramp would
    // give sinceStart/fadeInDuration = 2/5 = 0.4 at the very end of the clip
    // — i.e. the clip would NEVER reach full volume/opacity, even briefly.
    const opacity = computeFadeOpacity({ fadeInDuration: 5, fadeOutDuration: 0 }, 2, 0);
    expect(opacity).toBeCloseTo(1, 5);
  });

  it('clamps the effective fade duration to MAX_FADE_SECONDS (3s) even on a long clip', () => {
    // 20s clip, fade-in configured at 10s. Effective cap is min(10, 3, 20) = 3s,
    // so by sinceStart=3 the ramp should already be complete (opacity 1),
    // not 3/10 = 0.3 as an unclamped 10s ramp would give.
    const opacity = computeFadeOpacity({ fadeInDuration: 10, fadeOutDuration: 0 }, 3, 17);
    expect(opacity).toBeCloseTo(1, 5);
  });

  it('applies the fade-OUT ramp with the same clamping, symmetrically', () => {
    // 20s clip, 1s from the end, fade-out configured at 10s.
    // Effective cap is min(10, 3, 20) = 3s, so opacity should be 1/3, not 1/10.
    const opacity = computeFadeOpacity({ fadeInDuration: 0, fadeOutDuration: 10 }, 19, 1);
    expect(opacity).toBeCloseTo(1 / 3, 5);
  });

  it('never returns a negative or >1 opacity for pathological (e.g. negative) fade values', () => {
    const opacity = computeFadeOpacity({ fadeInDuration: -5, fadeOutDuration: -5 }, 1, 1);
    expect(opacity).toBeGreaterThanOrEqual(0);
    expect(opacity).toBeLessThanOrEqual(1);
  });
});

describe('interpolateTransform — keyframe-lite (Phase 2.3)', () => {
  const base: Transform = { position: { x: 20, y: 30 }, scale: 1, rotation: 15, opacity: 1 };

  it('returns the base transform itself when no end transform is set', () => {
    expect(interpolateTransform(base, undefined, 0.5)).toBe(base);
  });

  it('hits the base at progress 0 and the end state at progress 1', () => {
    const end = { position: { x: 80, y: 70 }, scale: 2, opacity: 0.4 };
    const atStart = interpolateTransform(base, end, 0);
    expect(atStart.position).toEqual({ x: 20, y: 30 });
    expect(atStart.scale).toBe(1);
    expect(atStart.opacity).toBe(1);
    const atEnd = interpolateTransform(base, end, 1);
    expect(atEnd.position).toEqual({ x: 80, y: 70 });
    expect(atEnd.scale).toBe(2);
    expect(atEnd.opacity).toBeCloseTo(0.4, 5);
  });

  it('lerps linearly at the midpoint and holds base rotation throughout', () => {
    const end = { position: { x: 80, y: 70 }, scale: 2, opacity: 0.4 };
    const mid = interpolateTransform(base, end, 0.5);
    expect(mid.position).toEqual({ x: 50, y: 50 });
    expect(mid.scale).toBeCloseTo(1.5, 5);
    expect(mid.opacity).toBeCloseTo(0.7, 5);
    expect(mid.rotation).toBe(15);
  });

  it('eased mode is smoothstep: slower than linear early, and clamps out-of-range progress', () => {
    const end = { position: { x: 80, y: 70 }, scale: 2, opacity: 0.4, eased: true };
    const quarter = interpolateTransform(base, end, 0.25);
    // smoothstep(0.25) = 0.15625 < 0.25
    expect(quarter.position.x).toBeCloseTo(20 + 60 * 0.15625, 5);
    expect(interpolateTransform(base, end, 2).position).toEqual({ x: 80, y: 70 });
    expect(interpolateTransform(base, end, -1).position).toEqual({ x: 20, y: 30 });
  });
});

describe('computeLoopedSourceTime — looping audio wraps inside its trim window', () => {
  // Trim window [2, 10) — an 8s span of source.
  it('matches the plain play-once mapping within the first pass', () => {
    expect(computeLoopedSourceTime(2, 10, 0)).toBe(2);
    expect(computeLoopedSourceTime(2, 10, 3.5)).toBeCloseTo(5.5, 5);
    expect(computeLoopedSourceTime(2, 10, 7.999)).toBeCloseTo(9.999, 5);
  });

  it('wraps back to trimStart at each span boundary', () => {
    expect(computeLoopedSourceTime(2, 10, 8)).toBe(2);
    expect(computeLoopedSourceTime(2, 10, 16)).toBe(2);
    expect(computeLoopedSourceTime(2, 10, 20)).toBeCloseTo(6, 5); // 2 full loops + 4s
  });

  it('never returns a position outside the trim window, however far playback runs', () => {
    for (const elapsed of [0, 1, 8, 9.5, 40, 123.456, 10_000]) {
      const pos = computeLoopedSourceTime(2, 10, elapsed);
      expect(pos).toBeGreaterThanOrEqual(2);
      expect(pos).toBeLessThan(10);
    }
  });

  it('degenerate windows and negative elapsed fall back to a sane position', () => {
    expect(computeLoopedSourceTime(4, 4, 3)).toBe(7); // zero span: no wrap possible
    expect(computeLoopedSourceTime(2, 10, -5)).toBe(2); // before the item starts: its head
  });
});

describe('croppedCoverSourceRect (item.crop is honored by the renderer)', () => {
  it('no crop = the plain cover-fit', async () => {
    const { croppedCoverSourceRect, coverSourceRect } = await import('./compositor');
    expect(croppedCoverSourceRect(1920, 1080, 1080, 1920)).toEqual(coverSourceRect(1920, 1080, 1080, 1920));
  });
  it('cover-fits INSIDE the crop window', async () => {
    const { croppedCoverSourceRect } = await import('./compositor');
    // right half of a square source (a 1:2 window) into a square box:
    // cover-fit crops the window top/bottom, centred — never stretches
    expect(croppedCoverSourceRect(1000, 1000, 500, 500, { x: 50, y: 0, width: 50, height: 100 }))
      .toEqual({ sx: 500, sy: 250, sw: 500, sh: 500 });
    // full-width top band of a tall source into a wide box
    expect(croppedCoverSourceRect(1080, 1920, 1920, 1080, { x: 0, y: 10, width: 100, height: 30 }))
      .toEqual({ sx: 28, sy: 192, sw: 1024, sh: 576 });
  });
});

describe('R24 framing resolvers — identity defaults reproduce the old rendering', () => {
  it('zoom resolves to 1 when absent/invalid/below range and clamps at 3', () => {
    expect(resolveCropZoom(undefined)).toBe(1);
    expect(resolveCropZoom(Number.NaN)).toBe(1);
    expect(resolveCropZoom(0.25)).toBe(1);
    expect(resolveCropZoom(2)).toBe(2);
    expect(resolveCropZoom(99)).toBe(3);
  });
  it('offsets resolve to 0 when absent/invalid and clamp to -1..1', () => {
    expect(resolveCropOffset(undefined)).toBe(0);
    expect(resolveCropOffset(Number.NaN)).toBe(0);
    expect(resolveCropOffset(0.5)).toBe(0.5);
    expect(resolveCropOffset(7)).toBe(1);
    expect(resolveCropOffset(-7)).toBe(-1);
  });
  it('zoom 1 + centred pan (or no framing at all) is NOT active framing', () => {
    expect(hasActiveFraming(undefined)).toBe(false);
    expect(hasActiveFraming({})).toBe(false);
    expect(hasActiveFraming({ cropZoom: 1, cropOffsetX: 0, cropOffsetY: 0 })).toBe(false);
    expect(hasActiveFraming({ cropZoom: 1.5 })).toBe(true);
    expect(hasActiveFraming({ cropOffsetX: -0.2 })).toBe(true);
  });
});

describe('R24 croppedCoverSourceRect — crop-zoom / pan geometry', () => {
  it('zoom-1 identity: explicit identity framing returns the exact base rect', () => {
    const cases: Array<[number, number, number, number, { x: number; y: number; width: number; height: number } | undefined]> = [
      [1920, 1080, 1080, 1920, undefined],
      [1920, 1080, 500, 500, undefined],
      [1000, 1000, 500, 500, { x: 50, y: 0, width: 50, height: 100 }],
      [1080, 1920, 1920, 1080, { x: 0, y: 10, width: 100, height: 30 }],
    ];
    for (const [sw, sh, dw, dh, crop] of cases) {
      const base = croppedCoverSourceRect(sw, sh, dw, dh, crop);
      expect(croppedCoverSourceRect(sw, sh, dw, dh, crop, { cropZoom: 1, cropOffsetX: 0, cropOffsetY: 0 })).toEqual(base);
      expect(croppedCoverSourceRect(sw, sh, dw, dh, crop, {})).toEqual(base);
    }
  });

  it('zoom 2 centred shrinks the cover window around its centre, aspect preserved', () => {
    // 16:9 source into a square box: base cover = centred 1080×1080 at sx 420.
    const r = croppedCoverSourceRect(1920, 1080, 500, 500, undefined, { cropZoom: 2 });
    expect(r).toEqual({ sx: 690, sy: 270, sw: 540, sh: 540 });
  });

  it('pan at zoom 1 slides across exactly the cover-fit slack, and only on the slack axis', () => {
    const right = croppedCoverSourceRect(1920, 1080, 500, 500, undefined, { cropOffsetX: 1, cropOffsetY: 1 });
    expect(right.sx + right.sw).toBe(1920); // pinned to the right edge
    expect(right.sy).toBe(0); // no vertical slack at zoom 1 — offset ignored there
    const left = croppedCoverSourceRect(1920, 1080, 500, 500, undefined, { cropOffsetX: -1 });
    expect(left.sx).toBe(0);
    // Tall source into a wide box: the slack is vertical instead.
    const bottom = croppedCoverSourceRect(1080, 1920, 1920, 1080, undefined, { cropOffsetX: 1, cropOffsetY: 1 });
    expect(bottom.sy + bottom.sh).toBe(1920);
    expect(bottom.sx).toBe(0);
  });

  it('zooming keeps a panned edge pinned (zoom around the current pan position)', () => {
    for (const zoom of [1, 1.5, 2, 3]) {
      const r = croppedCoverSourceRect(1920, 1080, 500, 500, undefined, { cropZoom: zoom, cropOffsetX: 1 });
      expect(r.sx + r.sw).toBeCloseTo(1920, 6);
      const l = croppedCoverSourceRect(1920, 1080, 500, 500, undefined, { cropZoom: zoom, cropOffsetX: -1 });
      expect(l.sx).toBeCloseTo(0, 6);
    }
  });

  it('the window never leaves the source bounds at any zoom/pan corner', () => {
    const sources: Array<[number, number]> = [[1920, 1080], [1080, 1920], [1000, 1000], [640, 480]];
    const dests: Array<[number, number]> = [[500, 500], [1080, 1920], [1920, 1080], [345, 614]];
    for (const [sw, sh] of sources) {
      for (const [dw, dh] of dests) {
        for (const zoom of [1, 1.25, 2, 3]) {
          for (const ox of [-1, 0, 1]) {
            for (const oy of [-1, 0, 1]) {
              const r = croppedCoverSourceRect(sw, sh, dw, dh, undefined, { cropZoom: zoom, cropOffsetX: ox, cropOffsetY: oy });
              expect(r.sx).toBeGreaterThanOrEqual(-1e-6);
              expect(r.sy).toBeGreaterThanOrEqual(-1e-6);
              expect(r.sx + r.sw).toBeLessThanOrEqual(sw + 1e-6);
              expect(r.sy + r.sh).toBeLessThanOrEqual(sh + 1e-6);
              expect(r.sw).toBeGreaterThan(0);
              expect(r.sh).toBeGreaterThan(0);
              // The window always carries the destination aspect (no distortion).
              expect(r.sw / r.sh).toBeCloseTo(dw / dh, 6);
            }
          }
        }
      }
    }
  });

  it('the window never leaves the item crop window either (a preset crop is not violated)', () => {
    const crop = { x: 10, y: 10, width: 50, height: 50 }; // 100..600 px on a 1000×1000 source
    for (const zoom of [1, 2, 3]) {
      for (const ox of [-1, 1]) {
        for (const oy of [-1, 1]) {
          const r = croppedCoverSourceRect(1000, 1000, 500, 500, crop, { cropZoom: zoom, cropOffsetX: ox, cropOffsetY: oy });
          expect(r.sx).toBeGreaterThanOrEqual(100 - 1e-6);
          expect(r.sy).toBeGreaterThanOrEqual(100 - 1e-6);
          expect(r.sx + r.sw).toBeLessThanOrEqual(600 + 1e-6);
          expect(r.sy + r.sh).toBeLessThanOrEqual(600 + 1e-6);
        }
      }
    }
  });

  it('out-of-range stored values are clamped, not honoured literally', () => {
    const r = croppedCoverSourceRect(1920, 1080, 500, 500, undefined, { cropZoom: 99, cropOffsetX: 42, cropOffsetY: -42 });
    expect(r.sw).toBeCloseTo(1080 / 3, 6);
    expect(r.sx + r.sw).toBeCloseTo(1920, 6);
    expect(r.sy).toBeCloseTo(0, 6);
  });

  it('framingSlackPx reports per-axis room to pan (what the PiP panel gates its sliders on)', () => {
    // Landscape into square at zoom 1: horizontal slack only.
    expect(framingSlackPx(1920, 1080, 500, 500)).toEqual({ x: 840, y: 0 });
    // Zooming in creates slack on BOTH axes.
    expect(framingSlackPx(1920, 1080, 500, 500, undefined, 2)).toEqual({ x: 1380, y: 540 });
    // Source aspect == box aspect at zoom 1: no slack anywhere.
    expect(framingSlackPx(1920, 1080, 1920, 1080)).toEqual({ x: 0, y: 0 });
  });
});

/**
 * R26 WS-A1 verification + WS-A2 render half — `computeAudioGainAtTime`
 * is the shared gain computation both exporters use per frame (and the
 * formula the preview's gain lines mirror). These tests prove the fade
 * fields are honoured as gain curves: 0 at the fade boundaries, full
 * level inside, and the Promo-style default (fadeIn 0, fadeOut 2)
 * rendering its full 2s ramp — plus the main-track boundary clip.
 */
describe('R26 computeAudioGainAtTime — WS-A1 fade gain curves', () => {
  const promoMusic = {
    startTime: 0, endTime: 12, volume: 0.8, muted: false,
    fade: { fadeInDuration: 0, fadeOutDuration: 2 },
  };

  it('Promo-style item (fadeIn 0, fadeOut 2): full level inside, 2s ramp at the end, 0 at the end boundary', () => {
    expect(computeAudioGainAtTime(promoMusic, 0, null)).toBeCloseTo(0.8, 5); // no fade-in: full from the first instant
    expect(computeAudioGainAtTime(promoMusic, 5, null)).toBeCloseTo(0.8, 5); // full level inside
    expect(computeAudioGainAtTime(promoMusic, 10, null)).toBeCloseTo(0.8, 5); // ramp starts exactly 2s before the end
    expect(computeAudioGainAtTime(promoMusic, 11, null)).toBeCloseTo(0.4, 5); // halfway down the 2s ramp
    expect(computeAudioGainAtTime(promoMusic, 11.5, null)).toBeCloseTo(0.2, 5);
    // At the item's end boundary the gain is 0 (window is half-open)…
    expect(computeAudioGainAtTime(promoMusic, 12, null)).toBe(0);
    // …and the underlying ramp itself reaches exactly 0 at the boundary point.
    expect(computeFadeOpacity(promoMusic.fade, 12, 0)).toBe(0);
  });

  it('fade-in curve: 0 at the start boundary, ramping to full level at fadeInDuration', () => {
    const item = { startTime: 2, endTime: 14, volume: 1, muted: false, fade: { fadeInDuration: 3, fadeOutDuration: 0 } };
    expect(computeAudioGainAtTime(item, 2, null)).toBe(0);
    expect(computeAudioGainAtTime(item, 3.5, null)).toBeCloseTo(0.5, 5);
    expect(computeAudioGainAtTime(item, 5, null)).toBeCloseTo(1, 5);
    expect(computeAudioGainAtTime(item, 10, null)).toBeCloseTo(1, 5);
  });

  it('no fade configured: flat volume across the whole window, 0 outside it', () => {
    const item = { startTime: 1, endTime: 6, volume: 0.6, muted: false, fade: { fadeInDuration: 0, fadeOutDuration: 0 } };
    expect(computeAudioGainAtTime(item, 0.5, null)).toBe(0);
    expect(computeAudioGainAtTime(item, 1, null)).toBeCloseTo(0.6, 5);
    expect(computeAudioGainAtTime(item, 5.999, null)).toBeCloseTo(0.6, 5);
    expect(computeAudioGainAtTime(item, 6, null)).toBe(0);
  });

  it('muted items contribute nothing at any time', () => {
    const item = { startTime: 0, endTime: 10, volume: 1, muted: true, fade: { fadeInDuration: 0, fadeOutDuration: 0 } };
    expect(computeAudioGainAtTime(item, 5, null)).toBe(0);
  });

  it('with no boundary (null), the gain equals the pre-R26 formula everywhere', () => {
    const item = { startTime: 1, endTime: 9, volume: 0.7, muted: false, fade: { fadeInDuration: 1, fadeOutDuration: 2 } };
    for (const t of [0, 1, 1.5, 2, 5, 7, 8, 8.5, 9, 10]) {
      const legacy = t >= item.startTime && t < item.endTime
        ? item.volume * computeFadeOpacity(item.fade, t - item.startTime, item.endTime - t)
        : 0;
      expect(computeAudioGainAtTime(item, t, null)).toBeCloseTo(legacy, 10);
    }
  });
});

describe('R26 computeAudioGainAtTime — WS-A2 main-track boundary clip', () => {
  const longMusic = {
    startTime: 0, endTime: 180, volume: 1, muted: false,
    fade: { fadeInDuration: 0, fadeOutDuration: 2 },
  };

  it('effectiveAudioEndTime: null/non-finite boundary = no clip; a real boundary takes the min', () => {
    expect(effectiveAudioEndTime(180, null)).toBe(180);
    expect(effectiveAudioEndTime(180, undefined)).toBe(180);
    expect(effectiveAudioEndTime(180, Number.NaN)).toBe(180);
    expect(effectiveAudioEndTime(180, 12)).toBe(12);
    expect(effectiveAudioEndTime(8, 12)).toBe(8); // boundary past the item's own end changes nothing
  });

  it('a 3-minute song under a 12s main video contributes NOTHING at or past 12s', () => {
    expect(computeAudioGainAtTime(longMusic, 11.999, 12)).toBeGreaterThan(0);
    expect(computeAudioGainAtTime(longMusic, 12, 12)).toBe(0);
    expect(computeAudioGainAtTime(longMusic, 60, 12)).toBe(0);
    expect(computeAudioGainAtTime(longMusic, 179.999, 12)).toBe(0);
  });

  it('the fade-out ramp re-anchors to the boundary: the 2s ramp lands ON 12s, not mid-ramp at 180s', () => {
    expect(computeAudioGainAtTime(longMusic, 10, 12)).toBeCloseTo(1, 5); // ramp starts at boundary − 2s
    expect(computeAudioGainAtTime(longMusic, 11, 12)).toBeCloseTo(0.5, 5);
    expect(computeAudioGainAtTime(longMusic, 11.999, 12)).toBeLessThan(0.01);
  });

  it('an item entirely past the boundary is silent everywhere; an item ending before it is untouched', () => {
    const late = { startTime: 20, endTime: 30, volume: 1, muted: false, fade: { fadeInDuration: 0, fadeOutDuration: 0 } };
    expect(computeAudioGainAtTime(late, 25, 12)).toBe(0);
    const early = { startTime: 0, endTime: 8, volume: 0.5, muted: false, fade: { fadeInDuration: 0, fadeOutDuration: 0 } };
    expect(computeAudioGainAtTime(early, 4, 12)).toBeCloseTo(0.5, 5);
    expect(computeAudioGainAtTime(early, 8, 12)).toBe(0); // its own end still applies
  });

  it('the boundary does not modify the stored item (render-time clamp only)', () => {
    const item = { ...longMusic, fade: { ...longMusic.fade } };
    computeAudioGainAtTime(item, 100, 12);
    expect(item.endTime).toBe(180);
    expect(item.fade).toEqual({ fadeInDuration: 0, fadeOutDuration: 2 });
  });
});

describe('R24 pipBoxPx — source-fit PiP box', () => {
  it('legacy PiPs (no fit) keep the canvas-aspect box', () => {
    expect(pipBoxPx(0.32, 1920, 1080, { shape: 'rounded' }, 720, 1280)).toEqual({ w: 614.4, h: 345.6 });
    expect(pipBoxPx(0.32, 1920, 1080, undefined, 720, 1280)).toEqual({ w: 614.4, h: 345.6 });
  });
  it('source fit: height follows the source aspect at the same width (whole frame visible)', () => {
    const box = pipBoxPx(0.32, 1920, 1080, { shape: 'rounded', fit: 'source' }, 720, 1280);
    expect(box.w).toBeCloseTo(614.4, 6);
    expect(box.h).toBeCloseTo((614.4 * 1280) / 720, 6);
    expect(box.w / box.h).toBeCloseTo(720 / 1280, 6);
  });
  it('the circle keeps the legacy box even with source fit (its square crops by design)', () => {
    expect(pipBoxPx(0.32, 1920, 1080, { shape: 'circle', fit: 'source' }, 720, 1280)).toEqual({ w: 614.4, h: 345.6 });
  });
  it('falls back to the legacy box until the source has decoded dimensions', () => {
    expect(pipBoxPx(0.32, 1920, 1080, { shape: 'rounded', fit: 'source' }, 0, 0)).toEqual({ w: 614.4, h: 345.6 });
  });
});

/**
 * R24 flip render tests — `drawFrame` against a recording fake 2D
 * context (the repo's render tests are pure/node, no DOM canvas): the
 * flip must appear as a -1 x-scale transform around the media draw,
 * and must NOT appear for un-flipped items.
 */
function makeRecordingCtx() {
  const scaleCalls: Array<[number, number]> = [];
  const drawImageCalls: unknown[][] = [];
  const gradient = { addColorStop: () => {} };
  const ctx: Record<string, unknown> = {
    globalAlpha: 1,
    filter: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetY: 0,
    globalCompositeOperation: 'source-over',
    save: () => {},
    restore: () => {},
    clearRect: () => {},
    fillRect: () => {},
    fill: () => {},
    stroke: () => {},
    beginPath: () => {},
    clip: () => {},
    arc: () => {},
    rect: () => {},
    roundRect: () => {},
    fillText: () => {},
    translate: () => {},
    rotate: () => {},
    transform: () => {},
    scale: (x: number, y: number) => {
      scaleCalls.push([x, y]);
    },
    measureText: (t: string) => ({ width: t.length * 6 }),
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    drawImage: (...args: unknown[]) => {
      drawImageCalls.push(args);
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, scaleCalls, drawImageCalls };
}

describe('R24 drawFrame — Flip mirrors the media draw transform', () => {
  it('a flipped PiP video draws with a -1 x-scale; an un-flipped one never does', async () => {
    const { drawFrame } = await import('./compositor');
    const { createDefaultProject } = await import('../projects/persistence');
    const { addPipOverlay } = await import('../pip');
    const asset = {
      id: 'flip-vid', kind: 'video' as const, fileName: 'head.mp4', mimeType: 'video/mp4',
      storageUrl: 'https://example.com/v.mp4', sizeBytes: 1, durationSeconds: 10, width: 1280, height: 720, createdAt: 1,
    };
    const videoEl = { videoWidth: 1280, videoHeight: 720 } as unknown as HTMLVideoElement;

    const plain = addPipOverlay(createDefaultProject('uid-1'), asset, {});
    const plainRec = makeRecordingCtx();
    drawFrame(plainRec.ctx, plain, 1, { images: new Map(), videos: new Map([[asset.id, videoEl]]) });
    expect(plainRec.drawImageCalls.length).toBeGreaterThan(0);
    expect(plainRec.scaleCalls.some(([x]) => x === -1)).toBe(false);

    const flippedProject = addPipOverlay(createDefaultProject('uid-1'), asset, {});
    const pipItem = flippedProject.items.find((i) => i.type === 'video');
    if (!pipItem || pipItem.type !== 'video') throw new Error('expected a PiP video item');
    pipItem.flipX = true;
    const flipRec = makeRecordingCtx();
    drawFrame(flipRec.ctx, flippedProject, 1, { images: new Map(), videos: new Map([[asset.id, videoEl]]) });
    expect(flipRec.drawImageCalls.length).toBeGreaterThan(0);
    expect(flipRec.scaleCalls).toContainEqual([-1, 1]);
  });

  it('a flipped image item draws with a -1 x-scale too', async () => {
    const { drawFrame } = await import('./compositor');
    const { createDefaultProject } = await import('../projects/persistence');
    const { appendMediaToTimeline } = await import('../timeline/insert');
    const asset = {
      id: 'flip-img', kind: 'image' as const, fileName: 'photo.jpg', mimeType: 'image/jpeg',
      storageUrl: 'https://example.com/p.jpg', sizeBytes: 1, width: 400, height: 300, createdAt: 1,
    };
    const imgEl = { complete: true, naturalWidth: 400, naturalHeight: 300 } as unknown as HTMLImageElement;
    const project = appendMediaToTimeline(createDefaultProject('uid-1'), asset, {});
    const imgItem = project.items.find((i) => i.type === 'image');
    if (!imgItem || imgItem.type !== 'image') throw new Error('expected an image item');
    imgItem.flipX = true;
    const rec = makeRecordingCtx();
    drawFrame(rec.ctx, project, 0.5, { images: new Map([[asset.id, imgEl]]), videos: new Map() });
    expect(rec.drawImageCalls.length).toBeGreaterThan(0);
    expect(rec.scaleCalls).toContainEqual([-1, 1]);
  });
});
