import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * R27 WS-M8 — target-size / geometry audit (standing test).
 *
 * These assertions pin the exact R27 touch and geometry tokens in
 * the real source files, so a future restyle cannot silently shrink
 * a decision control, a timeline row, a trim grip, or a slider thumb
 * back below the mobile target sizes — and cannot drop the safe-area
 * / viewport plumbing the fixed mobile bars depend on. Each failure
 * message names the file and the token that was expected.
 */
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SRC_DIR, '..');

function readRepoFile(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

describe('R27 target-size audit', () => {
  it('src/components/PromoPage.tsx: the chipCls definition includes min-h-11 (44px decision chips)', () => {
    const source = readRepoFile('src/components/PromoPage.tsx');
    const chipClsAt = source.indexOf('chipCls');
    expect(
      chipClsAt,
      'src/components/PromoPage.tsx: expected a chipCls definition, found none',
    ).toBeGreaterThan(-1);
    const definition = source.slice(chipClsAt, chipClsAt + 400);
    expect(
      definition.includes('min-h-11'),
      'src/components/PromoPage.tsx: expected the chipCls definition to include "min-h-11"',
    ).toBe(true);
  });

  it('src/components/Editor/TimelinePanel.tsx: mobile timeline rows are h-11 lg:h-8 (44px on mobile)', () => {
    const source = readRepoFile('src/components/Editor/TimelinePanel.tsx');
    expect(
      source.includes('h-11 lg:h-8'),
      'src/components/Editor/TimelinePanel.tsx: expected "h-11 lg:h-8" (mobile 44px timeline rows)',
    ).toBe(true);
  });

  it('src/components/Editor/TimelinePanel.tsx: trim-grip hit area is w-6 (24px touch width)', () => {
    const source = readRepoFile('src/components/Editor/TimelinePanel.tsx');
    expect(
      source.includes('w-6'),
      'src/components/Editor/TimelinePanel.tsx: expected the trim-grip hit area "w-6"',
    ).toBe(true);
  });

  it('src/index.css: the ::-webkit-slider-thumb rule sets width: 20px', () => {
    const css = readRepoFile('src/index.css');
    const selectorAt = css.indexOf('::-webkit-slider-thumb');
    expect(
      selectorAt,
      'src/index.css: expected a ::-webkit-slider-thumb rule, found none',
    ).toBeGreaterThan(-1);
    const openBrace = css.indexOf('{', selectorAt);
    const closeBrace = css.indexOf('}', openBrace);
    expect(
      openBrace > -1 && closeBrace > openBrace,
      'src/index.css: could not parse the ::-webkit-slider-thumb rule block',
    ).toBe(true);
    const block = css.slice(openBrace, closeBrace);
    expect(
      /width:\s*20px/.test(block),
      'src/index.css: expected the ::-webkit-slider-thumb rule block to set "width: 20px"',
    ).toBe(true);
  });

  it('src/components/Editor/EditorShell.tsx: the mobile bottom bar pads for env(safe-area-inset-bottom)', () => {
    const source = readRepoFile('src/components/Editor/EditorShell.tsx');
    expect(
      source.includes('env(safe-area-inset-bottom)'),
      'src/components/Editor/EditorShell.tsx: expected "env(safe-area-inset-bottom)"',
    ).toBe(true);
  });

  it('index.html: the viewport meta includes viewport-fit=cover', () => {
    const html = readRepoFile('index.html');
    expect(
      html.includes('viewport-fit=cover'),
      'index.html: expected "viewport-fit=cover" in the viewport meta',
    ).toBe(true);
  });
});

describe('R40 P-15/P-16 — camera capture row + settings sheet', () => {
  const camera = () => readRepoFile('src/components/Editor/CameraCapture.tsx');

  it('the capture row is 44px: Record, Stop, Photo, Flip and Close all carry min-h-11', () => {
    const source = camera();
    const pins: Array<[string, string]> = [
      ['Record (gold)', 'min-h-11 px-5 inline-flex items-center justify-center text-xs font-bold uppercase tracking-wide bg-gold'],
      ['Stop (red)', 'min-h-11 px-5 inline-flex items-center justify-center text-xs font-bold uppercase tracking-wide bg-red-600'],
      ['Photo', 'min-h-11 px-5 inline-flex items-center justify-center text-xs font-bold uppercase tracking-wide bg-white/10'],
      ['Flip camera', 'min-h-11 px-4 inline-flex items-center justify-center text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 disabled:opacity-40 rounded-lg text-white'],
      ['Close', 'min-h-11 px-4 inline-flex items-center justify-center text-xs font-bold uppercase tracking-wide bg-white/5'],
    ];
    for (const [label, token] of pins) {
      expect(source.includes(token), `CameraCapture.tsx: expected the ${label} control to carry "${token}"`).toBe(true);
    }
    // The old ~32px capture-row sizing must not come back.
    expect(source.includes('px-4 py-2 text-xs font-bold uppercase tracking-wide bg-gold')).toBe(false);
    expect(source.includes('px-3 py-2 text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 disabled:opacity-40 rounded-lg text-white')).toBe(false);
  });

  it('the pre-Record controls render inside the one Camera settings sheet, whose rows are 44px', () => {
    const source = camera();
    const sheetAt = source.indexOf('data-camera-settings-sheet');
    expect(sheetAt, 'CameraCapture.tsx: expected a data-camera-settings-sheet element').toBeGreaterThan(-1);
    const sheet = source.slice(sheetAt, sheetAt + 9000);
    for (const label of ['Capture quality', 'Frame rate', 'Guides', 'Steady start', 'Level', 'Test my camera']) {
      expect(sheet.includes(label), `CameraCapture.tsx: expected "${label}" inside the settings sheet`).toBe(true);
    }
    const sheetTargets = sheet.split('min-h-11').length - 1;
    expect(sheetTargets, 'CameraCapture.tsx: expected the sheet rows/chips to carry min-h-11 throughout').toBeGreaterThanOrEqual(8);
    // The settings controls exist ONLY inside the sheet (one instance each).
    expect(source.split('aria-label="Capture quality"').length - 1).toBe(1);
    expect(source.split('aria-label="Frame rate"').length - 1).toBe(1);
    expect(source.indexOf('aria-label="Capture quality"')).toBeGreaterThan(sheetAt);
    expect(source.indexOf('onClick={() => setShowGuides')).toBeGreaterThan(sheetAt);
    expect(source.indexOf('onClick={toggleSteadyStart}')).toBeGreaterThan(sheetAt);
  });

  it('the surface keeps only the essentials: a Camera settings button plus Lock, Flashlight and Selfie light at 44px', () => {
    const source = camera();
    expect(source.includes('setCameraSettingsOpen(true)')).toBe(true);
    expect(source.includes('Camera settings')).toBe(true);
    // The essentials stayed on the surface (outside the sheet).
    const sheetAt = source.indexOf('data-camera-settings-sheet');
    const surface = source.slice(0, sheetAt) + source.slice(sheetAt + 9000);
    for (const label of ['Lock focus & light', 'Flashlight', 'Selfie light']) {
      expect(surface.includes(label), `CameraCapture.tsx: expected "${label}" to stay on the surface`).toBe(true);
    }
    const lockAt = source.indexOf('Lock focus & light');
    expect(source.slice(Math.max(0, lockAt - 700), lockAt).includes('min-h-11')).toBe(true);
  });
});
