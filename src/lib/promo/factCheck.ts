/**
 * R21 — the factual receipt. After a campaign is built from a website
 * profile, every piece's words (and the social post) are scanned for
 * factual tokens — prices, dates, phone fragments, any meaningful
 * digit string — and each token must trace to the approved record
 * (confirmed profile fields, offer facts, or the user's own confirmed
 * field texts). Anything unmatched is flagged by name and piece.
 *
 * The check never blocks an export and never edits a word. It makes
 * accuracy visible: the "Facts checked against your website" line is
 * earned only at zero flags.
 */
import type { ApprovedFacts } from './siteProfile';

export interface FactToken {
  raw: string;
  digits: string;
  hasDollar: boolean;
}

export interface FactFlag {
  label: string;
  token: string;
  context: string;
}

export interface FactReceipt {
  clean: boolean;
  flags: FactFlag[];
  checkedTexts: number;
  summaryLine: string;
}

const TOKEN_RE = /\$?\d[\d,./:-]*\d|\$\d|\d/g;
const PHONE_TOKEN_RE = /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g;

export function factTokens(text: string): FactToken[] {
  const out: FactToken[] = [];
  const push = (raw: string) => {
    const digits = raw.replace(/\D/g, '');
    const hasDollar = raw.includes('$');
    // Bare 1–2 digit numbers are usually counts/ordinals in creative
    // copy ("DAY 1", "TOP 5") — factual weight starts at 3 digits,
    // or at any length when a $ makes it a price.
    if (digits.length < 3 && !hasDollar) return;
    if (!out.some((t) => t.raw === raw)) out.push({ raw, digits, hasDollar });
  };
  // Phone-shaped sequences are single factual tokens first, so a
  // wrong number is flagged whole instead of as fragments (some of
  // which — like an area code — would match the approved record).
  const phoneSpans: Array<[number, number]> = [];
  for (const m of text.matchAll(PHONE_TOKEN_RE)) {
    push(m[0]);
    phoneSpans.push([m.index, m.index + m[0].length]);
  }
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index;
    if (phoneSpans.some(([a, b]) => start >= a && start < b)) continue;
    push(m[0]);
  }
  return out;
}

interface ApprovedIndex {
  /** Every approved digit-token, verbatim-normalized. */
  tokens: Set<string>;
  /** Full digit concatenation of each approved string. */
  streams: string[];
}

function buildIndex(approved: ApprovedFacts, extraApprovedTexts: string[]): ApprovedIndex {
  const tokens = new Set<string>();
  const streams: string[] = [];
  for (const s of [...approved.allText, ...extraApprovedTexts]) {
    const stream = s.replace(/\D/g, '');
    if (stream) streams.push(stream);
    for (const t of factTokens(s)) tokens.add(t.digits);
    // Prices/dates written as one number ("24", "2026") still register.
    for (const m of s.matchAll(/\d+/g)) tokens.add(m[0]);
  }
  return { tokens, streams };
}

function tokenApproved(token: FactToken, index: ApprovedIndex): boolean {
  if (index.tokens.has(token.digits)) return true;
  // A token split differently than the source wrote it ("555-0147"
  // from "(512) 555-0147") still traces if it sits inside one
  // approved string's digit stream — or contains an approved token.
  return index.streams.some(
    (stream) => stream.includes(token.digits) || (token.digits.length >= 6 && token.digits.includes(stream) && stream.length >= 6),
  );
}

export function checkFactTexts(
  entries: Array<{ label: string; texts: string[] }>,
  approved: ApprovedFacts,
  extraApprovedTexts: string[] = [],
): FactReceipt {
  const index = buildIndex(approved, extraApprovedTexts);
  const flags: FactFlag[] = [];
  let checkedTexts = 0;
  for (const entry of entries) {
    for (const text of entry.texts) {
      if (!text || !text.trim()) continue;
      checkedTexts += 1;
      for (const token of factTokens(text)) {
        if (!tokenApproved(token, index)) {
          flags.push({ label: entry.label, token: token.raw, context: text });
        }
      }
    }
  }
  return {
    clean: flags.length === 0,
    flags,
    checkedTexts,
    summaryLine: flags.length === 0
      ? 'Facts checked against your website'
      : `${flags.length} factual item${flags.length === 1 ? '' : 's'} to review`,
  };
}

/** True when every factual token in a line traces to the approved record. */
export function lineFactsApproved(line: string, approved: ApprovedFacts, extraApprovedTexts: string[] = []): boolean {
  return checkFactTexts([{ label: 'line', texts: [line] }], approved, extraApprovedTexts).clean;
}
