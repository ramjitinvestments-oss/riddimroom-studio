import { addItem, generateTimelineId, getTracksByType } from '../timeline/utils';
import type { CaptionTimelineItem, CaptionWordTiming, Project, TextTimelineItem } from '../../types/timeline';

/**
 * Viral Words (R17) — the promo's kinetic lines become word-by-word
 * animated captions: every field line (hook, sub, CTA) that a recipe
 * staged as a text item is converted into a caption item whose words
 * are timed to the track's beat grid, rendered by the compositor's
 * karaoke path (gold active word + the word-pop punch). Lines the
 * recipes animate as pure design (countdown numbers, versus cards)
 * are not field text and stay exactly as designed.
 *
 * Timing rule: word starts snap to beats inside the line's window;
 * when beats are scarce the words spread evenly across the beats
 * that exist; with no beats at all they split the window evenly.
 * A word's end is the next word's start; the last word holds to the
 * window's end.
 */

export const VIRAL_CAPTION_STYLE_ID = 'viral-gold-pop';

function normalize(text: string): string {
  return text.trim().toUpperCase().replace(/\s+/g, ' ');
}

export function wordTimingsForLine(text: string, duration: number, beatsInWindow: number[]): CaptionWordTiming[] {
  // Pure-punctuation tokens ("-" in "SAT - DEC 20") are not words —
  // a dash must never pop as its own caption beat.
  const raw = text.trim().split(/\s+/).filter(Boolean);
  const words = raw.filter((w) => /[A-Za-z0-9]/.test(w));
  const tokens = words.length > 0 ? words : raw;
  if (tokens.length === 0 || duration <= 0) return [];
  const beats = beatsInWindow.filter((b) => b >= 0 && b < duration).sort((a, b) => a - b);
  const starts: number[] = [];
  if (beats.length >= tokens.length) {
    // Enough beats: words fire on the first beats in quick
    // succession and the last word HOLDS to the window's end —
    // stretched-out word gaps are what make captions feel asleep.
    for (let i = 0; i < tokens.length; i++) starts.push(beats[i]);
  } else if (beats.length >= 2) {
    // Map each word across the beat span by index fraction — words
    // land exactly on beats when the counts match and stretch
    // musically when they don't.
    for (let i = 0; i < tokens.length; i++) {
      const frac = tokens.length === 1 ? 0 : i / (tokens.length - 1);
      const pos = frac * (beats.length - 1);
      const lo = Math.floor(pos);
      const hi = Math.min(beats.length - 1, lo + 1);
      starts.push(beats[lo] + (beats[hi] - beats[lo]) * (pos - lo));
    }
  } else if (beats.length === 1) {
    for (let i = 0; i < tokens.length; i++) starts.push(beats[0] + ((duration - beats[0]) * i) / tokens.length);
  } else {
    for (let i = 0; i < tokens.length; i++) starts.push((duration * i) / tokens.length);
  }
  return tokens.map((w, i) => ({
    text: w,
    start: +starts[i].toFixed(3),
    end: +(i + 1 < tokens.length ? starts[i + 1] : duration).toFixed(3),
  }));
}

/**
 * Convert every recipe text item whose words are one of the promo
 * fields into a beat-timed caption item. Returns the project
 * unchanged when nothing matches (photo recipes with no field text
 * staged as items keep their design).
 */
export function convertPromoTextToCaptions(
  project: Project,
  fieldTexts: string[],
  beats: number[],
  styleId: string = VIRAL_CAPTION_STYLE_ID,
): Project {
  const wanted = new Set(fieldTexts.map(normalize).filter(Boolean));
  if (wanted.size === 0) return project;
  const captionTrack = getTracksByType(project, 'caption')[0];
  if (!captionTrack) return project;

  const matched = project.items.filter(
    (i): i is TextTimelineItem => i.type === 'text' && wanted.has(normalize(i.text)),
  );
  if (matched.length === 0) return project;

  const matchedIds = new Set(matched.map((i) => i.id));
  let next: Project = { ...project, items: project.items.filter((i) => !matchedIds.has(i.id)) };
  for (const item of matched) {
    const duration = Math.max(0.1, item.endTime - item.startTime);
    const beatsInWindow = beats
      .filter((b) => b >= item.startTime && b < item.endTime)
      .map((b) => b - item.startTime);
    const caption: CaptionTimelineItem = {
      id: generateTimelineId('item'),
      type: 'caption',
      trackId: captionTrack.id,
      startTime: item.startTime,
      endTime: item.endTime,
      zIndex: item.zIndex,
      visible: true,
      words: wordTimingsForLine(item.text, duration, beatsInWindow),
      captionStyleId: styleId,
      source: 'manual',
      editable: true,
    };
    if (caption.words.length > 0) next = addItem(next, caption);
  }
  return next;
}
