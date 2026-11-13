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

describe('R45 follow-up — social share preview (Open Graph)', () => {
  const html = readFileSync(join(SRC, '..', 'index.html'), 'utf8');
  const decode = readFileSync(join(SRC, '..', 'scripts', 'decode-logo.mjs'), 'utf8');

  it('index.html og:image references the medallion share asset on the production origin', () => {
    expect(html).toContain(
      '<meta property="og:image" content="https://riddimroom-studio.vercel.app/og-share-1200x630.png" />',
    );
    expect(html).toContain(
      '<meta name="twitter:image" content="https://riddimroom-studio.vercel.app/og-share-1200x630.png" />',
    );
  });

  it('the share asset travels the base64 decode route into public/', () => {
    expect(decode).toContain("'og-share-1200x630.png'");
    const payload = readFileSync(join(SRC, 'assets', 'og-share-1200x630.png.b64'), 'utf8');
    const bytes = Buffer.from(payload.trim(), 'base64');
    // 1200x630 PNG, byte size of the owner-set source of record.
    expect(bytes.length).toBe(530870);
    expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(bytes.readUInt32BE(16)).toBe(1200);
    expect(bytes.readUInt32BE(20)).toBe(630);
  });
});

describe('R45 Phase 2 — chrome colour system (index.css tokens)', () => {
  const css = readFileSync(join(SRC, 'index.css'), 'utf8');

  it('Riddim Gold #D4A437 is the primary gold token', () => {
    expect(css).toContain('--color-gold: #d4a437;');
    expect(css).toContain('--color-gold-bright: #ffe45c;');
    expect(css).toContain('--color-cream: #f4ede1;');
  });

  it('#FFD100 survives only as the signal token', () => {
    expect(css).toContain('--color-signal: #ffd100;');
    expect(css).not.toContain('--color-gold: #ffd100;');
    expect(css).not.toContain('background: #ffd100;');
    expect(css).not.toContain('accent-color: #ffd100;');
  });

  it('the base ground is Rich Black #0B0B0C', () => {
    expect(css).toContain('background: #0b0b0c;');
  });
});
