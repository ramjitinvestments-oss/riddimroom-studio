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
