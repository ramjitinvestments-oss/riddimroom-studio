/**
 * RiddimRoom Studio — v1 duration + plan limits.
 *
 * V1 rule (user-approved):
 * - Free tier: projects up to 30s, 2 transcriptions/day, 3 exports/day, watermark on.
 * - Lifetime (one-time paid) tier: projects up to 10 minutes (600s), 10 transcriptions/day, unlimited exports, no watermark.
 * - MAX_MEDIA_SECONDS is the hard technical ceiling (600s) for any single item / project.
 * Every place that needs a limit imports from here — no scattered numbers.
 */

/** Hard ceiling, in seconds, for any single media item AND for a whole project (lifetime tier). */
export const MAX_MEDIA_SECONDS = 600;

/** Free-tier project ceiling. Paid lifetime projects may go up to MAX_MEDIA_SECONDS. */
export const FREE_MAX_PROJECT_SECONDS = 30;

/** Lifetime-tier project ceiling (= MAX_MEDIA_SECONDS). */
export const PAID_MAX_PROJECT_SECONDS = 600;

/** Hard ceiling, in seconds, for an audio/video fade-in or fade-out. Effective max is min(MAX_FADE_SECONDS, clip duration). */
export const MAX_FADE_SECONDS = 3;

/** Small tolerance for floating-point drift when comparing durations against a hard limit. */
export const DURATION_LIMIT_EPSILON_SECONDS = 0.05;

/** Free-tier daily caps. */
export const FREE_DAILY_TRANSCRIPTIONS = 2;
export const FREE_DAILY_EXPORTS = 3;

/** Lifetime-tier daily caps. Exports are unlimited; transcriptions are generous fair-use. */
export const PAID_DAILY_TRANSCRIPTIONS = 10;
