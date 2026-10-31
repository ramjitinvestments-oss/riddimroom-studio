import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideReelCardTap, resolveReelFocusedId } from './reelFocus';

describe('R40 P-08 — reel focus moves only on a tap', () => {
  it('tapping an unfocused card only focuses it — it does not apply', () => {
    expect(decideReelCardTap('card-a', 'card-b')).toEqual({ action: 'focus', focusedId: 'card-b' });
    expect(decideReelCardTap(null, 'card-b')).toEqual({ action: 'focus', focusedId: 'card-b' });
  });

  it('tapping the focused card applies THAT card', () => {
    expect(decideReelCardTap('card-b', 'card-b')).toEqual({ action: 'apply', focusedId: 'card-b' });
  });

  it('the tapped card stays focused even if the strip order changes afterwards (a scroll)', () => {
    // The user taps card-b; the strip then scrolls so card-c leads the
    // visible order. Resolving focus for display must still return the
    // tapped card — visibility order is not an input to focus.
    const { focusedId } = decideReelCardTap('card-a', 'card-b');
    expect(resolveReelFocusedId(focusedId, ['card-c', 'card-b', 'card-a'])).toBe('card-b');
    expect(resolveReelFocusedId(focusedId, ['card-b', 'card-c'])).toBe('card-b');
  });

  it('a second tap after scrolling still applies the originally tapped card', () => {
    const first = decideReelCardTap(null, 'card-b');
    // Any amount of scrolling happens here — it has no decision to call.
    const second = decideReelCardTap(first.focusedId, 'card-b');
    expect(second).toEqual({ action: 'apply', focusedId: 'card-b' });
  });

  it('display resolution falls back to the first visible card without moving stored focus', () => {
    expect(resolveReelFocusedId('gone', ['card-x', 'card-y'])).toBe('card-x');
    expect(resolveReelFocusedId(null, ['card-x'])).toBe('card-x');
    expect(resolveReelFocusedId(null, [])).toBeNull();
    // The fallback is a read: the stored id is untouched by resolving.
    expect(resolveReelFocusedId('gone', ['card-x'])).toBe('card-x');
  });

  it('the panel component has no IntersectionObserver left to steal focus', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '..', '..', 'components', 'Editor', 'TemplatesPanel.tsx'), 'utf8');
    // Strip comments the way the copy-blocklist scan does, so the
    // explanatory P-08 comment in the panel cannot false-positive.
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join('\n');
    expect(codeOnly).not.toContain('IntersectionObserver');
    expect(codeOnly).toContain('decideReelCardTap');
  });
});
