/**
 * R40 P-19 — upgrade-wall navigation. Every wall (export quota,
 * duration cap, transcription quota) sits somewhere else in the
 * editor, but the plan surface (LicensingPanel) lives in Step 3.
 * Following the rr:undo-toast / rr:record-pip pattern, a wall button
 * dispatches this window event and EditorShell — the owner of the
 * step state — listens and moves to Step 3.
 */
export const OPEN_PLAN_EVENT = 'rr:open-plan';

/** Session flag for walls OUTSIDE the editor (the dashboard plan
 *  strip): set before opening a project, read once by EditorShell. */
export const OPEN_PLAN_SESSION_KEY = 'rr-open-plan';

export function requestOpenPlan(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_PLAN_EVENT));
}
