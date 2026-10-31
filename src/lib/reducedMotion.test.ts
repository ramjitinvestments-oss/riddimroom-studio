import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prefersReducedMotion, reelCrossfadeAllowed, REDUCED_MOTION_QUERY } from './reducedMotion';

/**
 * R40 P-18 — reduced motion: the helper's logic, the CSS block's
 * presence (source pin), and the reel crossfade's consultation of the
 * helper (source pin, the repo's pattern for DOM-side behaviour).
 */

describe('prefersReducedMotion', () => {
  it('reports the preference when the media query matches', () => {
    expect(prefersReducedMotion({ matches: true })).toBe(true);
    expect(prefersReducedMotion({ matches: false })).toBe(false);
  });

  it('no injected query and no window (node/tests) reads as no preference', () => {
    expect(prefersReducedMotion(null)).toBe(false);
    expect(prefersReducedMotion(undefined)).toBe(false);
  });

  it('the query is the standard reduced-motion query', () => {
    expect(REDUCED_MOTION_QUERY).toBe('(prefers-reduced-motion: reduce)');
  });
});

describe('reelCrossfadeAllowed', () => {
  it('cycles only with more than one frame and no reduced-motion preference', () => {
    expect(reelCrossfadeAllowed(3, false)).toBe(true);
    expect(reelCrossfadeAllowed(3, true)).toBe(false);
    expect(reelCrossfadeAllowed(1, false)).toBe(false);
    expect(reelCrossfadeAllowed(0, false)).toBe(false);
  });
});

describe('reduced-motion wiring (source pins)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(join(here, '..', 'index.css'), 'utf8');
  const templates = readFileSync(join(here, '..', 'components', 'Editor', 'TemplatesPanel.tsx'), 'utf8');

  it('index.css carries the prefers-reduced-motion block, calming transitions and the REC pulse', () => {
    const at = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, at + 1200);
    expect(block.includes('transition-duration')).toBe(true);
    expect(block.includes('.animate-pulse')).toBe(true);
    expect(block.includes('animation: none')).toBe(true);
  });

  it('the reel preview consults the helper before starting its crossfade cycle', () => {
    expect(templates.includes('prefersReducedMotion')).toBe(true);
    expect(templates.includes('reelCrossfadeAllowed')).toBe(true);
  });
});
