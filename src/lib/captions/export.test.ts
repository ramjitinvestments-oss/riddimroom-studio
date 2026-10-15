import { describe, it, expect } from 'vitest';
import { captionsToSRT, captionsToVTT, collectCues, formatSrtTime, formatVttTime } from './export';
import type { CaptionTimelineItem } from '../../types/timeline';

function caption(id: string, startTime: number, words: Array<{ text: string; start: number; end: number }>): CaptionTimelineItem {
  return {
    id, type: 'caption', trackId: 't1', startTime, endTime: startTime + 1, zIndex: 0, visible: true,
    words, captionStyleId: 'classic', source: 'manual', editable: true,
  };
}

describe('SRT/VTT export', () => {
  it('formats times correctly', () => {
    expect(formatSrtTime(61.5)).toBe('00:01:01,500');
    expect(formatSrtTime(0)).toBe('00:00:00,000');
    expect(formatVttTime(61.5)).toBe('00:01:01.500');
  });
  it('collectCues rebases words to absolute timeline time', () => {
    const cues = collectCues([caption('c1', 2, [{ text: 'hi', start: 0, end: 0.5 }])]);
    expect(cues).toEqual([{ start: 2, end: 2.5, text: 'hi' }]);
  });
  it('SRT output is numbered with blank lines', () => {
    const srt = captionsToSRT([{ start: 0, end: 1, text: 'hello' }, { start: 1, end: 2, text: 'world' }]);
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,000\nhello');
    expect(srt).toContain('2\n00:00:01,000 --> 00:00:02,000\nworld');
  });
  it('VTT output has WEBVTT header', () => {
    const vtt = captionsToVTT([{ start: 0, end: 1, text: 'hello' }]);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:00.000 --> 00:00:01.000');
  });
  it('empty cues produce empty SRT / header-only VTT', () => {
    expect(captionsToSRT([])).toBe('');
    expect(captionsToVTT([])).toBe('WEBVTT\n\n');
  });
});
