/**
 * RiddimRoom Studio — caption file export (SRT / VTT).
 * Captions are structured data in the project; these helpers render them
 * to standard subtitle files without touching the project itself.
 */
import type { CaptionTimelineItem } from '../../types/timeline';

export function formatSrtTime(totalSeconds: number): string {
  const ms = Math.max(0, Math.round(totalSeconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rem = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(rem).padStart(3, '0')}`;
}

export function formatVttTime(totalSeconds: number): string {
  return formatSrtTime(totalSeconds).replace(',', '.');
}

export interface Cue { start: number; end: number; text: string; }

/** Caption items -> absolute-time cues (words are relative to the item). One cue per caption item (joined words). */
export function collectCues(items: CaptionTimelineItem[]): Cue[] {
  const cues: Cue[] = [];
  for (const item of items) {
    if (item.type !== 'caption') continue;
    const text = item.words.map((w) => w.text).join(' ');
    if (!text.trim()) continue;
    const start = item.startTime + (item.words[0]?.start ?? 0);
    const end = item.startTime + (item.words[item.words.length - 1]?.end ?? 0);
    if (end > start) cues.push({ start, end, text: text.trim() });
  }
  return cues.sort((a, b) => a.start - b.start);
}

export function captionsToSRT(cues: Cue[]): string {
  if (cues.length === 0) return '';
  return cues.map((c, i) => `${i + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${c.text}`).join('\n\n') + '\n';
}

export function captionsToVTT(cues: Cue[]): string {
  if (cues.length === 0) return 'WEBVTT\n\n';
  return 'WEBVTT\n\n' + cues.map((c) => `${formatVttTime(c.start)} --> ${formatVttTime(c.end)}\n${c.text}`).join('\n\n') + '\n';
}

export function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
