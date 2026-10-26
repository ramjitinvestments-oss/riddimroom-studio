import { describe, it, expect } from 'vitest';
import {
  addPipOverlay,
  getPipShapeDef,
  pipRoundedRadius,
  pipShapePolygon,
  pipShapeRefitZoom,
  PIP_SHAPES,
} from './pip';
import { createDefaultProject } from './projects/persistence';
import { auditTextLayout, enforceTextLayout } from './promo/layout';
import { buildSlamProject } from './promo/recipes';
import type { MediaAsset, PipShape, Project } from '../types/timeline';

/**
 * R25 gates — the premium PiP shapes.
 *
 * Geometry is verified against `pipShapePolygon`: the flattened outline
 * produced by the SAME tracers the compositor clips/strokes with and the
 * picker thumbnails draw with, so green here means the rendered shapes
 * have this geometry — not a parallel copy of it.
 */

const ALL_SHAPES: PipShape[] = ['circle', 'rounded', 'square', 'squircle', 'diamond', 'hexagon', 'star', 'heart', 'arch'];
const BOXES: [number, number][] = [
  [200, 200],
  [240, 180],
  [180, 240],
];
const EPS = 0.75; // px — curve sampling tolerance

type Pt = { x: number; y: number };

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the polygon, or within EPS of its boundary (sampling slack). */
function insideOrNear(p: Pt, poly: Pt[]): boolean {
  if (pointInPolygon(p, poly)) return true;
  for (let i = 0; i < poly.length; i++) {
    if (distToSegment(p, poly[i], poly[(i + 1) % poly.length]) <= EPS) return true;
  }
  return false;
}

describe('PIP_SHAPES registry (WS-S1)', () => {
  it('has exactly the nine premium shapes, in picker order', () => {
    expect(PIP_SHAPES.map((s) => s.id)).toEqual(ALL_SHAPES);
  });

  it('every shape has a label and a safe factor in (0, 1]', () => {
    for (const def of PIP_SHAPES) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.safeFactor).toBeGreaterThan(0);
      expect(def.safeFactor).toBeLessThanOrEqual(1);
    }
    // The plan's ordering of "guaranteed visible": boxy > round > pointed.
    expect(getPipShapeDef('square').safeFactor).toBe(1);
    expect(getPipShapeDef('circle').safeFactor).toBeLessThan(getPipShapeDef('rounded').safeFactor);
    expect(getPipShapeDef('star').safeFactor).toBeLessThan(getPipShapeDef('heart').safeFactor);
    expect(getPipShapeDef('star').safeFactor).toBeLessThan(getPipShapeDef('diamond').safeFactor);
  });

  it('unknown shape ids fall back to the square def', () => {
    expect(getPipShapeDef('blob' as PipShape).id).toBe('square');
    expect(getPipShapeDef(undefined).id).toBe('square');
  });
});

describe('shape geometry — every outline stays inside its box', () => {
  for (const shape of ALL_SHAPES) {
    it(`${shape}: all traced points within the box at three aspects`, () => {
      for (const [w, h] of BOXES) {
        const poly = pipShapePolygon(shape, w, h);
        expect(poly.length).toBeGreaterThan(4);
        for (const p of poly) {
          expect(Math.abs(p.x)).toBeLessThanOrEqual(w / 2 + EPS);
          expect(Math.abs(p.y)).toBeLessThanOrEqual(h / 2 + EPS);
        }
        // …and the shape actually USES its box (no accidental tiny
        // path). Floors account for geometry: a 5-point star's widest
        // points sit at ±95% of the half-width, and an inscribed circle
        // spans only the box's MIN side on its long axis.
        const maxX = Math.max(...poly.map((p) => Math.abs(p.x)));
        const maxY = Math.max(...poly.map((p) => Math.abs(p.y)));
        const minHalf = Math.min(w, h) / 2;
        expect(maxX).toBeGreaterThan(minHalf * 0.85);
        expect(maxY).toBeGreaterThan(minHalf * 0.85);
        expect(Math.max(maxX / (w / 2), maxY / (h / 2))).toBeGreaterThan(0.85);
      }
    });
  }
});

describe('shape geometry — the inscribed safe factor is honoured', () => {
  for (const shape of ALL_SHAPES) {
    it(`${shape}: the centred safe-factor rectangle lies inside the outline`, () => {
      const [w, h] = [200, 200] as const;
      const poly = pipShapePolygon(shape, w, h);
      const f = getPipShapeDef(shape).safeFactor;
      const hw = (f * w) / 2;
      const hh = (f * h) / 2;
      const probes: Pt[] = [
        { x: hw, y: hh },
        { x: -hw, y: hh },
        { x: hw, y: -hh },
        { x: -hw, y: -hh },
        { x: hw, y: 0 },
        { x: -hw, y: 0 },
        { x: 0, y: hh },
        { x: 0, y: -hh },
        { x: 0, y: 0 },
      ];
      for (const p of probes) {
        expect(insideOrNear(p, poly), `${shape} probe ${JSON.stringify(p)}`).toBe(true);
      }
      // The factor must also be MEANINGFUL: a slightly larger rectangle
      // (capped at the box) must poke outside somewhere — except for the
      // square, whose safe region IS the whole box.
      if (f < 1) {
        const g = Math.min(1, f * 1.25 + 0.05);
        const gw = (g * w) / 2;
        const gh = (g * h) / 2;
        const corners: Pt[] = [
          { x: gw, y: gh },
          { x: -gw, y: gh },
          { x: gw, y: -gh },
          { x: -gw, y: -gh },
        ];
        expect(corners.some((p) => !insideOrNear(p, poly)), `${shape} oversize rectangle should escape`).toBe(true);
      }
    });
  }
});

describe('legacy regression — circle/rounded/square trace the SAME regions as before R25', () => {
  it('circle: every outline point lies on the inscribed circle (min side / 2)', () => {
    for (const [w, h] of BOXES) {
      const r = Math.min(w, h) / 2;
      const poly = pipShapePolygon('circle', w, h);
      for (const p of poly) {
        expect(Math.abs(Math.hypot(p.x, p.y) - r)).toBeLessThanOrEqual(EPS);
      }
    }
  });

  it('square: the outline is exactly the box corners', () => {
    const poly = pipShapePolygon('square', 200, 160);
    expect(poly).toContainEqual({ x: -100, y: -80 });
    expect(poly).toContainEqual({ x: 100, y: -80 });
    expect(poly).toContainEqual({ x: 100, y: 80 });
    expect(poly).toContainEqual({ x: -100, y: 80 });
  });

  it('rounded: outline points satisfy the roundRect signed-distance field (rad = min(28, min side × 0.12))', () => {
    for (const [w, h] of BOXES) {
      const rad = pipRoundedRadius(w, h);
      expect(rad).toBe(Math.min(28, Math.min(w, h) * 0.12));
      const poly = pipShapePolygon('rounded', w, h);
      for (const p of poly) {
        const qx = Math.abs(p.x) - (w / 2 - rad);
        const qy = Math.abs(p.y) - (h / 2 - rad);
        const sdf = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
        expect(Math.abs(sdf)).toBeLessThanOrEqual(EPS);
      }
      // The corners are genuinely rounded: no point sits in the corner
      // squares beyond the arc (the region a plain rect would fill).
      const cornerIntruders = poly.filter(
        (p) => Math.abs(p.x) > w / 2 - rad && Math.abs(p.y) > h / 2 - rad && Math.hypot(Math.abs(p.x) - (w / 2 - rad), Math.abs(p.y) - (h / 2 - rad)) > rad + EPS,
      );
      expect(cornerIntruders).toEqual([]);
    }
  });
});

describe('pipShapeRefitZoom (WS-S3)', () => {
  it('leaves zoom 1 untouched for every shape', () => {
    for (const shape of ALL_SHAPES) {
      expect(pipShapeRefitZoom(1, shape)).toBe(1);
      expect(pipShapeRefitZoom(undefined, shape)).toBe(1);
    }
  });

  it('square keeps the zoom (safe factor 1); pointed shapes relax it most', () => {
    expect(pipShapeRefitZoom(2, 'square')).toBeCloseTo(2, 6);
    expect(pipShapeRefitZoom(2, 'circle')).toBeCloseTo(1 + 0.7, 6);
    expect(pipShapeRefitZoom(2, 'star')).toBeCloseTo(1 + 0.34, 6);
    expect(pipShapeRefitZoom(3, 'heart')).toBeCloseTo(1 + 2 * 0.42, 6);
    expect(pipShapeRefitZoom(2, 'star')).toBeLessThan(pipShapeRefitZoom(2, 'diamond'));
    expect(pipShapeRefitZoom(2, 'diamond')).toBeLessThan(pipShapeRefitZoom(2, 'hexagon'));
  });

  it('clamps into the compositor zoom range [1, 3]', () => {
    expect(pipShapeRefitZoom(99, 'square')).toBe(3);
    expect(pipShapeRefitZoom(0.5, 'star')).toBe(1);
  });
});

describe('addPipOverlay with the new shapes + the R22 audit gate', () => {
  const asset: MediaAsset = {
    id: 'asset-r25',
    kind: 'video',
    fileName: 'talking-head.mp4',
    mimeType: 'video/mp4',
    storageUrl: 'https://example.com/v.mp4',
    sizeBytes: 12345,
    durationSeconds: 10,
    createdAt: Date.now(),
  };

  it('accepts every premium shape as an insert override', () => {
    for (const shape of ALL_SHAPES) {
      const next = addPipOverlay(createDefaultProject('uid-r25'), asset, { shape });
      const pip = next.items.find((i) => i.type === 'video' && i.pip?.isPip);
      expect(pip?.type === 'video' ? pip.pip?.shape : undefined).toBe(shape);
    }
  });

  it('a promo project carrying a shaped PiP still audits 0 text collisions (R22 gate)', () => {
    for (const shape of ALL_SHAPES) {
      const base: Project = buildSlamProject(
        createDefaultProject('uid-r25'),
        { id: 'art-r25', kind: 'image', fileName: 'flyer.png', mimeType: 'image/png', storageUrl: 'https://example.com/f.png', sizeBytes: 1, createdAt: Date.now(), width: 1080, height: 1440 },
        { hook1: 'SOCA FEST', hook2: 'IS BACK', sub: 'SAT DEC 20 • THE GRAND HALL', cta: 'GET TICKETS' },
        { duration: 10 },
      );
      const withPip = addPipOverlay(base, asset, { shape });
      const clean = enforceTextLayout(withPip);
      expect(auditTextLayout(clean), `shape ${shape}`).toEqual([]);
    }
  });
});
