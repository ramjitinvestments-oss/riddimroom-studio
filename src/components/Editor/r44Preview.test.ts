/**
 * R44 Phase A — Preview endgame (source-level guards, house style).
 *
 * SF-1 (S4, the item R42's Phase A left behind): the preview canvas
 * backing store is capped at display size × DPR via previewBackingSize,
 * and drawFrame runs under the matching scale transform — the route
 * whose frame parity is proven for real in
 * src/lib/render/previewScale.test.ts. The exporters must NOT take
 * this route: they composite at full project resolution.
 * SF-2: the idle skip — the tick consults previewDrawDecision with a
 * remembered last-drawn frame (project / time / media signature).
 * PL-1: the tick diet — each track list and the project duration are
 * derived once per tick, not per element or per branch.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const pane = readFileSync(join(HERE, 'PreviewPane.tsx'), 'utf8');
const canvas2d = readFileSync(join(HERE, '../../lib/export/canvas2dRenderer.ts'), 'utf8');
const mediabunny = readFileSync(join(HERE, '../../lib/export/mediabunnyExporter.ts'), 'utf8');

describe('R44 SF-1 — preview composites at display scale; exports stay full-res', () => {
  it('the pane sizes its backing store through previewBackingSize and draws under its transform', () => {
    expect(pane).toContain("import { mediaFrameSignature, previewBackingSize, previewDrawDecision } from '../../lib/render/previewScale';");
    expect(pane).toContain('const backing = previewBackingSize(');
    const transformAt = pane.indexOf('ctx.setTransform(backing.scaleX, 0, 0, backing.scaleY, 0, 0);');
    const drawAt = pane.indexOf('drawFrame(ctx, proj, t, frameAssets);');
    expect(transformAt).toBeGreaterThan(-1);
    expect(drawAt).toBeGreaterThan(transformAt);
  });

  it('neither exporter imports the preview scale route', () => {
    expect(canvas2d).not.toContain('previewScale');
    expect(mediabunny).not.toContain('previewScale');
  });
});

describe('R44 SF-2 — the idle skip is wired to a last-drawn memory', () => {
  it('the tick builds the media signature and consults the decision before drawing', () => {
    expect(pane).toContain('const mediaSig = mediaFrameSignature(frameAssets.videos ?? null, frameAssets.images);');
    expect(pane).toContain('const shouldDraw = previewDrawDecision({');
    expect(pane).toContain('lastDrawnRef.current = { project: proj, time: t, mediaSig };');
  });
});

describe('R44 PL-1 — one derivation per tick', () => {
  it('the project duration is derived once per tick (the clamp reuses it)', () => {
    expect(pane.split('getProjectDuration(proj)').length - 1).toBe(1);
    expect(pane).toContain('const projectDuration = projectEnd;');
  });

  it('each track list is derived once in the tick (audio no longer re-derived per element)', () => {
    expect(pane.split("getItemsByTrackType(proj, 'audio')").length - 1).toBe(1);
    expect(pane.split("getItemsByTrackType(proj, 'image')").length - 1).toBe(1);
    // The second 'video' derivation is the paused-seek effect's own
    // (outside the tick); the tick's PiP pass reuses the hoisted list.
    expect(pane).toContain('const activeVideoItems = videoItems.filter(');
    expect(pane).toContain('if (!activeAudioAssetIds.has(assetId) && !el.paused) el.pause();');
  });
});
