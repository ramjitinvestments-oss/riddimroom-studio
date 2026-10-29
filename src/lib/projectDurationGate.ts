/**
 * RiddimRoom Studio — the tier duration gate for exports (R35).
 *
 * The licensing plan limits are the source of truth for HOW LONG a
 * project may be (`maxProjectSecondsFor` in `lib/licensing.ts`). Until
 * R35 that value had no consumer: the project layer capped every tier
 * at the technical media ceiling, so a Free project could be built far
 * past the Free plan's limit and still export. This module is the one
 * place that turns the plan value into an export decision.
 *
 * Duration is measured by the R36 LONGEST-VIDEO DURATION LAW:
 * `getProjectDuration(project)` (the max of the main-track end and the
 * longest-video end, PiP/overlay and pair videos included) whenever
 * the project has any visual content — a main visual item OR any
 * video item at all. An over-long song under a short visual project
 * still does not make the project longer (audio never extends). A
 * project with NO visual content (audio-only, text-only, caption-only
 * or empty) measures 0 here — preserving R35's documented exemption:
 * those projects keep the renderers' fallback duration, and a
 * song-only project has no visual content to cap.
 */

import { maxProjectSecondsFor, type LicenseTier } from './licensing';
import { DURATION_LIMIT_EPSILON_SECONDS } from './media/constants';
import { formatTimecode, getLongestVideoEnd, getProjectDuration, isMainVisualItem } from './timeline/utils';
import type { Project } from '../types/timeline';

export interface ProjectDurationGate {
  tier: LicenseTier;
  /** Project duration in seconds (R36 measure) — the duration the cap is judged on. */
  durationSeconds: number;
  /** The tier's cap, from the licensing source of truth. */
  maxProjectSeconds: number;
  exceedsCap: boolean;
  /** Plain refusal copy when `exceedsCap` is true; otherwise null. */
  message: string | null;
  /** Compact proactive cap line for editor/export surfaces. */
  indicator: string;
}

function formatClock(seconds: number): string {
  const timecode = formatTimecode(seconds);
  return timecode.endsWith('.0') ? timecode.slice(0, -2) : timecode;
}

function formatCap(maxProjectSeconds: number): string {
  return maxProjectSeconds < 60
    ? `${maxProjectSeconds} seconds`
    : `${maxProjectSeconds / 60} minutes`;
}

export function projectDurationCapMessage(
  tier: LicenseTier,
  durationSeconds: number,
  maxProjectSeconds: number = maxProjectSecondsFor(tier),
): string {
  const cap = formatCap(maxProjectSeconds);
  if (tier === 'free') {
    return `This project is ${formatClock(durationSeconds)} long, but Free projects can be up to ${cap}. Trim it to ${cap} or upgrade to Lifetime to export it.`;
  }
  return `This project is ${formatClock(durationSeconds)} long, but Lifetime projects can be up to ${cap}. Trim it to ${cap} to export it.`;
}

export function projectDurationCapIndicator(
  tier: LicenseTier,
  durationSeconds: number,
  maxProjectSeconds: number = maxProjectSecondsFor(tier),
): string {
  const plan = tier === 'free' ? 'Free plan' : 'Lifetime plan';
  const base = `${plan}: up to ${formatCap(maxProjectSeconds)} — this project is ${formatClock(durationSeconds)}`;
  if (durationSeconds <= maxProjectSeconds + DURATION_LIMIT_EPSILON_SECONDS) return base;
  return tier === 'free'
    ? `${base}. Trim it to ${formatCap(maxProjectSeconds)} or upgrade to Lifetime to export it.`
    : `${base}. Trim it to ${formatCap(maxProjectSeconds)} to export it.`;
}

/**
 * The export gate itself — pure: it reads the project and the tier,
 * touches no storage, no quota counter and no renderer. Callers check
 * it BEFORE starting any encoding work; a refused export therefore
 * consumes no daily export quota.
 */
export function evaluateProjectExportGate(project: Project, tier: LicenseTier): ProjectDurationGate {
  // R36 measure: the full project duration when the project has any
  // visual content (a main visual item, or any video item — a PiP-only
  // project is visual content too); 0 for audio/text-only projects.
  const hasVisualContent =
    getLongestVideoEnd(project) !== null || project.items.some((item) => isMainVisualItem(item));
  const durationSeconds = hasVisualContent ? getProjectDuration(project) : 0;
  const maxProjectSeconds = maxProjectSecondsFor(tier);
  const exceedsCap = durationSeconds > maxProjectSeconds + DURATION_LIMIT_EPSILON_SECONDS;
  return {
    tier,
    durationSeconds,
    maxProjectSeconds,
    exceedsCap,
    message: exceedsCap ? projectDurationCapMessage(tier, durationSeconds, maxProjectSeconds) : null,
    indicator: projectDurationCapIndicator(tier, durationSeconds, maxProjectSeconds),
  };
}
