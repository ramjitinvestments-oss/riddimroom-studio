import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CAPTION_EXIT_FADE_SECONDS, computeCaptionPhase, drawFrame, type FrameAssets } from './compositor';
import { createDefaultProject } from '../projects/persistence';
import { addItem, generateTimelineId, getTracksByType } from '../timeline/utils';
import type { CaptionTimelineItem, Project } from '../../types/timeline';

/**
 * R42 Phase C — caption motion, pinned at the compositor.
 *
 * Two layers of proof: the pure phase function (entrances per kind,
 * the universal fade-out, the third-of-cue caps), and the frame-hash
 * parity the plan demands — preview and export both render through
 * THIS drawFrame, so rendering a cue through it twice must produce
 * the identical op stream (determinism), the entrance/exit midpoints
 * must actually differ from the settled frame (the motion is real),
 * and 'off' must reproduce the pre-R42 hard-cut frame exactly.
 */

// ---------------------------------------------------------------------------
// Recording ctx (the staticLayerCache.test.ts pattern): every draw call
// and style assignment becomes a string op; the joined stream IS the
// frame for comparison purposes.
// ---------------------------------------------------------------------------

function fmt(v: unknown): string {
  if (typeof v === 'number') return String(Math.round(v * 10000) / 10000);
  return String(v);
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
  constructor() {
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
  drawImage(_src: unknown, ...rest: number[]) { this.rec('drawImage', rest); }
}

function frameOps(project: Project, t: number): string[] {
  const ctx = new RecordingCtx();
  drawFrame(ctx as unknown as CanvasRenderingContext2D, project, t, {} as FrameAssets);
  return ctx.ops;
}

function captionProject(overrides: Partial<CaptionTimelineItem> = {}): Project {
  let p = createDefaultProject('CaptionMotion');
  const track = getTracksByType(p, 'caption')[0];
  const item: CaptionTimelineItem = {
    id: generateTimelineId('item'),
    type: 'caption',
    trackId: track.id,
    startTime: 0,
    endTime: 3,
    zIndex: 5,
    visible: true,
    words: [{ text: 'Hello', start: 0, end: 3 }],
    captionStyleId: 'classic',
    source: 'manual',
    editable: true,
    ...overrides,
  };
  p = addItem(p, item);
  return p;
}

describe('computeCaptionPhase — the pure cue phase function', () => {
  it('mid-cue is the identity for every kind (a settled cue renders as it always did)', () => {
    for (const kind of ['fade', 'pop', 'rise'] as const) {
      expect(computeCaptionPhase(kind, 1.5, 1.5, 3, 30)).toEqual({ opacityMul: 1, scaleMul: 1, offsetYPx: 0 });
    }
  });

  it('fade ramps opacity in over the catalog fade duration and out over the universal exit', () => {
    expect(computeCaptionPhase('fade', 0, 3, 3, 30).opacityMul).toBe(0);
    expect(computeCaptionPhase('fade', 0.225, 2.775, 3, 30).opacityMul).toBeCloseTo(0.875, 3); // easeOutCubic(0.5)
    expect(computeCaptionPhase('fade', 2.9, CAPTION_EXIT_FADE_SECONDS, 3, 30).opacityMul).toBe(1);
    expect(computeCaptionPhase('fade', 2.9, 0, 3, 30).opacityMul).toBe(0);
    expect(computeCaptionPhase('fade', 2.875, 0.125, 3, 30).opacityMul).toBeCloseTo(0.875, 3);
  });

  it('pop scales from the 0.85 floor through the easeOutBack overshoot, settling at 1', () => {
    expect(computeCaptionPhase('pop', 0, 3, 3, 30).scaleMul).toBeCloseTo(0.85, 3);
    const mid = computeCaptionPhase('pop', 0.175, 2.825, 3, 30).scaleMul; // half of the 0.35s pop entrance
    expect(mid).toBeGreaterThan(1); // the overshoot
    expect(computeCaptionPhase('pop', 1.5, 1.5, 3, 30).scaleMul).toBe(1);
  });

  it('rise starts a full rise-distance below and lands at 0', () => {
    expect(computeCaptionPhase('rise', 0, 3, 3, 30).offsetYPx).toBe(30);
    expect(computeCaptionPhase('rise', 0.2, 2.8, 3, 30).offsetYPx).toBeCloseTo(30 * (1 - 0.875), 2);
    expect(computeCaptionPhase('rise', 1.5, 1.5, 3, 30).offsetYPx).toBe(0);
  });

  it('phases cap at a third of the cue on short cues (never all entrance or all exit)', () => {
    // A 0.3s cue: entrance must be 0.1s, not the 0.45s catalog fade.
    expect(computeCaptionPhase('fade', 0.05, 0.25, 0.3, 30).opacityMul).toBeCloseTo(0.875, 3);
    // And the exit likewise: at 0.05s left on a 0.3s cue the fade is at its midpoint.
    expect(computeCaptionPhase('fade', 0.25, 0.05, 0.3, 30).opacityMul).toBeCloseTo(0.875, 3);
  });
});

describe('frame parity — preview drawFrame IS export drawFrame', () => {
  it('both export renderers call the shared drawFrame (the parity premise)', () => {
    const root = resolve(__dirname, '../../..');
    for (const file of ['src/lib/export/mediabunnyExporter.ts', 'src/lib/export/canvas2dRenderer.ts']) {
      expect(readFileSync(resolve(root, file), 'utf8')).toContain('drawFrame(');
    }
  });

  it('the same frame renders the identical op stream twice (deterministic — preview = export)', () => {
    const p = captionProject(); // classic → fade
    expect(frameOps(p, 0.225).join('\n')).toBe(frameOps(p, 0.225).join('\n'));
    expect(frameOps(p, 2.875).join('\n')).toBe(frameOps(p, 2.875).join('\n'));
  });

  it('entrance and exit midpoints carry the fade; the settled frame carries no globalAlpha at all', () => {
    const p = captionProject();
    const entrance = frameOps(p, 0.225);
    const exit = frameOps(p, 2.875);
    const settled = frameOps(p, 1.5);
    expect(entrance.some((op) => op.startsWith('set globalAlpha=0.875'))).toBe(true);
    expect(exit.some((op) => op.startsWith('set globalAlpha=0.875'))).toBe(true);
    expect(settled.some((op) => op.startsWith('set globalAlpha'))).toBe(false);
    // And the motion is REAL: moving frames differ from the settled frame.
    expect(entrance.join('\n')).not.toBe(settled.join('\n'));
    expect(exit.join('\n')).not.toBe(settled.join('\n'));
  });

  it('pop and rise move the block: a scale op for pop, a downward translate for rise', () => {
    const pop = frameOps(captionProject({ captionStyleId: 'viral' }), 0.175);
    expect(pop.some((op) => op.startsWith('scale('))).toBe(true);
    const rise = frameOps(captionProject({ captionStyleId: 'minimal-box' }), 0.2);
    const translateWithY = rise.filter((op) => op.startsWith('translate(')).map((op) => op);
    expect(translateWithY.some((op) => /,([1-9][0-9.]*|0\.[0-9]*[1-9][0-9.]*)\)$/.test(op))).toBe(true);
  });

  it("'off' reproduces the pre-R42 hard cut exactly: no motion ops, entrance frame = settled frame", () => {
    const off = captionProject({ animation: 'off' });
    const atEntrance = frameOps(off, 0.225);
    const settled = frameOps(off, 1.5);
    expect(atEntrance.some((op) => op.startsWith('set globalAlpha'))).toBe(false);
    expect(atEntrance.join('\n')).toBe(settled.join('\n'));
    // …and the new engine's settled frame equals the off frame (identity mid-cue).
    expect(frameOps(captionProject(), 1.5).join('\n')).toBe(settled.join('\n'));
  });

  it('an item-level override beats the style inside the real render', () => {
    // classic is a fade style; forcing pop must produce the scale op.
    const forced = frameOps(captionProject({ animation: 'pop' }), 0.175);
    expect(forced.some((op) => op.startsWith('scale('))).toBe(true);
  });
});
