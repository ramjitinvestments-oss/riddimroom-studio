/**
 * RiddimRoom Studio — licensing (v1).
 *
 * Two tiers, no subscriptions:
 * - free: limited (30s projects, 2 transcriptions/day, 3 exports/day, watermark on)
 * - lifetime: one-time paid unlock ($35) (600s projects, 10 transcriptions/day, unlimited exports, no watermark)
 *
 * Server is the source of truth: `licenses/{uid}` in Firestore, written
 * ONLY by the Stripe webhook handler in server.ts (never by the client).
 * The client treats the license as a display + soft gate; the server
 * enforces transcription quota by tier. Export limits are enforced
 * client-side via a daily counter in localStorage (best-effort) + the
 * watermark rule — the watermark itself is baked into the compositor
 * output via Project.watermarkEnabled, so a free export always carries it.
 *
 * Stripe keys are NEVER in this repo. See .env.example:
 * STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID_LIFETIME.
 */

export type LicenseTier = 'free' | 'lifetime';

export interface License {
  uid: string;
  tier: LicenseTier;
  status: 'active' | 'inactive';
  purchasedAt: number | null;
  stripeSessionId?: string;
}

export const FREE_LICENSE: License = { uid: '', tier: 'free', status: 'active', purchasedAt: null };

/** One-time lifetime price in USD. Stripe Price ID lives in env (STRIPE_PRICE_ID_LIFETIME). */
export const LIFETIME_PRICE_USD = 35;

export interface PlanLimits {
  maxProjectSeconds: number;
  dailyTranscriptions: number;
  dailyExports: number; // Number.POSITIVE_INFINITY = unlimited
  watermark: boolean;
  templates: 'curated' | 'all';
  label: string;
}

export const PLAN_LIMITS: Record<LicenseTier, PlanLimits> = {
  free: { maxProjectSeconds: 30, dailyTranscriptions: 2, dailyExports: 3, watermark: true, templates: 'curated', label: 'Free' },
  lifetime: { maxProjectSeconds: 600, dailyTranscriptions: 10, dailyExports: Number.POSITIVE_INFINITY, watermark: false, templates: 'all', label: 'Lifetime' },
};

export function getPlanLimits(tier: LicenseTier): PlanLimits {
  return PLAN_LIMITS[tier] ?? PLAN_LIMITS.free;
}

export function isPaidTier(tier: LicenseTier): boolean {
  return tier === 'lifetime';
}

export function maxProjectSecondsFor(tier: LicenseTier): number {
  return getPlanLimits(tier).maxProjectSeconds;
}

/**
 * Effective-tier resolution for the client's display + soft gates.
 *
 * `serverTier` is authoritative whenever the API actually answered
 * (/api/user/status or /api/license — server.ts's `getLicenseTier`
 * already folds the admin grant into what it returns, so a present
 * server tier is never second-guessed here). Only when there is NO
 * server answer (e.g. the static preview build, where /api/* 404s)
 * does the admin fallback apply: a user with an `admins/{uid}` doc —
 * this codebase's existing admin concept, readable by its owner per
 * firestore.rules — resolves to 'lifetime', so the studio owner isn't
 * free-gated on their own app. Everyone else resolves to 'free'.
 * Server-enforced quotas (transcription) never consult this function.
 */
export function resolveEffectiveTier(serverTier: LicenseTier | null | undefined, isAdmin: boolean): LicenseTier {
  if (serverTier) return serverTier;
  return isAdmin ? 'lifetime' : 'free';
}

/** Daily export counter key (localStorage, client-side soft gate). */
export function exportCounterKey(uid: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return `rr-export-count:${uid}:${day}`;
}

export function getExportsToday(uid: string): number {
  try {
    return Number(localStorage.getItem(exportCounterKey(uid)) || 0) || 0;
  } catch {
    return 0;
  }
}

export function recordExport(uid: string): void {
  try {
    const key = exportCounterKey(uid);
    localStorage.setItem(key, String(getExportsToday(uid) + 1));
  } catch {
    // localStorage unavailable — soft gate only, do not block export.
  }
}

export function canExportToday(uid: string, tier: LicenseTier): boolean {
  const limits = getPlanLimits(tier);
  if (!Number.isFinite(limits.dailyExports)) return true;
  return getExportsToday(uid) < limits.dailyExports;
}

export function exportsRemainingToday(uid: string, tier: LicenseTier): number {
  const limits = getPlanLimits(tier);
  if (!Number.isFinite(limits.dailyExports)) return Number.POSITIVE_INFINITY;
  return Math.max(0, limits.dailyExports - getExportsToday(uid));
}
