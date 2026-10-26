import { describe, it, expect } from 'vitest';
import {
  POSTER_FORMATS,
  buildPosterProject,
  estimatorMeasurer,
  pickPosterLayout,
  renderPosterStillBlob,
  thirdBusyness,
  wrapPosterText,
  type PosterFormatId,
  type PosterLayout,
} from './poster';
import { auditTextLayout } from './layout';
import { estimateTextBox } from '../render/textGuard';
import { createDefaultProject } from '../projects/persistence';
import type { ArtworkAnalysis } from './analyze';
import type { ImageTimelineItem, MediaAsset, Project, TextTimelineItem } from '../../types/timeline';

function fakeAsset(id: string, width: number, height: number): MediaAsset {
  return {
    id, kind: 'image', storageUrl: `https://example.test/${id}.png`, fileName: `${id}.png`,
    sizeBytes: 1000, mimeType: 'image/png', width, height, createdAt: 0,
  };
}

function makeAnalysis(bands: ArtworkAnalysis['bands']): ArtworkAnalysis {
  return {
    width: 1080, height: 1920, darkFraction: 0, meanLuminance: 100,
    bands, suggestedKind: 'flyer', palette: { colors: [], warmth: 0, saturation: 0 },
  };
}

/** A scrim asset with exactly the aspect createScrimFile would produce. */
function scrimFor(formatW: number, formatH: number, layout: PosterLayout): MediaAsset {
  const bandH = (layout === 'B' ? 0.55 : 0.5) * formatH;
  return fakeAsset(`scrim-${layout}`, 540, Math.round((540 * bandH) / formatW));
}

function imageItems(project: Project): ImageTimelineItem[] {
  return project.items.filter((i): i is ImageTimelineItem => i.type === 'image');
}

function textItems(project: Project): TextTimelineItem[] {
  return project.items.filter((i): i is TextTimelineItem => i.type === 'text');
}

/** Rendered box (px) of an image item, following drawImageItem's crop math. */
function renderedBox(project: Project, item: ImageTimelineItem): { w: number; h: number; cx: number; cy: number } {
  const asset = project.mediaAssets[item.mediaAssetId];
  const w = project.canvasWidth * 0.25 * item.scale;
  let aspect: number;
  if (item.crop && asset.width && asset.height) {
    aspect = ((item.crop.height / 100) * asset.height) / ((item.crop.width / 100) * asset.width);
  } else {
    aspect = (asset.height ?? 1) / (asset.width ?? 1);
  }
  return {
    w,
    h: w * aspect,
    cx: (item.position.x / 100) * project.canvasWidth,
    cy: (item.position.y / 100) * project.canvasHeight,
  };
}

describe('R23 WS1 — poster builds across formats and layouts', () => {
  for (const formatId of Object.keys(POSTER_FORMATS) as PosterFormatId[]) {
    const format = POSTER_FORMATS[formatId];
    for (const layout of ['B', 'T'] as PosterLayout[]) {
      it(`${formatId} layout ${layout}: cover photo, edged scrim, in-margin texts, clean audit`, () => {
        const photo = fakeAsset('photo', 1600, 1000);
        const scrim = scrimFor(format.canvasWidth, format.canvasHeight, layout);
        const base = createDefaultProject('u', 'Poster', format.canvasWidth, format.canvasHeight);
        const built = buildPosterProject(
          base,
          photo,
          scrim,
          { headline: 'The big night out', sub: 'One room. One crowd. One unforgettable evening.' },
          { layout },
        );

        const margin = 75 * (format.canvasWidth / 1080);

        // Photo: crop window aspect == canvas aspect, rendered box covers the canvas.
        const photoItem = imageItems(built).find((i) => i.role === 'photo')!;
        expect(photoItem, 'photo item').toBeTruthy();
        expect(photoItem.crop, 'photo crop').toBeTruthy();
        const cropWpx = ((photoItem.crop!.width / 100) * photo.width!);
        const cropHpx = ((photoItem.crop!.height / 100) * photo.height!);
        expect(Math.abs(cropWpx / cropHpx - format.canvasWidth / format.canvasHeight)).toBeLessThan(0.01);
        const photoBox = renderedBox(built, photoItem);
        expect(photoBox.w).toBeCloseTo(format.canvasWidth, 4);
        expect(photoBox.h).toBeCloseTo(format.canvasHeight, 4);
        expect(photoBox.cx).toBeCloseTo(format.canvasWidth / 2, 4);
        expect(photoBox.cy).toBeCloseTo(format.canvasHeight / 2, 4);

        // Scrim: present, stacked above the photo and below the text,
        // centre in the correct half, reaching the correct canvas edge.
        const scrimItem = imageItems(built).find((i) => i.role === 'graphic')!;
        expect(scrimItem, 'scrim item').toBeTruthy();
        expect(scrimItem.zIndex).toBeGreaterThan(photoItem.zIndex);
        const scrimBox = renderedBox(built, scrimItem);
        const scrimTop = scrimBox.cy - scrimBox.h / 2;
        const scrimBottom = scrimBox.cy + scrimBox.h / 2;
        if (layout === 'B') {
          expect(scrimBottom).toBeCloseTo(format.canvasHeight, 4);
          expect(scrimBox.cy).toBeGreaterThan(format.canvasHeight / 2);
        } else {
          expect(scrimTop).toBeCloseTo(0, 4);
          expect(scrimBox.cy).toBeLessThan(format.canvasHeight / 2);
        }
        for (const t of textItems(built)) expect(t.zIndex).toBeGreaterThan(scrimItem.zIndex);

        // Texts: headline uppercased, every estimated box inside the
        // side margins horizontally and the canvas vertically.
        const texts = textItems(built);
        expect(texts.length).toBeGreaterThan(0);
        expect(texts.some((t) => t.text.includes('BIG NIGHT'))).toBe(true);
        for (const t of texts) {
          const box = estimateTextBox(
            t.text,
            t.fontSize * (t.scale || 1),
            (t.position.x / 100) * format.canvasWidth,
            (t.position.y / 100) * format.canvasHeight,
          );
          expect(box.x, `${t.text} left`).toBeGreaterThanOrEqual(margin - 1);
          expect(box.x + box.w, `${t.text} right`).toBeLessThanOrEqual(format.canvasWidth - margin + 1);
          expect(box.y, `${t.text} top`).toBeGreaterThanOrEqual(-1);
          expect(box.y + box.h, `${t.text} bottom`).toBeLessThanOrEqual(format.canvasHeight + 1);
          expect(t.startTime).toBe(0);
          expect(t.endTime).toBe(5);
        }
        if (layout === 'B') {
          const last = texts[texts.length - 1];
          const box = estimateTextBox(last.text, last.fontSize, format.canvasWidth / 2, (last.position.y / 100) * format.canvasHeight);
          expect(box.y + box.h).toBeCloseTo(format.canvasHeight - margin, 4);
        } else {
          const first = texts[0];
          const box = estimateTextBox(first.text, first.fontSize, format.canvasWidth / 2, (first.position.y / 100) * format.canvasHeight);
          expect(box.y).toBeCloseTo(margin, 4);
        }

        expect(auditTextLayout(built)).toEqual([]);
      });
    }
  }

  it('a portrait photo is cropped to the canvas aspect too, and no scrim means no scrim item', () => {
    const photo = fakeAsset('portrait-photo', 900, 1600);
    const built = buildPosterProject(
      createDefaultProject('u', 'Poster', 1080, 1080),
      photo,
      null,
      { headline: 'Fresh look' },
      { layout: 'B', durationSeconds: 7 },
    );
    const photoItem = imageItems(built).find((i) => i.role === 'photo')!;
    const cropWpx = ((photoItem.crop!.width / 100) * photo.width!);
    const cropHpx = ((photoItem.crop!.height / 100) * photo.height!);
    expect(Math.abs(cropWpx / cropHpx - 1)).toBeLessThan(0.01);
    expect(imageItems(built).filter((i) => i.role === 'graphic')).toEqual([]);
    for (const t of textItems(built)) expect(t.endTime).toBe(7);
    expect(auditTextLayout(built)).toEqual([]);
  });
});

describe('R23 WS1 — wrapPosterText', () => {
  const baseOpts = {
    maxWidthPx: 1080 - 2 * 75,
    startFontPx: 110,
    minFontPx: 40,
    fontFamily: 'Anton',
    measurer: estimatorMeasurer,
  };

  it('a long headline wraps to at most 2 lines, each within the max width', () => {
    const { lines, fontPx } = wrapPosterText('THE BIGGEST NIGHT OF THE YEAR IS HERE', { ...baseOpts, maxLines: 2 });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThanOrEqual(2);
    for (const line of lines) expect(estimatorMeasurer(line, fontPx, 'Anton')).toBeLessThanOrEqual(baseOpts.maxWidthPx);
  });

  it('a very long input shrinks the font below the start size', () => {
    const long = 'ONE VERY LONG HEADLINE THAT KEEPS GOING AND GOING WITH MORE AND MORE WORDS IN IT';
    const { lines, fontPx } = wrapPosterText(long, { ...baseOpts, maxLines: 3 });
    expect(fontPx).toBeLessThan(baseOpts.startFontPx);
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const line of lines) expect(estimatorMeasurer(line, fontPx, 'Anton')).toBeLessThanOrEqual(baseOpts.maxWidthPx);
  });

  it('a single over-wide word is truncated with an ellipsis at the floor size', () => {
    const word = 'SUPERCALIFRAGILISTICEXPIALIDOCIOUSLONGWORD';
    const { lines, fontPx } = wrapPosterText(word, { ...baseOpts, maxLines: 2 });
    expect(fontPx).toBe(baseOpts.minFontPx);
    expect(lines.length).toBe(1);
    expect(lines[0].endsWith('…')).toBe(true);
    expect(estimatorMeasurer(lines[0], fontPx, 'Anton')).toBeLessThanOrEqual(baseOpts.maxWidthPx);
  });

  it('short text stays on one line at the start size', () => {
    const { lines, fontPx } = wrapPosterText('BIG NIGHT', { ...baseOpts, maxLines: 3 });
    expect(lines).toEqual(['BIG NIGHT']);
    expect(fontPx).toBe(110);
  });
});

describe('R23 WS1 — layout picking from band busyness', () => {
  it('thirdBusyness measures the covered fraction of each third', () => {
    const busy = thirdBusyness(makeAnalysis([{ y0: 0, y1: 1 / 3 }, { y0: 2 / 3, y1: 1 }]));
    expect(busy.top).toBeCloseTo(1, 6);
    expect(busy.bottom).toBeCloseTo(1, 6);
    const halfTop = thirdBusyness(makeAnalysis([{ y0: 0, y1: 1 / 6 }]));
    expect(halfTop.top).toBeCloseTo(0.5, 6);
    expect(halfTop.bottom).toBe(0);
    expect(thirdBusyness(makeAnalysis([]))).toEqual({ top: 0, bottom: 0 });
  });

  it('busy bottom / calm top picks T', () => {
    expect(pickPosterLayout(makeAnalysis([{ y0: 0.66, y1: 1 }]))).toBe('T');
  });

  it('busy top / calm bottom picks B', () => {
    expect(pickPosterLayout(makeAnalysis([{ y0: 0, y1: 0.34 }]))).toBe('B');
  });

  it('both busy picks B, and no bands picks B', () => {
    expect(pickPosterLayout(makeAnalysis([{ y0: 0, y1: 0.34 }, { y0: 0.66, y1: 1 }]))).toBe('B');
    expect(pickPosterLayout(makeAnalysis([]))).toBe('B');
  });
});

describe('R23 WS1 — renderPosterStillBlob', () => {
  for (const formatId of Object.keys(POSTER_FORMATS) as PosterFormatId[]) {
    const format = POSTER_FORMATS[formatId];
    it(`${formatId}: the canvas is sized exactly to the format and a PNG blob comes back`, async () => {
      const project = buildPosterProject(
        createDefaultProject('u', 'Poster', format.canvasWidth, format.canvasHeight),
        fakeAsset('photo', 1200, 900),
        null,
        { headline: 'Big night' },
        { layout: 'B' },
      );
      const fakeCanvas = {
        width: 0,
        height: 0,
        getContext: () => ({}),
        toBlob: (cb: (blob: Blob | null) => void) => cb(new Blob(['x'], { type: 'image/png' })),
      };
      let drawCalls = 0;
      const blob = await renderPosterStillBlob(
        project,
        { images: new Map() },
        {
          makeCanvas: () => fakeCanvas as unknown as HTMLCanvasElement,
          draw: () => { drawCalls++; },
        },
      );
      expect(fakeCanvas.width).toBe(format.canvasWidth);
      expect(fakeCanvas.height).toBe(format.canvasHeight);
      expect(drawCalls).toBe(1);
      expect(blob.type).toBe('image/png');
    });
  }
});
