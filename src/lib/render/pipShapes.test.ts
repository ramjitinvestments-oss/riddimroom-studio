import { describe, it, expect } from 'vitest';
import { clipPipShape, paintPipGlow, strokePipBorder } from './compositor';
import {
  createPipShapeFlattener,
  pipShapePolygon,
  PIP_BRAND_GOLD,
  PIP_GOLD_RING_STOPS,
  type PipPathSink,
} from '../pip';
import type { PipShape } from '../../types/timeline';

/**
 * R25 gates at the render seam: a fake 2D context whose path methods
 * forward into the registry's own flattening sink. Whatever polygon the
 * fake records IS the geometry the compositor asked the canvas to clip /
 * stroke / fill — so these tests prove the border strokes exactly the
 * clipped path, the gradient ring is the two gold stops, and the glow
 * hugs the same outline, for every shape.
 */

const ALL_SHAPES: PipShape[] = ['circle', 'rounded', 'square', 'squircle', 'diamond', 'hexagon', 'star', 'heart', 'arch'];

class FakeGradient {
  stops: [number, string][] = [];
  addColorStop(offset: number, color: string): void {
    this.stops.push([offset, color]);
  }
}

class FakeCtx {
  flattener = createPipShapeFlattener();
  sink: PipPathSink = this.flattener.sink;
  ops: string[] = [];
  strokeStyle: unknown = null;
  fillStyle: unknown = null;
  lineWidth = 0;
  shadowColor = '';
  shadowBlur = 0;
  shadowOffsetX = 0;
  shadowOffsetY = 0;
  gradients: FakeGradient[] = [];

  save(): void { this.ops.push('save'); }
  restore(): void { this.ops.push('restore'); }
  beginPath(): void { this.ops.push('beginPath'); }
  clip(): void { this.ops.push('clip'); }
  stroke(): void { this.ops.push('stroke'); }
  fill(): void { this.ops.push('fill'); }
  createLinearGradient(): FakeGradient {
    const g = new FakeGradient();
    this.gradients.push(g);
    return g;
  }
  moveTo(x: number, y: number): void { this.sink.moveTo(x, y); }
  lineTo(x: number, y: number): void { this.sink.lineTo(x, y); }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void { this.sink.quadraticCurveTo(cpx, cpy, x, y); }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number): void { this.sink.bezierCurveTo(a, b, c, d, x, y); }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void { this.sink.arc(x, y, r, a0, a1, ccw); }
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw?: boolean): void { this.sink.ellipse(x, y, rx, ry, rot, a0, a1, ccw); }
  rect(x: number, y: number, w: number, h: number): void { this.sink.rect(x, y, w, h); }
  roundRect(x: number, y: number, w: number, h: number, radii?: number): void { this.sink.roundRect(x, y, w, h, radii); }
  closePath(): void { this.sink.closePath(); }
  asCtx(): CanvasRenderingContext2D {
    return this as unknown as CanvasRenderingContext2D;
  }
}

function expectSamePolygon(actual: { x: number; y: number }[], expected: { x: number; y: number }[]) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((p, i) => {
    expect(p.x).toBeCloseTo(expected[i].x, 6);
    expect(p.y).toBeCloseTo(expected[i].y, 6);
  });
}

describe('compositor PiP shape seam (R25 WS-S2)', () => {
  for (const shape of ALL_SHAPES) {
    it(`${shape}: clip, border and glow all trace the registry polygon`, () => {
      const expected = pipShapePolygon(shape, 200, 160);

      const clipCtx = new FakeCtx();
      clipPipShape(clipCtx.asCtx(), shape, 200, 160);
      expect(clipCtx.ops).toEqual(['beginPath', 'clip']);
      expectSamePolygon(clipCtx.flattener.points, expected);

      const borderCtx = new FakeCtx();
      strokePipBorder(borderCtx.asCtx(), { shape, borderWidth: 4, borderColor: '#FFFFFF' }, 200, 160);
      expect(borderCtx.ops).toEqual(['save', 'beginPath', 'stroke', 'restore']);
      expect(borderCtx.strokeStyle).toBe('#FFFFFF');
      expect(borderCtx.lineWidth).toBe(4);
      expectSamePolygon(borderCtx.flattener.points, expected);

      const glowCtx = new FakeCtx();
      paintPipGlow(glowCtx.asCtx(), { shape, glowColor: PIP_BRAND_GOLD }, 200, 160);
      expect(glowCtx.ops).toEqual(['save', 'beginPath', 'fill', 'restore']);
      expect(glowCtx.fillStyle).toBe(PIP_BRAND_GOLD);
      expect(glowCtx.shadowColor).toBe(PIP_BRAND_GOLD);
      expect(glowCtx.shadowBlur).toBeGreaterThan(0);
      expect(glowCtx.shadowOffsetY).toBe(0);
      expectSamePolygon(glowCtx.flattener.points, expected);
    });
  }

  it('the gold gradient ring strokes with the two brand-gold stops', () => {
    const ctx = new FakeCtx();
    strokePipBorder(ctx.asCtx(), { shape: 'star', borderWidth: 6, borderColor: '#FFFFFF', ringGradient: true }, 200, 200);
    expect(ctx.gradients).toHaveLength(1);
    expect(ctx.gradients[0].stops).toEqual([
      [0, PIP_GOLD_RING_STOPS[0]],
      [1, PIP_GOLD_RING_STOPS[1]],
    ]);
    expect(ctx.strokeStyle).toBe(ctx.gradients[0]);
    expect(ctx.lineWidth).toBe(6);
  });

  it('glow defaults to brand gold when no colour is set', () => {
    const ctx = new FakeCtx();
    paintPipGlow(ctx.asCtx(), { shape: 'heart' }, 120, 120);
    expect(ctx.shadowColor).toBe(PIP_BRAND_GOLD);
    expect(ctx.fillStyle).toBe(PIP_BRAND_GOLD);
  });
});
