/**
 * R40 P-13 — device-local recovery draft for the OPEN project.
 *
 * The cloud save (Firestore, see persistence.ts) stays the source of
 * truth. This module keeps ONE extra copy of the open project on the
 * device itself (localStorage), written on the same cadence as the
 * autosave, so a failed save or a dead tab no longer loses the work:
 * when the project is opened again and the device copy is NEWER than
 * the copy that loaded, the editor offers it back in plain words.
 *
 * Why localStorage and not IndexedDB: a serialized Project is plain
 * JSON of ids, timing and settings — the media itself lives in cloud
 * storage and is referenced by URL, never embedded — so a project is
 * small (the poster's data URL is the largest field by far). The
 * codebase's other device-local state (brand kit, counters, plan
 * flags) is all localStorage for the same reason. Every write is
 * quota-guarded: if the copy does not fit, it is skipped silently —
 * the cloud save is unaffected either way.
 *
 * The draft is keyed by project id and carries the project's own
 * `updatedAt` (the timestamp the cloud save would have written), so
 * "newer" means exactly one thing everywhere: a bigger `updatedAt`.
 * Once a cloud save confirms a copy with an equal-or-newer
 * `updatedAt`, the draft is superseded and cleared.
 */

import type { Project } from '../../types/timeline';

export const LOCAL_DRAFT_KEY_PREFIX = 'rr:draft:';

export function localDraftKey(projectId: string): string {
  return `${LOCAL_DRAFT_KEY_PREFIX}${projectId}`;
}

export interface LocalDraft {
  project: Project;
  /** When this copy was written to the device (epoch ms). */
  savedAt: number;
}

/** The smallest storage shape this module needs — localStorage in the app, a fake in tests. */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): DraftStorage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Keep a device copy of `project`. Returns true when the copy was
 * written. Any failure (no storage, full storage, unserializable
 * project) returns false and never throws — a draft is a safety net,
 * never a new way for an edit to fail.
 */
export function writeLocalDraft(project: Project, storage: DraftStorage | null = defaultStorage(), now: number = Date.now()): boolean {
  if (!storage || !project?.id) return false;
  try {
    const draft: LocalDraft = { project, savedAt: now };
    storage.setItem(localDraftKey(project.id), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

/** Read the device copy for a project, or null when there is none (or it is unreadable). */
export function readLocalDraft(projectId: string, storage: DraftStorage | null = defaultStorage()): LocalDraft | null {
  if (!storage || !projectId) return null;
  try {
    const raw = storage.getItem(localDraftKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalDraft;
    if (!parsed || typeof parsed !== 'object' || !parsed.project || parsed.project.id !== projectId) return null;
    if (typeof parsed.project.updatedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Drop the device copy (the cloud save has caught up, or the user chose the saved version). */
export function clearLocalDraft(projectId: string, storage: DraftStorage | null = defaultStorage()): void {
  if (!storage || !projectId) return;
  try {
    storage.removeItem(localDraftKey(projectId));
  } catch {
    // Nothing to clean up if storage itself is unavailable.
  }
}

/**
 * The restore-offer decision: a draft is worth offering only when it
 * is strictly NEWER than the copy that just loaded. Equal means the
 * cloud save already holds this work; older means the draft is stale.
 */
export function isDraftNewerThan(draft: LocalDraft | null, loadedUpdatedAt: number): boolean {
  return !!draft && draft.project.updatedAt > loadedUpdatedAt;
}

/**
 * After a confirmed cloud save: the draft is superseded (and cleared)
 * when the saved copy is newer-or-equal to it. An older confirmed save
 * (a slow earlier write landing after a newer draft) must NOT clear
 * the newer draft.
 */
export function draftSupersededBySave(draft: LocalDraft | null, savedUpdatedAt: number): boolean {
  return !!draft && savedUpdatedAt >= draft.project.updatedAt;
}

// ---------------------------------------------------------------------------
// Save retry schedule (P-13): a failed save retries on its own with
// backoff — 2s, 5s, 15s, then every 30s — until it succeeds or a new
// edit restarts the cycle. The loop never depends on online/offline
// events; those only ever hurry it along.
// ---------------------------------------------------------------------------

export const SAVE_RETRY_DELAYS_MS: readonly number[] = [2000, 5000, 15000, 30000];

/** Delay before retry number `attempt` (0-based), capped at the last step. */
export function saveRetryDelayMs(attempt: number): number {
  const idx = Math.max(0, Math.min(attempt, SAVE_RETRY_DELAYS_MS.length - 1));
  return SAVE_RETRY_DELAYS_MS[idx];
}

export type SavePhase = 'idle' | 'saving' | 'saved' | 'retrying' | 'waiting-offline' | 'failed';

/**
 * The save-state line's words, in plain language — never a raw error
 * string. `saved` keeps the long-standing "Saved · {time}" shape.
 */
export function saveStatusText(phase: SavePhase, lastSavedAt: number | null, formatTime: (t: number) => string): string {
  switch (phase) {
    case 'saving':
      return 'Saving…';
    case 'retrying':
      return "Couldn't save — retrying…";
    case 'waiting-offline':
      return "Saved on this device — will send when you're back online";
    case 'failed':
      return "Couldn't save — your latest copy is kept on this device";
    case 'saved':
      return lastSavedAt ? `Saved · ${formatTime(lastSavedAt)}` : 'Saved';
    default:
      return lastSavedAt ? `Saved · ${formatTime(lastSavedAt)}` : '';
  }
}
