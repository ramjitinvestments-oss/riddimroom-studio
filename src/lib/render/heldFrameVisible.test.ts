import { describe, expect, it } from 'vitest';
import { drawFrame, findHeldMainVisualItem } from './compositor';
import type { Project } from '../../types/timeline';

/**
 * R40 P-36 — a held frame is a VISIBLE frame.
 *
 * The R36 hold bypassed fade/exit animation, but the end transform was
 * still applied at the held instant (progress clamps to 1 past the
 * item's end), so a main clip whose end transform finishes at opacity
 * 0 — or moved/scaled away — "held" as an invisible/off-frame tail.
 * The held draw now uses the item's resting (base) transform: the end
 * transform is neutralized, like the fade/exit bypass.
 */

interface DrawRecord {
  src: unknown;
  alpha: number;
  translate: [number, number] | null;
}

function makeRecordingCtx() {
  const draws: DrawRecord[] = [];
  let lastTranslate: [number, number] | null = null;
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
    shadowOffsetX: 0,
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
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => {},
    bezierCurveTo: () => {},
    closePath: () => {},
    ellipse: () => {},
    fillText: () => {},
    strokeText: () => {},
    translate: (x: number, y: number) => {
      lastTranslate = [x, y];
    },
    rotate: () => {},
    transform: () => {},
    setTransform: () => {},
    scale: () => {},
    measureText: (t: string) => ({ width: t.length * 6 }),
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    drawImage: (src: unknown) => {
      draws.push({ src, alpha: ctx.globalAlpha as number, translate: lastTranslate });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, draws };
}

function projectWithEndTransform(mainKind: 'video' | 'image'): Project {
  const base = {
    id: 'project-p36',
    ownerUid: 'test-uid',
    name: 'P36',
    schemaVersion: 1,
    canvasWidth: 1080,
    canvasHeight: 1920,
    frameRate: 30,
    createdAt: 1,
    updatedAt: 1,
    watermarkEnabled: false,
    tracks: [
      { id: 'track-video', type: 'video' as const, name: 'Main Video', order: 0, visible: true, locked: false },
      { id: 'track-image', type: 'image' as const, name: 'Images', order: 1, visible: true, locked: false },
    ],
    mediaAssets: {},
    items: [],
  };
  const endTransform = { position: { x: 150, y: 50 }, scale: 0.2, opacity: 0 };
  const mainItem =
    mainKind === 'video'
      ? {
          id: 'item-main', type: 'video' as const, trackId: 'track-video', startTime: 0, endTime: 12,
          zIndex: 0, visible: true, mediaAssetId: 'main-vid',
          position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 1,
          trimStart: 0, trimEnd: 12, speed: 1, reverse: false, volume: 1, muted: false,
          endTransform,
        }
      : {
          id: 'item-main', type: 'image' as const, trackId: 'track-image', startTime: 0, endTime: 12,
          zIndex: 0, visible: true, mediaAssetId: 'main-img', role: 'photo' as const,
          position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 1,
          endTransform,
        };
  const pipItem = {
    id: 'item-pip', type: 'video' as const, trackId: 'track-video', startTime: 0, endTime: 40,
    zIndex: 1, visible: true, mediaAssetId: 'pip-vid',
    position: { x: 80, y: 80 }, scale: 0.3, rotation: 0, opacity: 1,
    trimStart: 0, trimEnd: 40, speed: 1, reverse: false, volume: 1, muted: true,
    pip: { isPip: true, shape: 'rounded', borderWidth: 0, borderColor: '#000000', shadow: false },
  };
  return { ...base, items: [mainItem, pipItem] } as unknown as Project;
}

describe('R40 P-36 — held frame is a visible frame', () => {
  const mainEl = { videoWidth: 1280, videoHeight: 720 } as unknown as HTMLVideoElement;
  const pipEl = { videoWidth: 640, videoHeight: 640 } as unknown as HTMLVideoElement;
  const imgEl = { complete: true, naturalWidth: 800, naturalHeight: 600 } as unknown as HTMLImageElement;

  it('video main with endTransform opacity 0 holds at full opacity at its resting position in the tail', () => {
    const project = projectWithEndTransform('video');
    expect(findHeldMainVisualItem(project, 20)?.id).toBe('item-main');
    const { ctx, draws } = makeRecordingCtx();
    drawFrame(ctx, project, 20, {
      images: new Map(),
      videos: new Map([['main-vid', mainEl], ['pip-vid', pipEl]]),
    });
    const mainDraw = draws.find((d) => d.src === mainEl);
    expect(mainDraw).toBeDefined();
    // Visible: the end transform's opacity 0 must NOT be applied.
    expect(mainDraw!.alpha).toBeGreaterThan(0);
    expect(mainDraw!.alpha).toBeCloseTo(1, 5);
    // Resting geometry: centred at 50% × 50% of the 1080×1920 canvas,
    // not the end transform's off-frame x=150%.
    expect(mainDraw!.translate).toEqual([540, 960]);
    // The PiP still plays normally alongside.
    expect(draws.some((d) => d.src === pipEl)).toBe(true);
  });

  it('inside the item’s own span the end transform still applies (no behaviour change before the hold)', () => {
    const project = projectWithEndTransform('video');
    const { ctx, draws } = makeRecordingCtx();
    drawFrame(ctx, project, 11.9, {
      images: new Map(),
      videos: new Map([['main-vid', mainEl], ['pip-vid', pipEl]]),
    });
    const mainDraw = draws.find((d) => d.src === mainEl);
    expect(mainDraw).toBeDefined();
    // Progress ≈ 0.99 → opacity has nearly reached the end value 0.
    expect(mainDraw!.alpha).toBeLessThan(0.05);
  });

  it('image main with endTransform opacity 0 also holds visibly', () => {
    const project = projectWithEndTransform('image');
    expect(findHeldMainVisualItem(project, 20)?.id).toBe('item-main');
    const { ctx, draws } = makeRecordingCtx();
    drawFrame(ctx, project, 20, {
      images: new Map([['main-img', imgEl]]),
      videos: new Map([['pip-vid', pipEl]]),
    });
    const mainDraw = draws.find((d) => d.src === imgEl);
    expect(mainDraw).toBeDefined();
    expect(mainDraw!.alpha).toBeGreaterThan(0);
    expect(mainDraw!.alpha).toBeCloseTo(1, 5);
  });
});
