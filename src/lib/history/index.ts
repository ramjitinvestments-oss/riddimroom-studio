/**
 * RiddimRoom Studio — generic undo/redo history.
 *
 * Deliberately a plain, pure, snapshot-based history (past[]/future[] of
 * whole `T` values) rather than a command/operation system — the codebase
 * has no existing command infrastructure, every edit already flows through
 * one pure `(Project) => Project` transform (`ProjectContext.mutate`), and
 * `Project` objects are small enough that storing full snapshots is simple
 * and correct where a command log would just be additional risk for no
 * real benefit. Kept framework-free (no React) so it's usable from
 * `ProjectContext` via a ref and fully unit-testable on its own.
 *
 * Two responsibilities live here, both used by `ProjectContext`:
 * - `pushHistory`/`undoHistory`/`redoHistory`: the actual stack mechanics,
 *   including capping history length (`maxLength`) so undo state can never
 *   grow unbounded, and clearing the redo branch on `pushHistory` (a new
 *   edit after an undo invalidates whatever redo path existed) and on
 *   `redoHistory`'s sibling push-during-undo (both directions maintain the
 *   invariant "a mutation always converts the *other* stack's top into a
 *   fresh history frame").
 * - `shouldCoalesce`: whether a new edit should be folded into the most
 *   recent undo step rather than creating a new one. Without this, a
 *   single clip drag (which calls `mutate` on every `mousemove`, easily
 *   dozens of times) or typing a caption word (one call per keystroke)
 *   would each explode into dozens of individually-undoable micro-steps —
 *   exactly the "recording every animation frame as an undo operation"
 *   failure mode this pass was asked to avoid. Coalescing by elapsed wall-
 *   clock time between edits (not by call count or edit type) is what lets
 *   one continuous drag or one continuous typing burst collapse into a
 *   single undo step while still starting a fresh step once the user
 *   pauses and moves on to a different edit.
 */

export interface History<T> {
  past: T[];
  future: T[];
}

export function emptyHistory<T>(): History<T> {
  return { past: [], future: [] };
}

export const DEFAULT_MAX_HISTORY_LENGTH = 50;
export const DEFAULT_COALESCE_WINDOW_MS = 700;

export interface PushOptions {
  /** When true and there is already at least one past entry, this edit folds into the current step instead of creating a new undo point. */
  coalesce?: boolean;
  maxLength?: number;
}

/**
 * Records `previous` (the state right before the edit being applied) as a
 * new undo point, unless `coalesce` says to fold into the existing most
 * recent step. Always clears the redo branch — once a new edit happens,
 * whatever was undo-able-forward-into no longer reflects reality.
 */
export function pushHistory<T>(history: History<T>, previous: T, options: PushOptions = {}): History<T> {
  const maxLength = options.maxLength ?? DEFAULT_MAX_HISTORY_LENGTH;
  if (options.coalesce && history.past.length > 0) {
    // Folding into the current step: the OLDEST snapshot for this step is
    // already recorded (from the first edit in the burst), so nothing new
    // is pushed — only the redo branch needs clearing, matching a normal
    // (non-coalesced) edit.
    return { past: history.past, future: [] };
  }
  const past = [...history.past, previous].slice(-maxLength);
  return { past, future: [] };
}

export interface HistoryStepResult<T> {
  history: History<T>;
  /** The state to restore, or null if there was nothing to undo/redo. */
  value: T | null;
}

/** Pops the most recent past snapshot, pushing `current` onto the future stack so redo can return to it. */
export function undoHistory<T>(history: History<T>, current: T, maxLength = DEFAULT_MAX_HISTORY_LENGTH): HistoryStepResult<T> {
  if (history.past.length === 0) return { history, value: null };
  const previous = history.past[history.past.length - 1];
  const past = history.past.slice(0, -1);
  const future = [current, ...history.future].slice(0, maxLength);
  return { history: { past, future }, value: previous };
}

/** Pops the nearest future snapshot, pushing `current` onto the past stack so undo can return to it. */
export function redoHistory<T>(history: History<T>, current: T, maxLength = DEFAULT_MAX_HISTORY_LENGTH): HistoryStepResult<T> {
  if (history.future.length === 0) return { history, value: null };
  const [next, ...rest] = history.future;
  const past = [...history.past, current].slice(-maxLength);
  return { history: { past, future: rest }, value: next };
}

/** Whether an edit `elapsedMs` after the previous one should coalesce into the same undo step. */
export function shouldCoalesce(elapsedMs: number, coalesceWindowMs = DEFAULT_COALESCE_WINDOW_MS): boolean {
  return elapsedMs >= 0 && elapsedMs < coalesceWindowMs;
}
