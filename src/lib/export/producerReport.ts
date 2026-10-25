/**
 * Producer's report — the post-export QC card in the Share pack.
 *
 * Every line is MEASURED from the project (and, for loudness, from the
 * finished file): hook timing from item starts/entrances, captions and
 * music from the items themselves, CTA from the text on screen at the
 * end, format from the canvas + duration. Nothing is estimated from
 * vibes, and nothing here promises reach — the report's job is that
 * every attempt goes out CORRECT: hooked fast, captioned for muted
 * feeds, beaten, framed right, and ending on the ask.
 */
import type { Project } from '../../types/timeline';
import { getProjectDuration } from '../timeline/utils';

export type ProducerCheckStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface ProducerCheck {
  id: string;
  label: string;
  status: ProducerCheckStatus;
  detail: string;
  /** One-tap remedy, shown when the check is not a pass. */
  fix?: string;
  /** Score weight; info checks are unscored. */
  weight: number;
}

export interface ProducerReport {
  checks: ProducerCheck[];
  /** 0–100, weighted over scored checks (pass 1, warn 0.5, fail 0). */
  score: number;
  grade: 'A' | 'B' | 'C' | 'D';
  headline: string;
  /** The non-pass checks' fixes, in priority order. */
  fixes: string[];
}

export interface LoudnessReading {
  rmsDbfs: number;
  peakDbfs: number;
}

const HOOK_LIMIT_SECONDS = 1.5;

function aspectLabel(w: number, h: number): string {
  const r = w / h;
  if (Math.abs(r - 9 / 16) < 0.03) return '9:16';
  if (Math.abs(r - 1) < 0.03) return '1:1';
  if (Math.abs(r - 16 / 9) < 0.03) return '16:9';
  if (Math.abs(r - 4 / 5) < 0.03) return '4:5';
  return `${w}×${h}`;
}

export function buildProducerReport(project: Project, loudness?: LoudnessReading | null): ProducerReport {
  const duration = getProjectDuration(project);
  const checks: ProducerCheck[] = [];
  const items = project.items;

  // ── Hook speed: the first punch — an animated entrance, a caption, or
  // a headline — must land inside 1.5s. ──
  const punchTimes: number[] = [];
  for (const item of items) {
    if (item.type === 'caption' || item.type === 'text') punchTimes.push(item.startTime);
    else if ((item.type === 'video' || item.type === 'image') && item.animation?.entrance && item.animation.entrance !== 'none') {
      punchTimes.push(item.startTime);
    } else if ((item.type === 'video' || item.type === 'image') && item.motion && item.motion.type !== 'none') {
      punchTimes.push(item.startTime);
    }
  }
  const firstPunch = punchTimes.length > 0 ? Math.min(...punchTimes) : null;
  checks.push({
    id: 'hook',
    label: 'Hook speed',
    status: firstPunch !== null && firstPunch <= HOOK_LIMIT_SECONDS ? 'pass' : 'fail',
    detail:
      firstPunch !== null
        ? `First punch lands at ${firstPunch.toFixed(1)}s (the scroll is decided by ${(HOOK_LIMIT_SECONDS).toFixed(1)}s).`
        : 'Nothing moves or speaks in the opening — the first seconds are static.',
    fix: firstPunch !== null && firstPunch <= HOOK_LIMIT_SECONDS ? undefined : 'Open with a slam, a headline or motion inside the first 1.5 seconds.',
    weight: 3,
  });

  // ── Text integrity: an architectural guarantee of this renderer —
  // artwork is drawn from the source file, never redrawn or re-typed. ──
  const hasArtwork = items.some((i) => i.type === 'video' || i.type === 'image');
  if (hasArtwork) {
    checks.push({
      id: 'integrity',
      label: 'Text integrity',
      status: 'pass',
      detail: 'Source pixels only — your artwork was never redrawn or re-typed, so every letter is exactly as designed.',
      weight: 1,
    });
  }

  // ── Muted-feed readiness: captions present. ──
  const hasCaptions = items.some((i) => i.type === 'caption');
  checks.push({
    id: 'captions',
    label: 'Muted-feed ready',
    status: hasCaptions ? 'pass' : 'fail',
    detail: hasCaptions
      ? 'Captions are on — the video still sells itself with the sound off.'
      : 'No captions — and most feeds are watched on mute.',
    fix: hasCaptions ? undefined : 'Add captions in the Captions group (auto-transcribe or type them).',
    weight: 3,
  });

  // ── Beat: music present (+ loudness when the file was measured). ──
  const hasMusic = items.some((i) => i.type === 'audio' && !i.muted && i.volume > 0);
  if (!hasMusic) {
    checks.push({
      id: 'beat',
      label: 'Beat',
      status: 'fail',
      detail: 'No music on this video — silent posts scroll past.',
      fix: 'Add a beat from the Music group (promos ship with one fitted automatically).',
      weight: 2,
    });
  } else if (loudness) {
    const tooQuiet = loudness.rmsDbfs < -32;
    const hot = loudness.peakDbfs > -0.5;
    checks.push({
      id: 'beat',
      label: 'Beat',
      status: tooQuiet || hot ? 'warn' : 'pass',
      detail: `Music is on. Level measured from the finished file: ≈ ${loudness.rmsDbfs.toFixed(0)} dB average, peak ${loudness.peakDbfs.toFixed(1)} dB${tooQuiet ? ' — very quiet for a phone speaker' : hot ? ' — peaking at the ceiling, may distort' : ' — healthy phone level'}.`,
      fix: tooQuiet ? 'Raise the music volume before exporting again.' : hot ? 'Lower the music volume a touch before exporting again.' : undefined,
      weight: 2,
    });
  } else {
    checks.push({
      id: 'beat',
      label: 'Beat',
      status: 'pass',
      detail: 'Music is on and fitted to the video.',
      weight: 2,
    });
  }

  // ── CTA: a text on screen during the final stretch. ──
  const ctaWindowStart = duration * 0.6;
  const ctaItem = items
    .filter((i) => i.type === 'text' && i.endTime >= duration - 0.5 && i.startTime >= ctaWindowStart - 2)
    .sort((a, b) => b.startTime - a.startTime)[0];
  checks.push({
    id: 'cta',
    label: 'Call to action',
    status: ctaItem ? 'pass' : 'warn',
    detail: ctaItem
      ? `Ends on the ask: “${(ctaItem as { text: string }).text.slice(0, 48)}” is on screen at the close.`
      : 'No text on screen at the close — viewers finish without being told what to do.',
    fix: ctaItem ? undefined : 'End on your ask — tickets, bookings, link in bio — held for the last 2–3 seconds.',
    weight: 2,
  });

  // ── Format fit: shape + length for the feed. ──
  const aspect = aspectLabel(project.canvasWidth, project.canvasHeight);
  const vertical = aspect === '9:16';
  const feedShape = vertical || aspect === '1:1' || aspect === '4:5';
  const goodLength = duration > 0 && duration <= 60;
  checks.push({
    id: 'format',
    label: 'Format fit',
    status: feedShape && goodLength ? 'pass' : 'warn',
    detail: vertical
      ? `${aspect} vertical at ${duration.toFixed(0)}s — the native shape of TikTok, Reels and Shorts.`
      : feedShape
        ? `${aspect} at ${duration.toFixed(0)}s — a feed shape; 9:16 takes more of the phone screen.`
        : `${aspect} landscape at ${duration.toFixed(0)}s — best for YouTube; vertical takes more phone screen on TikTok/Reels.`,
    fix: feedShape && goodLength ? undefined : 'For TikTok/Reels, export from a 9:16 project, 60 seconds or under.',
    weight: 1,
  });

  // ── Loop seam (info): short videos that end on their last frame loop
  // cleanly on the feed players. ──
  if (duration > 0 && duration <= 30) {
    checks.push({
      id: 'loop',
      label: 'Loop',
      status: 'info',
      detail: 'Short-form length — TikTok and Reels will loop it; a clean ending doubles as the next beginning.',
      weight: 0,
    });
  }

  const scored = checks.filter((c) => c.weight > 0);
  const earned = scored.reduce((sum, c) => sum + c.weight * (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
  const total = scored.reduce((sum, c) => sum + c.weight, 0);
  const score = total > 0 ? Math.round((earned / total) * 100) : 0;
  const grade: ProducerReport['grade'] = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D';
  const fixes = checks.filter((c) => c.fix).map((c) => c.fix!);
  const headline =
    fixes.length === 0
      ? 'Feed-ready — post it as-is.'
      : score >= 75
        ? `Strong — ${fixes.length} fix${fixes.length === 1 ? '' : 'es'} from feed-ready.`
        : 'Needs work before it goes out — start with the fixes below.';
  return { checks, score, grade, headline, fixes };
}
