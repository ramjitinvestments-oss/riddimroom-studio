/**
 * Unified user document schema for RiddimRoom Studio.
 *
 * Source of truth: riddimroom-studio-phase0-plan.md section 4.2.
 * Merges riddimroom-caption's quota/subscription fields with
 * riddimroom-app (EventCam)'s status/usage-counter fields into one
 * users/{uid} document shared by every entry point.
 */

export type UserRole = 'user' | 'admin';

/**
 * EventCam's four-state onboarding gate, carried into the unified schema.
 * Phase 1 has no admin approval queue yet (that ships in a later phase per
 * the approved Phase 1 plan), so new users are initialized as 'approved'
 * rather than EventCam's original default of 'pending' — otherwise every
 * new signup would be locked out with no admin panel available yet to
 * unlock them. See PROGRESS.md "Source-of-feature log" for the full note.
 */
export type UserStatus = 'pending' | 'approved' | 'denied' | 'suspended';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string | null;
  provider: string;
  role: UserRole;
  status: UserStatus;
  createdAt: unknown;
  lastLogin: unknown;
  lastUpdated: unknown;

  // Quota fields (from riddimroom-caption)
  dailyCount: number;
  lastTranscribeDate: string | null;
  totalTranscribes: number;

  // Usage-counter fields (from riddimroom-app / EventCam)
  captureCount: number;
  photoCount: number;
  videoCount: number;

  // Present in schema for forward-compatibility with Phase 3 subscription
  // gating; unused/inert in Phase 1 (see Phase 0 finding: caption already
  // shipped these fields with no billing integration behind them).
  subscription: string;
  plan: string;
}

export const DEFAULT_DAILY_QUOTA = 2;

/**
 * The shape `GET /api/user/status` actually returns (`server.ts`'s
 * `toClientUser`) — a subset of `UserProfile` (omits server-internal
 * timestamp fields) plus `maxFree`, which is not stored on the Firestore
 * document at all but computed server-side from `DEFAULT_DAILY_QUOTA`.
 * `AuthContext`'s `userProfile` holds this shape, not a raw `UserProfile`;
 * added here (Phase 1 quota-enforcement build step) after the two were
 * found to have drifted — `AuthContext` had been typed as `UserProfile`,
 * which doesn't actually have `maxFree`.
 */
export interface ClientUserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string | null;
  provider: string;
  role: UserRole;
  status: UserStatus;
  dailyCount: number;
  maxFree: number;
  totalTranscribes: number;
  captureCount: number;
  photoCount: number;
  videoCount: number;
  subscription: string;
  plan: string;
}
