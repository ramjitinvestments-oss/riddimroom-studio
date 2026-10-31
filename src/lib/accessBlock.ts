/**
 * R40 P-23 — why an account is not getting in, in plain classes.
 *
 * R34 fixed the restricted screen's buttons but left the root: a bare
 * `isAccountDisabled` boolean, so a switched-off account, a profile
 * fetch that failed (network down, or a 401/403 with no definitive
 * account state behind it) all landed on the SAME generic screen, and
 * the automatic sign-out erased which one it was. This module is the
 * pure classification AuthContext now keeps instead:
 *
 * - 'switched-off' — the account's own status says so (the profile
 *   came back suspended/denied, or the status endpoint answered with
 *   the account-level refusal). The user needs the owner.
 * - 'pending' — the account is simply still waiting to be switched
 *   on. Not a block at all: App routes it to the PendingScreen.
 * - 'unreachable' — the profile fetch failed (network error, or an
 *   HTTP failure that carries no definitive disabled state). Nothing
 *   is known to be wrong with the account; trying again may work.
 *
 * The reason is deliberately NOT cleared by sign-out (see AuthContext):
 * the gate signs the user out as part of blocking them, and the
 * restricted screen renders AFTER that sign-out — the reason has to
 * survive it, or the screen is back to guessing.
 */

export type AccessBlockReason = 'switched-off' | 'pending' | 'unreachable';

/** The outcome classes of one profile fetch, before classification. */
export type ProfileFetchOutcome =
  | { kind: 'ok'; status: string }
  | { kind: 'http-error'; httpStatus: number }
  | { kind: 'network-error' };

/**
 * Classify one profile-fetch outcome. Returns null when the outcome
 * does not block access at all (an active/approved profile).
 *
 * The status endpoint's contract (api/user/status.ts): a suspended or
 * denied account is answered 403 (the refusal IS the account state),
 * while a 401 means the token itself was rejected — no account state
 * was ever read. So 403 classifies as 'switched-off', and every other
 * HTTP failure (401 included) plus network failures classify as
 * 'unreachable': the app could not learn the account's state.
 */
export function accessBlockForProfileOutcome(outcome: ProfileFetchOutcome): AccessBlockReason | null {
  switch (outcome.kind) {
    case 'ok':
      if (outcome.status === 'suspended' || outcome.status === 'denied') return 'switched-off';
      if (outcome.status === 'pending') return 'pending';
      return null;
    case 'http-error':
      return outcome.httpStatus === 403 ? 'switched-off' : 'unreachable';
    case 'network-error':
      return 'unreachable';
  }
}

/**
 * The restricted screen renders only for reasons that are truly a
 * block. 'pending' is not one (it belongs on the PendingScreen) and
 * neither is "no reason".
 */
export function isRestrictedReason(reason: AccessBlockReason | null): reason is 'switched-off' | 'unreachable' {
  return reason === 'switched-off' || reason === 'unreachable';
}
