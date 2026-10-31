import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * R27 WS-M5 — plain-words blocklist (standing test).
 * R34 WS-C / UX-35 — hardened: wider scan, split-string handling,
 * more tokens.
 *
 * User-facing copy must never leak internal / technical wording.
 * This scan is deliberately literal and case-sensitive: the tokens
 * below are the exact strings the plain-words passes removed, so a
 * regression is a copy regression, not a style debate.
 *
 * SCAN SCOPE (R34):
 *   - every .ts/.tsx under src/components/** (as before), plus
 *   - USER_COPY_LIB below: the lib modules whose strings reach
 *     users. This is a defined list on purpose — scanning all of
 *     src/lib would flag server/API internals that legitimately
 *     use technical words and never reach a screen.
 *
 * USER_COPY_LIB notes, per module:
 *   - lib/camera/lightMeter.ts — full scan. Its advice strings are
 *     rendered verbatim; after the R34 wording fix they are plain.
 *   - lib/camera/dualCapture.ts — full scan. Its failure-details
 *     string is diagnostics behind a "Why?" expander after R34,
 *     but it was checked first: it contains NO blocked token. It
 *     names platform error names (e.g. NotReadableError) and
 *     pairings / strategy names — none of those are blocked
 *     tokens, and they stay as field-report data.
 *   - lib/camera/captureReceipt.ts — scan with ONE documented
 *     region removed: the code between the
 *     BLOCKLIST-TECHNICAL-START / BLOCKLIST-TECHNICAL-END markers
 *     builds the technical line for the receipt's "Details"
 *     expander only (sanctioned expander content after R34
 *     UX-34 — the audit keeps the data, demoted behind the
 *     expander). Everything outside that region — i.e. the whole
 *     DEFAULT receipt surface — is scanned in full, and the plain
 *     surface's output is also asserted token-free at runtime in
 *     captureReceipt.test.ts.
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
 * acronym, so no word-boundary adjustment was needed for the
 * original set. One R34 tightening, recorded per the rule below:
 * ' Kbps' carries a leading space so it only fires on prose like
 * "850 Kbps", never on the `audioBitrateKbps` identifier in
 * ExportPanel.tsx (a pre-flight grep found that identifier as the
 * token's only component-tree occurrence outside comments).
 * If a future hit is an identifier false positive, tighten the
 * token here and record why — never just delete it.
 *
 * SPLIT STRINGS (R34): multi-word tokens ('element bands',
 * 'element band', '600 seconds') are ALSO matched against a
 * whitespace-removed copy of the file, so a phrase reassembled
 * across a line break — "element band" + newline + "s found" —
 * is caught even though the literal never occurs on one line.
 */
const BLOCKED_TOKENS = [
  'OCR',
  'verbatim',
  'H.264',
  'Mbps',
  'element bands',
  'element band',
  'HTTP ',
  '600 seconds',
  'VP9',
  'VP8',
  'AV1',
  ' Kbps',
] as const;

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const COMPONENTS_DIR = join(SRC_DIR, 'components');

/**
 * Lib modules whose strings reach users — see the header notes.
 *
 * R40 P-51 — the scan now covers every lib module that exports
 * user-facing message strings, not just the original three:
 *   camera: twoPass (flow headings/tips), motionCoach (coach pill),
 *     cameraControls (lock notes);
 *   export: exportErrors (plain error sentences), producerReport
 *     (the Producer's report lines), socialPosts (ready-to-paste
 *     post copy);
 *   media: uploadErrors, validate (file messages), probe (its
 *     timeout message was reworded into plain words for this scan —
 *     it named a codec before);
 *   promo: suggest (the suggestion bank), vision (read-outcome
 *     messages);
 *   transcription: clientErrors + errors (plain failure sentences);
 *   and: projectDurationGate (gate messages), pairLayout (pair
 *     warnings), pip (layout names), templates/reelMeta (card
 *     labels), legalCopy (the Privacy/Terms pages — Firebase/Google
 *     are named there because they really are the processors; that
 *     is honest naming, and no blocked token collides with it),
 *     capWarning, accessBlock, accountDeletion, licensing (plan
 *     words), projects/localDraft (the save-status line).
 *
 * Deliberately NOT scanned, with reasons:
 *   - lib/export/mediabunnyExporter.ts, lib/transcription/gemini.ts,
 *     lib/transcription/whisper.ts, lib/promo/ocrEngine.ts: engine /
 *     provider internals — their strings are diagnostics and
 *     provider payloads, never rendered as user copy (user-facing
 *     failures from those paths are reworded by exportErrors /
 *     transcription/errors, which ARE scanned).
 *   - lib/export/quality.ts: numeric encoder configuration; its
 *     only hits are identifier names (e.g. `baseVideoMbps`), not
 *     copy — its user-facing tier labels are plain one-word labels.
 */
const USER_COPY_LIB = [
  'lib/camera/captureReceipt.ts',
  'lib/camera/dualCapture.ts',
  'lib/camera/lightMeter.ts',
  'lib/camera/twoPass.ts',
  'lib/camera/motionCoach.ts',
  'lib/camera/cameraControls.ts',
  'lib/export/exportErrors.ts',
  'lib/export/producerReport.ts',
  'lib/export/socialPosts.ts',
  'lib/media/uploadErrors.ts',
  'lib/media/validate.ts',
  'lib/media/probe.ts',
  'lib/promo/suggest.ts',
  'lib/promo/vision.ts',
  'lib/transcription/clientErrors.ts',
  'lib/transcription/errors.ts',
  'lib/projectDurationGate.ts',
  'lib/pairLayout.ts',
  'lib/pip.ts',
  'lib/templates/reelMeta.ts',
  'lib/legalCopy.ts',
  'lib/capWarning.ts',
  'lib/accessBlock.ts',
  'lib/accountDeletion.ts',
  'lib/licensing.ts',
  'lib/projects/localDraft.ts',
] as const;

function collectComponentFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectComponentFiles(full));
    else if (entry.isFile() && (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts'))) files.push(full);
  }
  return files.sort();
}

/**
 * Remove the sanctioned technical-expander region (captureReceipt
 * only), preserving line numbers: marker lines and everything
 * between them become blank lines.
 */
function stripTechnicalRegion(source: string): string {
  let inRegion = false;
  return source
    .split('\n')
    .map((line) => {
      if (line.includes('BLOCKLIST-TECHNICAL-START')) {
        inRegion = true;
        return '';
      }
      if (line.includes('BLOCKLIST-TECHNICAL-END')) {
        inRegion = false;
        return '';
      }
      return inRegion ? '' : line;
    })
    .join('\n');
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

/** The text the scan actually sees: technical region out, comments out. */
function scannableText(source: string): string {
  return stripComments(stripTechnicalRegion(source));
}

function isMultiWordToken(token: string): boolean {
  return token.trim().includes(' ');
}

/**
 * Blocked tokens present in one piece of text, after comment /
 * technical-region stripping, including tokens reassembled across
 * whitespace. The singular 'element band' is reported only when
 * the plural has not already matched the same text (the plural
 * contains the singular — reporting both would double-count).
 */
function blockedTokensInText(source: string): string[] {
  const stripped = scannableText(source);
  const whitespaceRemoved = stripped.replace(/\s+/g, '');
  const found: string[] = [];
  for (const token of BLOCKED_TOKENS) {
    const rawHit = stripped.includes(token);
    const splitHit =
      isMultiWordToken(token) && whitespaceRemoved.includes(token.replace(/\s+/g, ''));
    if (rawHit || splitHit) found.push(token);
  }
  if (found.includes('element bands') && found.includes('element band')) {
    return found.filter((token) => token !== 'element band');
  }
  return found;
}

describe('copy blocklist matcher — split-string fixtures (R34 UX-35)', () => {
  it('flags a phrase split across a line break', () => {
    expect(blockedTokensInText('3 element band\ns found')).toContain('element bands');
    expect(blockedTokensInText('element\nbands found')).toContain('element bands');
    expect(blockedTokensInText('the limit is 600\nseconds')).toContain('600 seconds');
  });

  it('flags the singular form on its own', () => {
    expect(blockedTokensInText('1 element band found')).toContain('element band');
  });

  it('does not flag plain receipt copy', () => {
    expect(
      blockedTokensInText('Recorded: 1080p · 30fps · high quality\n12 seconds · 8.4 MB'),
    ).toEqual([]);
  });

  it('ignores the sanctioned technical-expander region, and nothing outside it', () => {
    const insideOnly = [
      'plain surface copy',
      '// BLOCKLIST-TECHNICAL-START',
      "return 'H.264';",
      '// BLOCKLIST-TECHNICAL-END',
    ].join('\n');
    expect(blockedTokensInText(insideOnly)).toEqual([]);
    expect(blockedTokensInText("return 'H.264';")).toContain('H.264');
  });
});

describe('R27 WS-M5 copy blocklist — components + user-copy lib carries no internal wording', () => {
  const files = [
    ...collectComponentFiles(COMPONENTS_DIR),
    ...USER_COPY_LIB.map((rel) => join(SRC_DIR, rel)),
  ];

  it('finds component sources to scan', () => {
    expect(files.length, 'copy blocklist scanned no files — the components path is wrong').toBeGreaterThan(0);
  });

  it('finds every user-copy lib module to scan', () => {
    for (const rel of USER_COPY_LIB) {
      expect(existsSync(join(SRC_DIR, rel)), `user-copy lib module missing: ${rel}`).toBe(true);
    }
  });

  it('contains none of the blocked tokens outside comments', () => {
    const violations: string[] = [];
    for (const file of files) {
      const rel = relative(join(SRC_DIR, '..'), file);
      const stripped = scannableText(readFileSync(file, 'utf8'));
      const lines = stripped.split('\n');
      const lineFlagged = new Set<string>();
      lines.forEach((line, i) => {
        for (const token of BLOCKED_TOKENS) {
          if (!line.includes(token)) continue;
          // The plural contains the singular — report the line once.
          if (token === 'element band' && line.includes('element bands')) continue;
          lineFlagged.add(token);
          violations.push(
            `${rel}:${i + 1} contains blocked token "${token}" — user-facing copy must use plain words (line: ${line.trim()})`,
          );
        }
      });
      // Split-string pass: a multi-word phrase reassembled across
      // whitespace never occurs on a single line, so check the
      // whitespace-removed whole file for any token not already
      // reported line-by-line for this file.
      const whitespaceRemoved = stripped.replace(/\s+/g, '');
      for (const token of BLOCKED_TOKENS) {
        if (!isMultiWordToken(token) || lineFlagged.has(token)) continue;
        if (token === 'element band' && lineFlagged.has('element bands')) continue;
        if (whitespaceRemoved.includes(token.replace(/\s+/g, ''))) {
          violations.push(
            `${rel} contains blocked token "${token}" split across whitespace — user-facing copy must use plain words`,
          );
        }
      }
    }
    expect(
      violations,
      `Blocked copy token(s) found in scanned surfaces:\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
