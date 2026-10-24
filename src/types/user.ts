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
 * Phase 1 initialized new users as 'approved' because no admin approval
 * queue existed yet. Phase 2 (Plan v5 toggle access) built that queue —
 * the in-app Admin screen backed by /api/admin/* — so new signups now
 * initialize as 'pending' and an admin toggles them to 'approved'
 * (which also grants the lifetime license; see api/_lib.ts
 * applyAccessToggle). Admins (admins/{uid}) are never gated by status.
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

  // Marketing consent (Phase 2, Plan v5): set by the user themselves from
  // the pending screen via a direct client write to their own doc (the
  // one non-privileged field the client may change — firestore.rules
  // freezes only uid/role/status/subscription/plan on update). Absent on
  // pre-Phase-2 documents; treat as false.
  marketingOptIn?: boolean;
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
  /** v1 licensing tier (free | lifetime). Defaults to 'free' when absent (pre-v1 profiles). */
  licenseTier?: 'free' | 'lifetime';
  /** Phase 2 (Plan v5): true when admins/{uid} exists — drives the Admin screen's visibility. */
  isAdmin?: boolean;
  /** Phase 2 (Plan v5): the user's stored marketing consent (see UserProfile.marketingOptIn). */
  marketingOptIn?: boolean;
}
