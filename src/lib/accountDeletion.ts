/**
 * R40 P-27 — account deletion, client side.
 *
 * "Delete my account" (Dashboard) records the request through
 * /api/account/delete-request: the server stores { requestedAt, email }
 * in accountDeletionRequests/{uid} and nothing is deleted by the app —
 * the owner completes each request by hand (revoke access in the
 * Admin screen, then delete the user in the Firebase console). The
 * dialog says exactly that, and always offers the email route too,
 * because that is the path that works today.
 *
 * Fire-and-forget like the failure counts: silent on failure, never
 * awaited by the user's flow, never blocking.
 */

type Fetcher = (url: string, init: Record<string, unknown>) => Promise<unknown>;

/** Record one deletion request. Never throws; safe to call inline. */
export function requestAccountDeletion(idToken: string | null | undefined, fetcher?: Fetcher): void {
  if (!idToken) return;
  const send: Fetcher = fetcher ?? ((url, init) => fetch(url, init as RequestInit));
  try {
    void Promise.resolve(
      send('/api/account/delete-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({}),
      }),
    ).catch(() => undefined);
  } catch {
    // Requesting deletion must never disturb the screen it was tapped on.
  }
}

/** The admin readout shape the endpoint returns (see api/_lib.ts). */
export interface DeletionRequestRow {
  uid: string;
  email: string;
  requestedAt: string | null;
}
