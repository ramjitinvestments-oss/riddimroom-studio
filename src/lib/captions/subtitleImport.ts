/**
 * RiddimRoom Studio — caption file import (SRT / ASS / SSA).
 *
 * The reverse of `export.ts`: creators who already have captions (from
 * YouTube, another editor, a transcription service) bring them in instead
 * of retyping. Parsed cues land in the SAME caption model transcription
 * uses — `CaptionTimelineItem`s created by `addCaptionItems` — so imported
 * captions are ordinary, fully editable cues afterwards, indistinguishable
 * from transcribed ones except `source: 'manual'`.
 *
 * Clean-room note: both parsers were written from the published format
 * descriptions (SRT block layout; ASS [Events] Dialogue field order).
 * No code was copied from any other editor.
 */

import type { CaptionWordTiming, Project } from '../../types/timeline';
import { addCaptionItems } from '../timeline/insert';
import type { Cue } from './export';

export type SubtitleFormat = 'srt' | 'ass';

export interface SubtitleImportResult {
  cues: Cue[];
  /** Malformed entries that were skipped (never fatal). */
  skippedCount: number;
  format: SubtitleFormat;
}

/** Thrown for the honest-failure cases: empty file, unknown format, or no valid cues at all. */
export class SubtitleImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubtitleImportError';
  }
}

// ---------------------------------------------------------------------------
// Time parsing
// ---------------------------------------------------------------------------

/** "123" -> fraction-of-a-second milliseconds, tolerating 1–3 digits ("5" = 500ms). */
function fractionToMs(digits: string): number {
  return Number((digits + '000').slice(0, 3));
}

const SRT_TIME_RE = /^(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/;
const SRT_TIMING_LINE_RE = /^(\d+:\d{1,2}:\d{1,2}[,.]\d{1,3})\s*-->\s*(\d+:\d{1,2}:\d{1,2}[,.]\d{1,3})/m;
const ASS_TIME_RE = /^(\d+):(\d{1,2}):(\d{1,2})\.(\d{1,3})$/;

function srtTimeToSeconds(value: string): number | null {
  const m = SRT_TIME_RE.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + fractionToMs(m[4]) / 1000;
}

function assTimeToSeconds(value: string): number | null {
  const m = ASS_TIME_RE.exec(value.trim());
  if (!m) return null;
  // ASS times carry centiseconds; fractionToMs also tolerates 1-digit input.
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + fractionToMs(m[4]) / 1000;
}

// ---------------------------------------------------------------------------
// Format detection (extension first, content sniff second)
// ---------------------------------------------------------------------------

export function detectSubtitleFormat(content: string, fileName?: string): SubtitleFormat | null {
  const ext = fileName?.toLowerCase().split('.').pop();
  if (ext === 'srt') return 'srt';
  if (ext === 'ass' || ext === 'ssa') return 'ass';
  const head = content.slice(0, 8192);
  if (/\[Events\]/i.test(head) || /^Dialogue:/im.test(head)) return 'ass';
  if (SRT_TIMING_LINE_RE.test(head)) return 'srt';
  return null;
}

// ---------------------------------------------------------------------------
// SRT
// ---------------------------------------------------------------------------

function parseSrt(content: string): SubtitleImportResult {
  const lines = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const cues: Cue[] = [];
  let skippedCount = 0;

  let current: { start: number; end: number; textLines: string[] } | null = null;
  let orphanText = false; // non-index text seen while no cue is open

  const finalize = () => {
    if (current) {
      const text = current.textLines.join('\n').trim();
      if (!text || current.end <= current.start) skippedCount += 1;
      else cues.push({ start: current.start, end: current.end, text });
      current = null;
    } else if (orphanText) {
      skippedCount += 1; // a text block with no timing line at all
    }
    orphanText = false;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const timing = SRT_TIMING_LINE_RE.exec(line.trim());
    if (timing) {
      finalize();
      const start = srtTimeToSeconds(timing[1]);
      const end = srtTimeToSeconds(timing[2]);
      if (start === null || end === null) {
        skippedCount += 1;
      } else {
        current = { start, end, textLines: [] };
      }
      continue;
    }
    if (line.trim() === '') {
      finalize();
      continue;
    }
    if (current) {
      current.textLines.push(line);
    } else if (!/^\d+$/.test(line.trim())) {
      // A bare number before a timing line is the cue index — not orphan text.
      orphanText = true;
    }
  }
  finalize();

  return { cues: sortCues(cues), skippedCount, format: 'srt' };
}

// ---------------------------------------------------------------------------
// ASS / SSA
// ---------------------------------------------------------------------------

/** Splits a Dialogue payload into at most `count` fields; the LAST field keeps any remaining commas. */
function splitAssFields(payload: string, count: number): string[] {
  const fields: string[] = [];
  let rest = payload;
  for (let i = 0; i < count - 1; i += 1) {
    const idx = rest.indexOf(',');
    if (idx === -1) break;
    fields.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  fields.push(rest);
  return fields;
}

/** ASS text cleanup: `\N`/`\n` -> newline, `\h` -> space, override tags `{...}` removed. */
function cleanAssText(raw: string): string {
  return raw
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ')
    .trim();
}

function parseAss(content: string): SubtitleImportResult {
  const lines = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const cues: Cue[] = [];
  let skippedCount = 0;

  // Standard Dialogue field order when a [Events] Format line doesn't say otherwise.
  let fieldOrder = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];
  let inEvents = false;
  let sawEventsHeader = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      inEvents = section[1].trim().toLowerCase() === 'events';
      if (inEvents) sawEventsHeader = true;
      continue;
    }
    if (sawEventsHeader && !inEvents) continue;
    if (/^Format:/i.test(line) && (inEvents || !sawEventsHeader)) {
      const parsed = line.slice(line.indexOf(':') + 1).split(',').map((f) => f.trim());
      if (parsed.length >= 3) fieldOrder = parsed;
      continue;
    }
    if (!/^Dialogue:/i.test(line)) continue;

    const payload = line.slice(line.indexOf(':') + 1).replace(/^\s/, '');
    const fields = splitAssFields(payload, fieldOrder.length);
    const startIdx = fieldOrder.findIndex((f) => f.toLowerCase() === 'start');
    const endIdx = fieldOrder.findIndex((f) => f.toLowerCase() === 'end');
    const textIdx = fieldOrder.length - 1; // Text is always the last field.
    if (startIdx === -1 || endIdx === -1 || fields.length <= Math.max(startIdx, endIdx, textIdx)) {
      skippedCount += 1;
      continue;
    }
    const start = assTimeToSeconds(fields[startIdx]);
    const end = assTimeToSeconds(fields[endIdx]);
    const text = cleanAssText(fields[textIdx] ?? '');
    if (start === null || end === null || end <= start || !text) {
      skippedCount += 1;
      continue;
    }
    cues.push({ start, end, text });
  }

  return { cues: sortCues(cues), skippedCount, format: 'ass' };
}

function sortCues(cues: Cue[]): Cue[] {
  return [...cues].sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parses subtitle file content (.srt / .ass / .ssa) into timeline cues.
 * Malformed entries are skipped and counted. Throws `SubtitleImportError`
 * with a specific, user-readable message for an empty file, an
 * unrecognized format, or a file with no valid cues.
 */
export function parseSubtitleFile(content: string, fileName?: string): SubtitleImportResult {
  if (!content || !content.trim()) {
    throw new SubtitleImportError('That subtitle file is empty.');
  }
  const format = detectSubtitleFormat(content, fileName);
  if (!format) {
    throw new SubtitleImportError('That file is not a subtitle file Studio can read — use an .srt or .ass file.');
  }
  const result = format === 'srt' ? parseSrt(content) : parseAss(content);
  if (result.cues.length === 0) {
    throw new SubtitleImportError(
      `No usable captions were found in that ${format === 'srt' ? 'SRT' : 'ASS'} file${result.skippedCount > 0 ? ` (${result.skippedCount} malformed ${result.skippedCount === 1 ? 'entry was' : 'entries were'} skipped)` : ''}.`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Application to the project (the same path transcription output uses)
// ---------------------------------------------------------------------------

/**
 * Splits one cue's text into word timings across its duration (even slices —
 * the file carries no word timing, and the editor lets the user adjust
 * afterwards). Timings are relative to the cue's own start, which is the
 * shape `addCaptionItems` expects.
 */
export function cueToWords(cue: Cue): CaptionWordTiming[] {
  const tokens = cue.text.split(/\s+/).filter(Boolean);
  const duration = Math.max(0, cue.end - cue.start);
  if (tokens.length === 0 || duration <= 0) return [];
  const slice = duration / tokens.length;
  return tokens.map((text, i) => ({
    text,
    start: i * slice,
    end: (i + 1) * slice,
  }));
}

/**
 * Replaces the project's caption set with imported cues, applied one cue
 * per caption item through `addCaptionItems` — the exact function
 * transcription results flow through (`source: 'manual'`, the default
 * 'classic' style, like a manual/transcribed caption set). Each file cue
 * stays a single caption item (no 4s re-chunking), so an imported set
 * re-exports to the same cues it arrived as.
 */
export function applyImportedCaptions(project: Project, cues: Cue[]): Project {
  let next: Project = { ...project, items: project.items.filter((item) => item.type !== 'caption') };
  for (const cue of cues) {
    const words = cueToWords(cue);
    if (words.length === 0) continue;
    next = addCaptionItems(next, {
      words,
      atTime: cue.start,
      captionStyleId: 'classic',
      source: 'manual',
      maxCueDurationSeconds: Number.POSITIVE_INFINITY,
    });
  }
  return next;
}
