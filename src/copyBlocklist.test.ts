import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * R27 WS-M5 — plain-words blocklist (standing test).
 *
 * User-facing copy in src/components must never leak internal /
 * technical wording. This scan is deliberately literal and
 * case-sensitive: the tokens below are the exact strings the
 * plain-words pass removed, so a regression is a copy regression,
 * not a style debate.
 *
 * Comments are NOT copy, so they are stripped before scanning:
 *   - every /* ... *\/ block (replaced with spaces, newlines kept,
 *     so reported line numbers still match the real file), and
 *   - any line whose first non-whitespace characters are `//`
 *     (line comment) or `*` (JSDoc / block-comment continuation).
 * Known comment occurrences of these tokens exist in the tree and
 * are fine — they are documentation for developers, never rendered.
 *
 * Matching note: tokens are matched as plain substrings on purpose.
 * Every token was chosen to be a complete user-facing phrase or
 * acronym (e.g. 'HTTP ' carries its trailing space so it only fires
 * on prose like "HTTP 500", never on an identifier), so no
 * word-boundary adjustment was needed: a pre-flight scan of the
 * stripped tree produced zero hits and zero identifier false
 * positives. If a future hit is an identifier false positive,
 * tighten the token here and record why — never just delete it.
 */
const BLOCKED_TOKENS = [
  'OCR',
  'verbatim',
  'H.264',
  'Mbps',
  'element bands',
  'HTTP ',
  '600 seconds',
] as const;

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const COMPONENTS_DIR = join(SRC_DIR, 'components');

function collectComponentFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectComponentFiles(full));
    else if (entry.isFile() && (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts'))) files.push(full);
  }
  return files.sort();
}

/** Strip comments per the rules in the header, preserving line numbers. */
function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, ' '),
  );
  return withoutBlocks
    .split('\n')
    .map((line) => {
      const first = line.trimStart();
      return first.startsWith('//') || first.startsWith('*') ? '' : line;
    })
    .join('\n');
}

describe('R27 WS-M5 copy blocklist — src/components carries no internal wording', () => {
  const files = collectComponentFiles(COMPONENTS_DIR);

  it('finds component sources to scan', () => {
    expect(files.length, 'copy blocklist scanned no files — the components path is wrong').toBeGreaterThan(0);
  });

  it('contains none of the blocked tokens outside comments', () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = relative(join(SRC_DIR, '..'), file);
      const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        for (const token of BLOCKED_TOKENS) {
          if (line.includes(token)) {
            violations.push(
              `${rel}:${i + 1} contains blocked token "${token}" — user-facing copy must use plain words (line: ${line.trim()})`,
            );
          }
        }
      });
    }
    expect(
      violations,
      `Blocked copy token(s) found in src/components:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
