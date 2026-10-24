import { describe, it, expect } from 'vitest';
import { applyImportedCaptions, cueToWords, detectSubtitleFormat, parseSubtitleFile, SubtitleImportError } from './subtitleImport';
import { captionsToSRT, collectCues } from './export';
import { addCaptionItems } from '../timeline/insert';
import { addTrack, createEmptyProject, createTrack } from '../timeline/utils';
import type { CaptionTimelineItem, Project } from '../../types/timeline';

function projectWithCaptionTrack(): Project {
  let project = createEmptyProject({ ownerUid: 'test-uid' });
  project = addTrack(project, createTrack('caption', 'Captions', 0));
  return project;
}

function captionItemsOf(project: Project): CaptionTimelineItem[] {
  return project.items.filter((i) => i.type === 'caption') as CaptionTimelineItem[];
}

describe('SRT parsing', () => {
  it('parses basic cues with millisecond timing', () => {
    const result = parseSubtitleFile('1\n00:00:01,000 --> 00:00:02,500\nHello there\n\n2\n00:01:01,500 --> 00:01:03,000\nSecond cue\n', 'a.srt');
    expect(result.format).toBe('srt');
    expect(result.skippedCount).toBe(0);
    expect(result.cues).toEqual([
      { start: 1, end: 2.5, text: 'Hello there' },
      { start: 61.5, end: 63, text: 'Second cue' },
    ]);
  });

  it('joins multi-line cue text with newlines', () => {
    const result = parseSubtitleFile('1\n00:00:00,000 --> 00:00:02,000\nline one\nline two\n', 'a.srt');
    expect(result.cues).toEqual([{ start: 0, end: 2, text: 'line one\nline two' }]);
  });

  it('tolerates CRLF line endings and a BOM', () => {
    const content = '\uFEFF1\r\n00:00:00,500 --> 00:00:01,500\r\nFirst line\r\nsecond line\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\nNext\r\n';
    const result = parseSubtitleFile(content, 'a.srt');
    expect(result.cues).toEqual([
      { start: 0.5, end: 1.5, text: 'First line\nsecond line' },
      { start: 2, end: 3, text: 'Next' },
    ]);
  });

  it('skips and counts malformed entries (bad range, orphan text) without failing', () => {
    const content = [
      '1', '00:00:01,000 --> 00:00:02,000', 'Good cue', '',
      '2', '00:00:03,000 --> 00:00:03,000', 'Zero length', '',
      'Some orphan text with no timing', '',
      '3', '00:00:04,000 --> 00:00:05,000', 'Another good one', '',
    ].join('\n');
    const result = parseSubtitleFile(content, 'a.srt');
    expect(result.cues.map((c) => c.text)).toEqual(['Good cue', 'Another good one']);
    expect(result.skippedCount).toBe(2);
  });
});

describe('ASS parsing', () => {
  const ASS = [
    '[Script Info]',
    'Title: Test',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello, world\\N{\\i1}second line{\\i0}',
    'Dialogue: 0,0:00:04.00,0:00:05.25,Default,,0,0,0,,Plain cue',
    'Dialogue: 0,0:00:06.00,0:00:06.00,Default,,0,0,0,,Zero length',
  ].join('\n');

  it('parses Dialogue lines with centisecond timing', () => {
    const result = parseSubtitleFile(ASS, 'a.ass');
    expect(result.format).toBe('ass');
    expect(result.cues[1]).toEqual({ start: 4, end: 5.25, text: 'Plain cue' });
  });

  it('preserves commas inside the Text field', () => {
    const result = parseSubtitleFile(ASS, 'a.ass');
    expect(result.cues[0].text).toContain('Hello, world');
  });

  it('converts \\N to a newline and strips override tags', () => {
    const result = parseSubtitleFile(ASS, 'a.ass');
    expect(result.cues[0].text).toBe('Hello, world\nsecond line');
  });

  it('skips and counts zero-length dialogue lines', () => {
    const result = parseSubtitleFile(ASS, 'a.ass');
    expect(result.cues).toHaveLength(2);
    expect(result.skippedCount).toBe(1);
  });

  it('recognizes .ssa files as ASS', () => {
    expect(detectSubtitleFormat(ASS, 'a.ssa')).toBe('ass');
    expect(parseSubtitleFile(ASS, 'a.ssa').format).toBe('ass');
  });
});

describe('format detection', () => {
  it('uses the extension when present', () => {
    expect(detectSubtitleFormat('whatever', 'movie.srt')).toBe('srt');
    expect(detectSubtitleFormat('whatever', 'movie.ass')).toBe('ass');
  });

  it('sniffs content when there is no usable extension', () => {
    expect(detectSubtitleFormat('[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hi')).toBe('ass');
    expect(detectSubtitleFormat('1\n00:00:01,000 --> 00:00:02,000\nHi')).toBe('srt');
    expect(detectSubtitleFormat('just some prose')).toBeNull();
  });
});

describe('honest failures', () => {
  it('rejects an empty file', () => {
    expect(() => parseSubtitleFile('   ', 'a.srt')).toThrow(SubtitleImportError);
    expect(() => parseSubtitleFile('', 'a.srt')).toThrow(/empty/);
  });

  it('rejects a non-subtitle file', () => {
    expect(() => parseSubtitleFile('hello world, no timings here', 'notes.txt')).toThrow(/not a subtitle file/);
  });

  it('rejects a file whose entries are all malformed', () => {
    expect(() => parseSubtitleFile('1\n00:00:02,000 --> 00:00:01,000\nBackwards\n', 'a.srt')).toThrow(/No usable captions/);
  });
});

describe('application to the project', () => {
  it('cueToWords distributes a cue evenly across its words', () => {
    const words = cueToWords({ start: 2, end: 4, text: 'one two' });
    expect(words).toEqual([
      { text: 'one', start: 0, end: 1 },
      { text: 'two', start: 1, end: 2 },
    ]);
  });

  it('imported cues become ordinary editable manual caption items', () => {
    const project = applyImportedCaptions(projectWithCaptionTrack(), [
      { start: 1, end: 3, text: 'imported words here' },
    ]);
    const items = captionItemsOf(project);
    expect(items).toHaveLength(1);
    expect(items[0].startTime).toBe(1);
    expect(items[0].endTime).toBe(3);
    expect(items[0].source).toBe('manual');
    expect(items[0].editable).toBe(true);
    expect(items[0].words.map((w) => w.text)).toEqual(['imported', 'words', 'here']);
  });

  it('import replaces the existing caption set instead of stacking on top', () => {
    let project = projectWithCaptionTrack();
    project = addCaptionItems(project, {
      words: [{ text: 'old', start: 0, end: 0.5 }],
      atTime: 0,
      captionStyleId: 'classic',
      source: 'ai',
    });
    expect(captionItemsOf(project)).toHaveLength(1);
    project = applyImportedCaptions(project, [{ start: 0, end: 1, text: 'brand new' }]);
    const items = captionItemsOf(project);
    expect(items).toHaveLength(1);
    expect(items[0].words.map((w) => w.text)).toEqual(['brand', 'new']);
  });

  it('keeps one caption item per file cue (no re-chunking of long cues)', () => {
    const project = applyImportedCaptions(projectWithCaptionTrack(), [
      { start: 0, end: 9, text: 'a long cue that transcription would have split into several smaller ones' },
    ]);
    expect(captionItemsOf(project)).toHaveLength(1);
    expect(captionItemsOf(project)[0].endTime).toBe(9);
  });
});

describe('round-trip: Studio SRT export -> import', () => {
  it('yields cues equal to the exported ones', () => {
    const original = [
      { start: 0, end: 2, text: 'Welcome to RiddimRoom' },
      { start: 2.5, end: 5, text: 'second cue here' },
      { start: 61.5, end: 63, text: 'late cue' },
    ];
    const project = applyImportedCaptions(projectWithCaptionTrack(), original);
    const exportedCues = collectCues(captionItemsOf(project));
    expect(exportedCues).toEqual(original);

    const srt = captionsToSRT(exportedCues);
    const reimported = parseSubtitleFile(srt, 'roundtrip.srt');
    expect(reimported.skippedCount).toBe(0);
    expect(reimported.cues).toEqual(original);
  });
});
