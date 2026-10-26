import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  drawFrame,
  isStaticLayerCacheEligible,
  setStaticLayerCacheEnabled,
  setStaticLayerCanvasFactory,
  clearStaticLayerCache,
} from './compositor';
import type { ImageTimelineItem, Project } from '../../types/timeline';

/**
 * R26 WS-S2 — static-layer cache tests, including the HARD GATE:
 * frame-hash equality with the cache ON vs OFF.
 *
 * The test env has no real Canvas, so — exactly like the repo's other
 * render tests (see the recording fake in compositor.test.ts) — the
 * "frame" here is the recorded draw-op stream of a fake 2D context,
 * and the hash input is that stream. A cached layer's op stream is
 * recorded on its own fake canvas; when the main context composites
 * it (`drawImage(canvas, 0, 0)`), the hash EXPANDS that op into the
 * cached canvas's own op stream — the fake-world equivalent of the
 * layer's pixels — so cache-on and cache-off hashes are comparable
 * byte for byte. If the cache changed ANY draw call, argument, or
 * ordering, the expanded streams differ and the gate fails.
 */

function fmt(n: unknown): string {
  return typeof n === 'number' ? Number(n.toFixed(4)).toString() : String(n);
}

class FakeCanvas {
  readonly ctx: RecordingCtx;
  constructor(
    public width: number,
    public height: number,
    public id: number,
  ) {
    this.ctx = new RecordingCtx(this);
  }
  getContext(): RecordingCtx {
    return this.ctx;
  }
}

const RECORDED_PROPS = [
  'globalAlpha', 'filter', 'fillStyle', 'strokeStyle', 'font', 'textAlign', 'textBaseline',
  'lineWidth', 'globalCompositeOperation', 'shadowColor', 'shadowBlur', 'shadowOffsetX', 'shadowOffsetY',
] as const;

class RecordingCtx {
  ops: string[] = [];
  private state: Record<string, unknown> = {
    globalAlpha: 1, filter: '', fillStyle: '', strokeStyle: '', font: '', textAlign: '', textBaseline: '',
    lineWidth: 1, globalCompositeOperation: 'source-over', shadowColor: '', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
  };
  constructor(public owner?: FakeCanvas) {
    for (const prop of RECORDED_PROPS) {
      Object.defineProperty(this, prop, {
        get: () => this.state[prop],
        set: (v: unknown) => {
          this.state[prop] = v;
          this.ops.push(`set ${prop}=${fmt(v)}`);
        },
      });
    }
  }
  private rec(name: string, args: unknown[]) {
    this.ops.push(`${name}(${args.map(fmt).join(',')})`);
  }
  save() { this.rec('save', []); }
  restore() { this.rec('restore', []); }
  clearRect(...a: number[]) { this.rec('clearRect', a); }
  fillRect(...a: number[]) { this.rec('fillRect', a); }
  fill() { this.rec('fill', []); }
  stroke() { this.rec('stroke', []); }
  beginPath() { this.rec('beginPath', []); }
  clip() { this.rec('clip', []); }
  arc(...a: number[]) { this.rec('arc', a); }
  rect(...a: number[]) { this.rec('rect', a); }
  roundRect(...a: number[]) { this.rec('roundRect', a); }
  fillText(t: string, ...a: number[]) { this.ops.push(`fillText(${t},${a.map(fmt).join(',')})`); }
  strokeText(t: string, ...a: number[]) { this.ops.push(`strokeText(${t},${a.map(fmt).join(',')})`); }
  translate(...a: number[]) { this.rec('translate', a); }
  rotate(...a: number[]) { this.rec('rotate', a); }
  transform(...a: number[]) { this.rec('transform', a); }
  scale(...a: number[]) { this.rec('scale', a); }
  setTransform(...a: number[]) { this.rec('setTransform', a); }
  measureText(t: string) {
    this.ops.push(`measureText(${t})`);
    return { width: t.length * 6 };
  }
  createRadialGradient(...a: number[]) {
    this.rec('createRadialGradient', a);
    return { addColorStop: (o: number, c: string) => this.ops.push(`gradStop(${fmt(o)},${c})`) };
  }
  createLinearGradient(...a: number[]) {
    this.rec('createLinearGradient', a);
    return { addColorStop: (o: number, c: string) => this.ops.push(`gradStop(${fmt(o)},${c})`) };
  }
  drawImage(src: unknown, ...rest: number[]) {
    let label: string;
    if (src instanceof FakeCanvas) label = `canvas#${src.id}`;
    else if (src && typeof (src as { naturalWidth?: unknown }).naturalWidth === 'number') {
      const img = src as { naturalWidth: number; naturalHeight: number };
      label = `img:${img.naturalWidth}x${img.naturalHeight}`;
    } else if (src && typeof (src as { videoWidth?: unknown }).videoWidth === 'number') {
      const v = src as { videoWidth: number; videoHeight: number };
      label = `video:${v.videoWidth}x${v.videoHeight}`;
    } else label = 'unknown';
    this.ops.push(`drawImage(${label},${rest.map(fmt).join(',')})`);
  }
}

/**
 * Expands cached-canvas composites into the cached canvas's own op
 * stream (its fake-world pixels), inlined exactly where the composite
 * op sits — so the expanded stream is directly comparable to a direct
 * draw's stream, op for op, with no marker lines of its own.
 */
function expandOps(ops: string[], canvases: Map<number, FakeCanvas>): string[] {
  const out: string[] = [];
  for (const op of ops) {
    const m = /^drawImage\(canvas#(\d+),/.exec(op);
    if (m) {
      const canvas = canvases.get(Number(m[1]));
      if (canvas) out.push(...expandOps(canvas.ctx.ops, canvases));
    } else {
      out.push(op);
    }
  }
  return out;
}

/** FNV-1a hash of the expanded op stream — the frame hash. */
function hashOps(ops: string[]): string {
  const joined = ops.join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

let canvasSeq = 0;
let canvases = new Map<number, FakeCanvas>();
let factoryCalls = 0;

function installFakeFactory() {
  canvasSeq = 0;
  canvases = new Map();
  factoryCalls = 0;
  setStaticLayerCanvasFactory((width: number, height: number) => {
    factoryCalls += 1;
    const canvas = new FakeCanvas(width, height, ++canvasSeq);
    canvases.set(canvas.id, canvas);
    return {
      canvas: canvas as unknown as HTMLCanvasElement,
      ctx: canvas.ctx as unknown as CanvasRenderingContext2D,
    };
  });
}

function frameHash(project: Project, assets: Parameters<typeof drawFrame>[3], t: number): { hash: string; ops: string[] } {
  const ctx = new RecordingCtx();
  drawFrame(ctx as unknown as CanvasRenderingContext2D, project, t, assets);
  const expanded = expandOps(ctx.ops, canvases);
  return { hash: hashOps(expanded), ops: expanded };
}

const photoAsset = {
  id: 'photo-1', kind: 'image' as const, fileName: 'poster.jpg', mimeType: 'image/jpeg',
  storageUrl: 'https://example.com/poster.jpg', sizeBytes: 1, width: 800, height: 600, createdAt: 1,
};
const photoEl = { complete: true, naturalWidth: 800, naturalHeight: 600 } as unknown as HTMLImageElement;

async function projectWithPhoto(mutate?: (item: ImageTimelineItem) => void): Promise<Project> {
  const { createDefaultProject } = await import('../projects/persistence');
  const { appendMediaToTimeline } = await import('../timeline/insert');
  const project = appendMediaToTimeline(createDefaultProject('uid-1'), photoAsset, {});
  const item = project.items.find((i) => i.type === 'image');
  if (!item || item.type !== 'image') throw new Error('expected an image item');
  item.startTime = 0;
  item.endTime = 10; // span covers every sampled time in these tests
  mutate?.(item);
  return project;
}

function baseImageItem(): ImageTimelineItem {
  return {
    id: 'img-1', type: 'image', trackId: 't', startTime: 0, endTime: 10, zIndex: 1, visible: true,
    mediaAssetId: 'photo-1', role: 'photo',
    position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 1,
  };
}

describe('R26 WS-S2 — isStaticLayerCacheEligible (conservative by construction)', () => {
  it('accepts a plain still image (poster art / backdrop / held photo)', () => {
    expect(isStaticLayerCacheEligible(baseImageItem())).toBe(true);
  });

  it('accepts static transforms: rotation, crop window, R24 framing and flip are constants of the item', () => {
    const item = baseImageItem();
    item.rotation = 12;
    item.crop = { x: 10, y: 10, width: 50, height: 50 };
    item.cropZoom = 2;
    item.cropOffsetX = 0.5;
    item.flipX = true;
    expect(isStaticLayerCacheEligible(item)).toBe(true);
  });

  it('accepts explicit no-ops: motion none, animation none, zero fades', () => {
    const item = baseImageItem();
    item.motion = { type: 'none', intensity: 1 };
    item.animation = { entrance: 'none', exit: 'none' };
    item.fade = { fadeInDuration: 0, fadeOutDuration: 0 };
    expect(isStaticLayerCacheEligible(item)).toBe(true);
  });

  it('excludes any motion effect (Ken Burns, tours, parallax — time functions even when momentarily held)', () => {
    for (const type of ['ken-burns', 'word-tour', 'parallax', 'slow-zoom-in'] as const) {
      const item = baseImageItem();
      item.motion = { type, intensity: 1 };
      expect(isStaticLayerCacheEligible(item)).toBe(false);
    }
  });

  it('excludes entrance/exit animation and any non-zero fade', () => {
    const animated = baseImageItem();
    animated.animation = { entrance: 'fade' };
    expect(isStaticLayerCacheEligible(animated)).toBe(false);
    const faded = baseImageItem();
    faded.fade = { fadeInDuration: 0, fadeOutDuration: 0.5 };
    expect(isStaticLayerCacheEligible(faded)).toBe(false);
  });

  it('excludes an endTransform (position/scale/opacity interpolate across the span)', () => {
    const item = baseImageItem();
    item.endTransform = { position: { x: 60, y: 60 }, scale: 1.2, opacity: 1 };
    expect(isStaticLayerCacheEligible(item)).toBe(false);
  });

  it('excludes translucent items (opacity !== 1) — intermediate-raster rounding is not proven identical', () => {
    const item = baseImageItem();
    item.opacity = 0.85;
    expect(isStaticLayerCacheEligible(item)).toBe(false);
  });

  it('excludes color-graded items (ctx.filter rasterization stays on the direct path)', () => {
    const graded = baseImageItem();
    graded.colorGrade = { brightness: 2, contrast: 14, saturation: 12 };
    expect(isStaticLayerCacheEligible(graded)).toBe(false);
    // A grade whose channels are all 0 produces NO filter string —
    // provably a no-op — so it stays eligible.
    const noopGrade = baseImageItem();
    noopGrade.colorGrade = { brightness: 0, contrast: 0, saturation: 0 };
    expect(isStaticLayerCacheEligible(noopGrade)).toBe(true);
  });
});

describe('R26 WS-S2 — frame-hash gate: cache ON vs OFF must be identical', () => {
  beforeEach(() => {
    installFakeFactory();
    clearStaticLayerCache();
    setStaticLayerCacheEnabled(true);
  });
  afterEach(() => {
    setStaticLayerCanvasFactory(null);
    setStaticLayerCacheEnabled(true);
  });

  const TIMES = [0.5, 2, 4.5, 9];

  async function hashesFor(mutate?: (item: ImageTimelineItem) => void): Promise<{ on: string[]; off: string[] }> {
    const assets = { images: new Map([[photoAsset.id, photoEl]]) };
    const offProject = await projectWithPhoto(mutate);
    setStaticLayerCacheEnabled(false);
    const off = TIMES.map((t) => frameHash(offProject, assets, t).hash);
    const onProject = await projectWithPhoto(mutate);
    setStaticLayerCacheEnabled(true);
    const on = TIMES.map((t) => frameHash(onProject, assets, t).hash);
    return { on, off };
  }

  it('plain still photo: identical frame hashes at every sampled time', async () => {
    const { on, off } = await hashesFor();
    expect(on).toEqual(off);
  });

  it('the cache actually engages: the layer is rendered ONCE across frames, then composited', async () => {
    const assets = { images: new Map([[photoAsset.id, photoEl]]) };
    const project = await projectWithPhoto();
    const first = frameHash(project, assets, 0.5);
    expect(factoryCalls).toBe(1);
    const second = frameHash(project, assets, 2);
    const third = frameHash(project, assets, 4.5);
    // No further cache renders — frames 2+ are pure composites.
    expect(factoryCalls).toBe(1);
    expect(second.hash).toBe(first.hash);
    expect(third.hash).toBe(first.hash);
    // And the main context really did receive a canvas composite op.
    const rawCtx = new RecordingCtx();
    drawFrame(rawCtx as unknown as CanvasRenderingContext2D, project, 6, assets);
    expect(rawCtx.ops.some((op) => op.startsWith('drawImage(canvas#'))).toBe(true);
    expect(rawCtx.ops.some((op) => op.startsWith('drawImage(img:'))).toBe(false);
  });

  it('cropped + flipped static photo: identical hashes (static source-rect math is cached, not skipped)', async () => {
    const { on, off } = await hashesFor((item) => {
      item.crop = { x: 10, y: 5, width: 60, height: 80 };
      item.flipX = true;
      item.rotation = 8;
    });
    expect(on).toEqual(off);
    expect(factoryCalls).toBeGreaterThan(0);
  });

  it('mixed project: a Ken Burns photo next to the static one — hashes identical, motion item never cached', async () => {
    const { createDefaultProject } = await import('../projects/persistence');
    const { appendMediaToTimeline } = await import('../timeline/insert');
    const secondAsset = { ...photoAsset, id: 'photo-2', fileName: 'moving.jpg' };
    const secondEl = { complete: true, naturalWidth: 1024, naturalHeight: 768 } as unknown as HTMLImageElement;

    const build = async (): Promise<Project> => {
      let project = appendMediaToTimeline(createDefaultProject('uid-1'), photoAsset, {});
      project = appendMediaToTimeline(project, secondAsset, {});
      const moving = project.items.find((i) => i.type === 'image' && i.mediaAssetId === 'photo-2');
      if (!moving || moving.type !== 'image') throw new Error('expected second image item');
      moving.motion = { type: 'ken-burns', intensity: 1 };
      moving.startTime = 0;
      moving.endTime = 10;
      const still = project.items.find((i) => i.type === 'image' && i.mediaAssetId === 'photo-1');
      if (still && still.type === 'image') {
        still.startTime = 0;
        still.endTime = 10;
      }
      return project;
    };
    const assets = {
      images: new Map([
        [photoAsset.id, photoEl],
        [secondAsset.id, secondEl],
      ]),
    };
    const offProject = await build();
    setStaticLayerCacheEnabled(false);
    const off = TIMES.map((t) => frameHash(offProject, assets, t).hash);
    const onProject = await build();
    setStaticLayerCacheEnabled(true);
    const on = TIMES.map((t) => frameHash(onProject, assets, t).hash);
    expect(on).toEqual(off);
    // Exactly ONE layer was ever rendered (the static photo); the
    // motion item drew directly on every frame.
    expect(factoryCalls).toBe(1);
  });

  it('a mutated item re-renders its layer instead of serving a stale one (signature invalidation)', async () => {
    const assets = { images: new Map([[photoAsset.id, photoEl]]) };
    const project = await projectWithPhoto();
    const before = frameHash(project, assets, 1).hash;
    expect(factoryCalls).toBe(1);
    const item = project.items.find((i) => i.type === 'image');
    if (!item || item.type !== 'image') throw new Error('expected image item');
    item.scale = 2.5;
    const after = frameHash(project, assets, 1);
    expect(factoryCalls).toBe(2);
    expect(after.hash).not.toBe(before);
    // And the re-rendered frame matches a direct (cache-off) draw of
    // the mutated project exactly.
    setStaticLayerCacheEnabled(false);
    const direct = frameHash(project, assets, 1).hash;
    expect(after.hash).toBe(direct);
  });
});
