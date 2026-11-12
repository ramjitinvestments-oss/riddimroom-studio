/**
 * R44 Phase A — the S4 parity gate (AUDIT-R43 §3.2 SF-1, D5a as
 * reconfirmed in the owner's R44 GO).
 *
 * THE GATE: the live preview may only cap its canvas backing store at
 * display size × DPR if the composited frame at display scale is the
 * SAME picture as the full-resolution composite — same draw calls, in
 * the same order, with the same content arguments and the same style
 * state, and every effective transform exactly the full-res transform
 * scaled by the display ratio (geometry parity). This file proves it
 * the way the repo's other render tests do: `drawFrame` against a
 * recording fake 2D context, once at identity (the export geometry)
 * and once behind the pane's display-scale transform, compared call
 * by call.
 *
 * Also pinned here: the backing-size math (display × DPR, never above
 * project resolution, aspect-safe) and the idle-skip draw decision
 * (SF-2) + media signature that PreviewPane's loop consults.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { drawFrame, setStaticLayerCacheEnabled } from './compositor';
import { mediaFrameSignature, previewBackingSize, previewDrawDecision } from './previewScale';
import { createDefaultProject } from '../projects/persistence';
import { appendMediaToTimeline, addTextItem } from '../timeline/insert';
import { addPipOverlay } from '../pip';
import { addItem, generateTimelineId, getTracksByType } from '../timeline/utils';
import type { CaptionTimelineItem, Project } from '../../types/timeline';

type Mat = [number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function multiply(m1: Mat, m2: Mat): Mat {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

interface RecordedCall {
  method: string;
  args: unknown[];
  matrix: Mat;
  props: Record<string, unknown>;
}

const PROP_NAMES = [
  'globalAlpha', 'globalCompositeOperation', 'fillStyle', 'strokeStyle', 'lineWidth',
  'lineCap', 'lineJoin', 'font', 'textAlign', 'textBaseline', 'filter',
  'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY', 'imageSmoothingEnabled',
] as const;

/** A fake 2D context that tracks a REAL affine matrix stack, so a
 * scaled run's effective geometry can be compared against the
 * full-res run's, transform for transform. Style properties are
 * stored in a plain bag and snapshotted at every call. */
class ParityCtx {
  calls: RecordedCall[] = [];
  private matrix: Mat = [...IDENTITY];
  private stack: Mat[] = [];
  private props: Record<string, unknown> = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '#000', strokeStyle: '#000',
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', font: '10px sans-serif', textAlign: 'start',
    textBaseline: 'alphabetic', filter: 'none', shadowColor: 'rgba(0, 0, 0, 0)', shadowBlur: 0,
    shadowOffsetX: 0, shadowOffsetY: 0, imageSmoothingEnabled: true,
  };

  constructor() {
    for (const name of PROP_NAMES) {
      Object.defineProperty(this, name, {
        get: () => this.props[name],
        set: (v: unknown) => {
          this.props[name] = v;
        },
      });
    }
  }

  private rec(method: string, args: unknown[]) {
    this.calls.push({ method, args, matrix: [...this.matrix], props: { ...this.props } });
  }

  save() { this.stack.push([...this.matrix]); this.rec('save', []); }
  restore() { this.matrix = this.stack.pop() ?? [...IDENTITY]; this.rec('restore', []); }
  translate(x: number, y: number) { this.matrix = multiply(this.matrix, [1, 0, 0, 1, x, y]); this.rec('translate', [x, y]); }
  rotate(r: number) {
    const c = Math.cos(r);
    const s = Math.sin(r);
    this.matrix = multiply(this.matrix, [c, s, -s, c, 0, 0]);
    this.rec('rotate', [r]);
  }
  scale(x: number, y: number) { this.matrix = multiply(this.matrix, [x, 0, 0, y, 0, 0]); this.rec('scale', [x, y]); }
  transform(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.matrix = multiply(this.matrix, [a, b, c, d, e, f]);
    this.rec('transform', [a, b, c, d, e, f]);
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.matrix = [a, b, c, d, e, f];
    this.rec('setTransform', [a, b, c, d, e, f]);
  }
  clearRect(...a: number[]) { this.rec('clearRect', a); }
  fillRect(...a: number[]) { this.rec('fillRect', a); }
  strokeRect(...a: number[]) { this.rec('strokeRect', a); }
  fill() { this.rec('fill', []); }
  stroke() { this.rec('stroke', []); }
  beginPath() { this.rec('beginPath', []); }
  closePath() { this.rec('closePath', []); }
  moveTo(...a: number[]) { this.rec('moveTo', a); }
  lineTo(...a: number[]) { this.rec('lineTo', a); }
  bezierCurveTo(...a: number[]) { this.rec('bezierCurveTo', a); }
  quadraticCurveTo(...a: number[]) { this.rec('quadraticCurveTo', a); }
  clip() { this.rec('clip', []); }
  arc(...a: number[]) { this.rec('arc', a); }
  rect(...a: number[]) { this.rec('rect', a); }
  roundRect(...a: number[]) { this.rec('roundRect', a); }
  fillText(t: string, ...a: number[]) { this.rec('fillText', [t, ...a]); }
  strokeText(t: string, ...a: number[]) { this.rec('strokeText', [t, ...a]); }
  setLineDash(a: number[]) { this.rec('setLineDash', [a]); }
  measureText(t: string) { return { width: t.length * 6 }; }
  createLinearGradient(...a: number[]) {
    this.rec('createLinearGradient', a);
    return { __gradient: true, addColorStop: (o: number, c: string) => this.rec('gradStop', [o, c]) };
  }
  createRadialGradient(...a: number[]) {
    this.rec('createRadialGradient', a);
    return { __gradient: true, addColorStop: (o: number, c: string) => this.rec('gradStop', [o, c]) };
  }
  drawImage(src: unknown, ...rest: number[]) { this.rec('drawImage', [src, ...rest]); }
}

/** Args compare exactly, except gradient stubs (created per run) which
 * compare by kind, and media elements which compare by identity. */
function argsEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => {
    const w = b[i];
    if (typeof v === 'number' && typeof w === 'number') return v === w || (Number.isNaN(v) && Number.isNaN(w));
    if (v && w && typeof v === 'object' && typeof w === 'object') {
      const vg = (v as { __gradient?: boolean }).__gradient;
      const wg = (w as { __gradient?: boolean }).__gradient;
      if (vg && wg) return true;
      return v === w;
    }
    return v === w;
  });
}

function propsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return PROP_NAMES.every((name) => {
    const v = a[name];
    const w = b[name];
    if (v && w && typeof v === 'object' && typeof w === 'object') {
      return Boolean((v as { __gradient?: boolean }).__gradient) && Boolean((w as { __gradient?: boolean }).__gradient);
    }
    return v === w;
  });
}

function fixtureProject(): { project: Project; imgEl: HTMLImageElement; videoEl: HTMLVideoElement; imgAssetId: string; videoAssetId: string } {
  let p = createDefaultProject('parity-fixture');
  const imgAsset = {
    id: 'parity-img', kind: 'image' as const, fileName: 'photo.jpg', mimeType: 'image/jpeg',
    storageUrl: 'https://example.com/photo.jpg', sizeBytes: 1, width: 800, height: 600, createdAt: 1,
  };
  p = appendMediaToTimeline(p, imgAsset, {});
  const videoAsset = {
    id: 'parity-vid', kind: 'video' as const, fileName: 'clip.mp4', mimeType: 'video/mp4',
    storageUrl: 'https://example.com/clip.mp4', sizeBytes: 1, durationSeconds: 10, width: 1280, height: 720, createdAt: 1,
  };
  p = addPipOverlay(p, videoAsset, {});
  p = addTextItem(p, { text: 'Parity check', atTime: 0, durationSeconds: 5 });
  const captionTrack = getTracksByType(p, 'caption')[0];
  const caption: CaptionTimelineItem = {
    id: generateTimelineId('item'),
    type: 'caption',
    trackId: captionTrack.id,
    startTime: 0,
    endTime: 3,
    zIndex: 50,
    visible: true,
    words: [{ text: 'Hello world', start: 0, end: 3 }],
    captionStyleId: 'classic',
    source: 'manual',
    editable: true,
  };
  p = addItem(p, caption);
  const imgEl = { complete: true, naturalWidth: 800, naturalHeight: 600 } as unknown as HTMLImageElement;
  const videoEl = { videoWidth: 1280, videoHeight: 720 } as unknown as HTMLVideoElement;
  return { project: p, imgEl, videoEl, imgAssetId: imgAsset.id, videoAssetId: videoAsset.id };
}

describe('R44 SF-1 parity gate — display-scale composite === full-res composite', () => {
  beforeAll(() => {
    // The static-layer cache pre-renders at project resolution through
    // its own canvas factory; it is orthogonal to the scale route (the
    // cached layer is composited at 0,0 in project space, which the
    // display transform maps proportionally). Disabled here so the op
    // stream under comparison is drawFrame's own, uninterrupted.
    setStaticLayerCacheEnabled(false);
  });
  afterAll(() => {
    setStaticLayerCacheEnabled(true);
  });

  it('every draw call matches: same order, same content args, same styles, transforms scaled by exactly the ratio', () => {
    const { project, imgEl, videoEl, imgAssetId, videoAssetId } = fixtureProject();
    const assets = { images: new Map([[imgAssetId, imgEl]]), videos: new Map([[videoAssetId, videoEl]]) };

    const full = new ParityCtx();
    drawFrame(full as unknown as CanvasRenderingContext2D, project, 1, assets);
    expect(full.calls.length).toBeGreaterThan(20); // the fixture really drew a frame

    // The pane's route: backing = box × DPR (never above project res),
    // ctx transform = backing/project, then the identical drawFrame.
    const backing = previewBackingSize(360, 640, project.canvasWidth, project.canvasHeight, 2);
    const scaled = new ParityCtx();
    scaled.scale(backing.scaleX, backing.scaleY);
    drawFrame(scaled as unknown as CanvasRenderingContext2D, project, 1, assets);

    // Skip the pane's own opening scale call; everything after it is drawFrame's stream.
    const scaledCalls = scaled.calls.slice(1);
    expect(scaledCalls.length).toBe(full.calls.length);
    const s = backing.scaleX;
    expect(backing.scaleY).toBeCloseTo(s, 9);
    for (let i = 0; i < full.calls.length; i++) {
      const a = full.calls[i];
      const b = scaledCalls[i];
      expect(b.method, `call ${i} (${a.method})`).toBe(a.method);
      expect(argsEqual(a.args, b.args), `call ${i} (${a.method}) args`).toBe(true);
      expect(propsEqual(a.props, b.props), `call ${i} (${a.method}) props`).toBe(true);
      for (let k = 0; k < 6; k++) {
        const expected = a.matrix[k] * s;
        const tol = 1e-6 * Math.max(1, Math.abs(expected));
        expect(Math.abs(b.matrix[k] - expected), `call ${i} (${a.method}) matrix[${k}]`).toBeLessThanOrEqual(tol);
      }
    }
  });

  it('parity holds at a second, non-round scale (portrait phone box, DPR 3)', () => {
    const { project, imgEl, videoEl, imgAssetId, videoAssetId } = fixtureProject();
    const assets = { images: new Map([[imgAssetId, imgEl]]), videos: new Map([[videoAssetId, videoEl]]) };
    const full = new ParityCtx();
    drawFrame(full as unknown as CanvasRenderingContext2D, project, 0.5, assets);
    const backing = previewBackingSize(322, 571, project.canvasWidth, project.canvasHeight, 3);
    const scaled = new ParityCtx();
    scaled.scale(backing.scaleX, backing.scaleY);
    drawFrame(scaled as unknown as CanvasRenderingContext2D, project, 0.5, assets);
    const scaledCalls = scaled.calls.slice(1);
    expect(scaledCalls.length).toBe(full.calls.length);
    for (let i = 0; i < full.calls.length; i++) {
      expect(scaledCalls[i].method).toBe(full.calls[i].method);
      expect(argsEqual(full.calls[i].args, scaledCalls[i].args)).toBe(true);
    }
  });
});

describe('previewBackingSize — display × DPR, capped at project resolution', () => {
  it('a 4K project in a phone box at DPR 2 lands far below full res', () => {
    const b = previewBackingSize(360, 640, 2160, 3840, 2);
    expect(b.width).toBe(720);
    expect(b.height).toBe(1280);
    expect(b.scaleX).toBeCloseTo(1 / 3, 9);
    expect(b.scaleY).toBeCloseTo(1 / 3, 9);
  });

  it('never exceeds the project resolution, even in a huge box at high DPR', () => {
    const b = previewBackingSize(2000, 2000, 1080, 1080, 3);
    expect(b.width).toBeLessThanOrEqual(1080);
    expect(b.height).toBeLessThanOrEqual(1080);
  });

  it('a small project in a small box keeps a sane, aspect-true size', () => {
    const b = previewBackingSize(300, 300, 720, 720, 2);
    expect(b.width).toBe(600);
    expect(b.height).toBe(600);
    expect(b.scaleX).toBeCloseTo(b.scaleY, 9);
  });

  it('degenerate inputs stay finite and ≥1', () => {
    const b = previewBackingSize(0, 0, 1080, 1920, Number.NaN);
    expect(b.width).toBeGreaterThanOrEqual(1);
    expect(b.height).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(b.scaleX)).toBe(true);
  });
});

describe('previewDrawDecision — the idle skip (SF-2)', () => {
  const base = { isPlaying: false, hasDrawn: true, sizeChanged: false, projectChanged: false, timeChanged: false, mediaChanged: false };
  it('skips only the provably identical paused tick', () => {
    expect(previewDrawDecision(base)).toBe(false);
  });
  it('always draws while playing, on first frame, and on any change', () => {
    expect(previewDrawDecision({ ...base, isPlaying: true })).toBe(true);
    expect(previewDrawDecision({ ...base, hasDrawn: false })).toBe(true);
    expect(previewDrawDecision({ ...base, sizeChanged: true })).toBe(true);
    expect(previewDrawDecision({ ...base, projectChanged: true })).toBe(true);
    expect(previewDrawDecision({ ...base, timeChanged: true })).toBe(true);
    expect(previewDrawDecision({ ...base, mediaChanged: true })).toBe(true);
  });
});

describe('mediaFrameSignature', () => {
  it('moves when an element settles (position or readiness) and when an image lands', () => {
    const video = { currentTime: 1.25, readyState: 2 };
    const img = { complete: false, naturalWidth: 0 };
    const before = mediaFrameSignature(new Map([['a', video]]), new Map([['i', img]]));
    video.readyState = 4;
    const afterReady = mediaFrameSignature(new Map([['a', video]]), new Map([['i', img]]));
    expect(afterReady).not.toBe(before);
    img.complete = true;
    img.naturalWidth = 800;
    expect(mediaFrameSignature(new Map([['a', video]]), new Map([['i', img]]))).not.toBe(afterReady);
    // Stable when nothing moved.
    expect(mediaFrameSignature(new Map([['a', video]]), new Map([['i', img]]))).toBe(
      mediaFrameSignature(new Map([['a', video]]), new Map([['i', img]])),
    );
  });
});
