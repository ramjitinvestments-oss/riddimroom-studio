/**
 * R45 Phase 1 — medallion brand guards (source-level).
 *
 * The owner-designed gold-ring medallion (adopted 2026-10-26, Style
 * Sheet §3) is the only brand mark the app may show. The retired
 * 2026-10-13 mark and its asset must never be referenced from source
 * or from the index.html favicon line again.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');
const read = (rel: string) => readFileSync(join(HERE, rel), 'utf8');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('R45 Phase 1 — medallion is the brand mark', () => {
  const brandLogo = read('BrandLogo.tsx');

  it('BrandLogo renders the medallion assets', () => {
    expect(brandLogo).toContain('/medallion-96.png');
    expect(brandLogo).toContain('/medallion-hero.png');
  });

  it('BrandLogo carries the real text wordmark (RiddimRoom + Studio)', () => {
    expect(brandLogo).toContain('RiddimRoom');
    expect(brandLogo).toContain('Studio');
    expect(brandLogo).toContain("'hero'");
  });

  it('no source file references the retired mark or its asset', () => {
    const offenders = walk(SRC)
      .filter((p) => /\.(ts|tsx|css)$/.test(p) && !p.endsWith('r45Medallion.test.ts'))
      .filter((p) => {
        const s = readFileSync(p, 'utf8');
        return s.includes('logo.jpg') || /soundwave/i.test(s);
      });
    expect(offenders).toEqual([]);
  });

  it('index.html favicon points at the medallion favicon, and nothing else changed about the icon', () => {
    const html = readFileSync(join(SRC, '..', 'index.html'), 'utf8');
    expect(html).toContain('<link rel="icon" type="image/png" href="/favicon-512.png" />');
    expect(html).not.toContain('logo.jpg');
  });
});
