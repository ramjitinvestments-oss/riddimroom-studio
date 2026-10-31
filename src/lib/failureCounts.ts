/**
 * R40 P-28 — first-party failure counts, client side.
 *
 * When an export, a save or a caption job finally fails (after its
 * own retries settle — never on every attempt), the app tells the
 * server "one more of those failed today". Counts only: the request
 * carries a kind and nothing else — no words, no clips, nothing from
 * inside a project (the privacy page says exactly this).
 *
 * Fire-and-forget by design: the call is silent on failure, is never
 * awaited by the user's flow, and can never block or error it. If the
 * server cannot store the count yet, the user's work is unaffected.
 */

export type FailureKind = 'export' | 'save' | 'transcribe';

export const FAILURE_KINDS: readonly FailureKind[] = ['export', 'save', 'transcribe'];

export function isFailureKind(value: unknown): value is FailureKind {
  return value === 'export' || value === 'save' || value === 'transcribe';
}

type Fetcher = (url: string, init: Record<string, unknown>) => Promise<unknown>;

/**
 * Record one final failure. Never throws, never returns a promise the
 * caller needs — safe to call inline at any failure site.
 */
export function recordFailure(kind: FailureKind, idToken: string | null | undefined, fetcher?: Fetcher): void {
  if (!idToken || !isFailureKind(kind)) return;
  const send: Fetcher = fetcher ?? ((url, init) => fetch(url, init as RequestInit));
  try {
    void Promise.resolve(
      send('/api/failure-count', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ kind }),
      }),
    ).catch(() => undefined);
  } catch {
    // Counting must never disturb the flow that failed.
  }
}

/** The admin readout shape the endpoint returns (see api/_lib.ts). */
export interface FailureDayCounts {
  day: string;
  export: number;
  save: number;
  transcribe: number;
  total: number;
}

export interface FailureCountsSummary {
  today: FailureDayCounts;
  last7Days: { export: number; save: number; transcribe: number; total: number };
  days: FailureDayCounts[];
}

/** Plain labels for the admin "What's failing" section. */
export const FAILURE_KIND_LABELS: Record<FailureKind, string> = {
  export: 'Exports',
  save: 'Saves',
  transcribe: 'Caption jobs',
};
