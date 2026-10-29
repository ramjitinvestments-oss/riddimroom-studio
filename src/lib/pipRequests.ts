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

function dispatchPipRequest(name: PipRequestEventName, target?: DispatchTargetLike | null): boolean {
  const t = target ?? defaultTarget();
  if (!t || typeof CustomEvent === 'undefined') return false;
  t.dispatchEvent(new CustomEvent(name));
  return true;
}

/** Ask the import panel to open the camera in PiP (overlay) mode. */
export function requestRecordPip(target?: DispatchTargetLike | null): boolean {
  return dispatchPipRequest(RECORD_PIP_EVENT, target);
}

/** Ask the import panel to open its overlay file picker. */
export function requestUploadPip(target?: DispatchTargetLike | null): boolean {
  return dispatchPipRequest(UPLOAD_PIP_EVENT, target);
}

const CLAIMED = Symbol.for('rr.pipRequestClaimed');

/**
 * Claim a PiP request event for one MediaImportPanel instance.
 * Returns true for the first claimant of this exact event object,
 * false for every later one. Non-object events can never be claimed
 * twice-checked, so they are treated as unclaimed (return true) —
 * real window events are always objects.
 */
export function claimPipRequest(event: unknown): boolean {
  if ((typeof event !== 'object' && typeof event !== 'function') || event === null) return true;
  const marked = event as Record<symbol, unknown>;
  if (marked[CLAIMED]) return false;
  marked[CLAIMED] = true;
  return true;
}
