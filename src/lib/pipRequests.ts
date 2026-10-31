/**
 * R36 WS-1 — PiP add requests (Record PiP / Upload PiP).
 *
 * PipPanel and the timeline's Overlay lane need to ask for a camera
 * recording or a file upload, but neither owns the camera or the file
 * inputs — MediaImportPanel does. Following the R27 'rr:undo-toast'
 * precedent (ItemInspector dispatches, EditorShell listens), the
 * request travels as a window CustomEvent and MediaImportPanel — the
 * owner of CameraCapture and of the overlay file input — is the only
 * listener. No new upload/camera path is created by this: the events
 * only press the buttons MediaImportPanel already has.
 *
 * Claim rule: MediaImportPanel can be mounted more than once (the
 * desktop aside and the mobile bottom sheet render the same panel
 * node), so the first mounted instance whose panel is actually
 * rendered claims the event by marking the event object itself;
 * later listeners for the SAME event object see the mark and skip.
 * A fresh dispatch is a fresh object, so the next request claims
 * normally.
 */

export const RECORD_PIP_EVENT = 'rr:record-pip';
export const UPLOAD_PIP_EVENT = 'rr:upload-pip';

export type PipRequestEventName = typeof RECORD_PIP_EVENT | typeof UPLOAD_PIP_EVENT;

interface DispatchTargetLike {
  dispatchEvent: (event: unknown) => boolean;
}

function defaultTarget(): DispatchTargetLike | null {
  return typeof window !== 'undefined' ? (window as unknown as DispatchTargetLike) : null;
}

/**
 * R40 P-42 — claim hygiene. A claim is not an answer: the claiming
 * instance must ANSWER within `PIP_CLAIM_WINDOW_MS` (MediaImportPanel
 * answers once its camera / file picker is actually open). A claim
 * that is never answered — or whose claiming instance unmounts first
 * and RELEASES it — frees the request, and the dispatcher retries
 * ONCE with a fresh event so another instance can answer. The
 * single-answer guarantee is unchanged: an answered event can never
 * be released or claimed again.
 */
export const PIP_CLAIM_WINDOW_MS = 250;

const CLAIMED = Symbol.for('rr.pipRequestClaimed');
const CLAIMANT = Symbol.for('rr.pipRequestClaimant');
const ANSWERED = Symbol.for('rr.pipRequestAnswered');
const RETRIED = Symbol.for('rr.pipRequestRetried');
const REDISPATCHED = Symbol.for('rr.pipRequestRedispatched');

type ScheduleFn = (fn: () => void, ms: number) => void;

const defaultSchedule: ScheduleFn = (fn, ms) => {
  if (typeof setTimeout === 'function') setTimeout(fn, ms);
};

export interface PipRequestOptions {
  /** How long the dispatcher waits for an answer before its one retry. */
  retryWindowMs?: number;
  /** Timer injection for tests; defaults to the global setTimeout. */
  schedule?: ScheduleFn;
  /** Internal: a retry dispatch never schedules another retry. */
  isRetry?: boolean;
}

function dispatchPipRequest(
  name: PipRequestEventName,
  target?: DispatchTargetLike | null,
  options?: PipRequestOptions,
): boolean {
  const t = target ?? defaultTarget();
  if (!t || typeof CustomEvent === 'undefined') return false;
  const event = new CustomEvent(name);
  t.dispatchEvent(event);
  if (!options?.isRetry) {
    const schedule = options?.schedule ?? defaultSchedule;
    schedule(() => {
      if (isPipRequestAnswered(event) || (event as unknown as Record<symbol, unknown>)[RETRIED]) return;
      (event as unknown as Record<symbol, unknown>)[RETRIED] = true;
      dispatchPipRequest(name, t, { isRetry: true });
    }, options?.retryWindowMs ?? PIP_CLAIM_WINDOW_MS);
  }
  return true;
}

/** Ask the import panel to open the camera in PiP (overlay) mode. */
export function requestRecordPip(target?: DispatchTargetLike | null, options?: PipRequestOptions): boolean {
  return dispatchPipRequest(RECORD_PIP_EVENT, target, options);
}

/** Ask the import panel to open its overlay file picker. */
export function requestUploadPip(target?: DispatchTargetLike | null, options?: PipRequestOptions): boolean {
  return dispatchPipRequest(UPLOAD_PIP_EVENT, target, options);
}

function eventRecord(event: unknown): Record<symbol, unknown> | null {
  if ((typeof event !== 'object' && typeof event !== 'function') || event === null) return null;
  return event as Record<symbol, unknown>;
}

/**
 * Claim a PiP request event for one MediaImportPanel instance.
 * Returns true for the first claimant of this exact event object,
 * false for every later one. `claimant` is the instance's stable
 * identity token — it is what lets that instance later answer or
 * release its own claim (and no other instance's). Non-object events
 * can never be claimed twice-checked, so they are treated as
 * unclaimed (return true) — real window events are always objects.
 */
export function claimPipRequest(event: unknown, claimant?: object): boolean {
  const marked = eventRecord(event);
  if (!marked) return true;
  if (marked[CLAIMED]) return false;
  marked[CLAIMED] = true;
  if (claimant) marked[CLAIMANT] = claimant;
  return true;
}

/** True once the claiming instance has confirmed it answered. */
export function isPipRequestAnswered(event: unknown): boolean {
  const marked = eventRecord(event);
  return !!marked?.[ANSWERED];
}

/**
 * The claiming instance confirms it answered (its camera / picker is
 * open). Only the recorded claimant may answer; an answered claim is
 * final — it can never be released or re-claimed.
 */
export function answerPipRequest(event: unknown, claimant?: object): boolean {
  const marked = eventRecord(event);
  if (!marked || !marked[CLAIMED] || marked[ANSWERED]) return false;
  if (claimant && marked[CLAIMANT] && marked[CLAIMANT] !== claimant) return false;
  marked[ANSWERED] = true;
  return true;
}

/**
 * Release a claim that was never answered — the claiming instance is
 * unmounting / unregistering, so another instance must be free to
 * answer. Only the recorded claimant may release, and an answered
 * claim can never be released. Returns true when a claim was freed.
 */
export function releasePipRequestClaim(event: unknown, claimant?: object): boolean {
  const marked = eventRecord(event);
  if (!marked || !marked[CLAIMED] || marked[ANSWERED]) return false;
  if (claimant && marked[CLAIMANT] && marked[CLAIMANT] !== claimant) return false;
  delete marked[CLAIMED];
  delete marked[CLAIMANT];
  return true;
}

/**
 * One-shot guard for an unmounting claimant that re-dispatches its
 * released request itself: returns true the first time it is called
 * for an event, false after — a request is never bounced forever.
 */
export function markPipRequestRedispatched(event: unknown): boolean {
  const marked = eventRecord(event);
  if (!marked) return false;
  if (marked[REDISPATCHED]) return false;
  marked[REDISPATCHED] = true;
  return true;
}
