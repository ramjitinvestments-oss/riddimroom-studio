import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Project } from '../types/timeline';
import { loadProject, saveProject } from '../lib/projects/persistence';
import { getProjectPoster } from '../lib/media/thumbnails';
import { emptyHistory, pushHistory, undoHistory, redoHistory, shouldCoalesce, type History } from '../lib/history';
import { getProjectDuration, projectDurationExceedsLimit } from '../lib/timeline/utils';
import {
  readLocalDraft,
  writeLocalDraft,
  clearLocalDraft,
  isDraftNewerThan,
  draftSupersededBySave,
  saveRetryDelayMs,
  type LocalDraft,
  type SavePhase,
} from '../lib/projects/localDraft';
import { MAX_MEDIA_SECONDS } from '../lib/media/constants';

/**
 * Phase 1 Step 6 (Shared editor shell) — holds the single `Project` the
 * editor is working on, in the same "React context with a shared shape"
 * pattern `AuthContext` already established. Every panel (import, overlays,
 * transcription, export, timeline) reads/mutates through this context
 * instead of keeping its own parallel copy of project state, per the
 * explicit requirement not to introduce a second timeline representation.
 *
 * `mutate` takes a pure `(project) => project` updater (mirroring the
 * timeline foundation's own pure functions — `addItem`, `addTrack`, etc. —
 * which all return a new Project rather than mutating in place) and marks
 * the project dirty. Saving is explicit (`save()`) rather than autosave on
 * every keystroke, so a caption-text edit-in-progress doesn't spam
 * Firestore writes; callers debounce or trigger save at natural points
 * (blur, "Save" button, before export).
 *
 * Undo/redo (added in the "final editor completion" pass): every `mutate`
 * call now also records a history snapshot via `lib/history` — no caller
 * (TimelinePanel, ItemInspector, TranscribePanel, etc.) needed to change,
 * since `mutate`'s own signature is unchanged. History lives in a ref
 * (`historyRef`), not React state, because snapshotting on every `mutate`
 * already forces a re-render via `setProject`; `historyVersion` is a tiny
 * extra state bump solely so `canUndo`/`canRedo` recompute on undo/redo
 * calls that don't otherwise change `project` identity in a way consumers
 * would notice (they do, but this makes the intent explicit and cheap).
 */

interface ProjectContextValue {
  project: Project | null;
  isLoading: boolean;
  loadError: string | null;
  isSaving: boolean;
  saveError: string | null;
  isDirty: boolean;
  lastSavedAt: number | null;
  mutate: (updater: (project: Project) => Project) => void;
  save: () => Promise<void>;
  reload: () => Promise<void>;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /**
   * "Universal 30-second media standard" spec item 4 — set by `mutate`
   * whenever an edit was BLOCKED because it would have pushed the project's
   * total duration past `MAX_MEDIA_SECONDS` (e.g. arranging several
   * already-in-limit clips so they'd sum to more than the cap). Null when
   * there's nothing to show. This is how "the user should understand WHY an
   * operation cannot exceed the limit" surfaces in the editor — see the
   * banner in `EditorShell`.
   */
  projectLimitWarning: string | null;
  dismissProjectLimitWarning: () => void;
  /** R40 P-13: the save lifecycle phase behind the save-state line's plain words. */
  savePhase: SavePhase;
  /** R40 P-13: a newer device-local copy worth offering back, or null. */
  restoreOffer: LocalDraft | null;
  /** R40 P-13: load the offered device copy (one undo-able step, never a silent overwrite). */
  restoreDraft: () => void;
  /** R40 P-13: keep the cloud-saved version and drop the device copy. */
  dismissRestoreOffer: () => void;
}

const ProjectContext = createContext<ProjectContextValue | undefined>(undefined);

export function ProjectProvider({
  projectId,
  ownerUid,
  children,
  onSaveFinalFailure,
}: {
  projectId: string;
  ownerUid: string;
  children: React.ReactNode;
  /** R40 P-28: called once when a save gives up retrying (the final failed state). */
  onSaveFinalFailure?: () => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const projectRef = useRef<Project | null>(null);
  const historyRef = useRef<History<Project>>(emptyHistory());
  const lastEditAtRef = useRef<number>(0);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [projectLimitWarning, setProjectLimitWarning] = useState<string | null>(null);
  // R40 P-13 — local recovery + self-retrying saves.
  const [savePhase, setSavePhaseState] = useState<SavePhase>('idle');
  const savePhaseRef = useRef<SavePhase>('idle');
  const setSavePhase = useCallback((phase: SavePhase) => {
    savePhaseRef.current = phase;
    setSavePhaseState(phase);
  }, []);
  const [restoreOffer, setRestoreOffer] = useState<LocalDraft | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptRef = useRef(0);
  const saveRunningRef = useRef(false);
  const finalFailureNotifiedRef = useRef(false);
  const onSaveFinalFailureRef = useRef(onSaveFinalFailure);
  onSaveFinalFailureRef.current = onSaveFinalFailure;
  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const result = await loadProject(projectId, ownerUid);
      if (result.project) {
        setProject(result.project);
        projectRef.current = result.project;
        setLastSavedAt(result.project.updatedAt);
        setIsDirty(false);
        setSavePhase('idle');
        // R40 P-13: a device copy NEWER than what just loaded means a
        // save never landed (or the tab died) — offer it back instead
        // of silently opening the older version. A draft the loaded
        // copy already covers is superseded and cleared.
        const draft = readLocalDraft(projectId);
        if (isDraftNewerThan(draft, result.project.updatedAt)) {
          setRestoreOffer(draft);
        } else {
          setRestoreOffer(null);
          if (draftSupersededBySave(draft, result.project.updatedAt)) clearLocalDraft(projectId);
        }
        // A freshly-loaded project starts with a clean slate — undoing past
        // it would have nothing meaningful to restore to.
        historyRef.current = emptyHistory();
        lastEditAtRef.current = 0;
        setHistoryVersion((v) => v + 1);
      } else {
        setLoadError(result.error || 'Failed to load project.');
      }
    } catch (err: any) {
      setLoadError(err?.message || 'Failed to load project.');
    } finally {
      setIsLoading(false);
    }
  }, [projectId, ownerUid]);

  // Loads on mount and whenever projectId changes — this, plus persistence
  // living in Firestore rather than only React state, is what makes a
  // project survive a full page refresh.
  useEffect(() => {
    load();
  }, [load]);

  const mutate = useCallback((updater: (project: Project) => Project) => {
    // "Universal 30-second media standard" spec item 4 — the PROJECT-level
    // duration guard. This is the single choke point every editor mutation
    // already flows through (every panel calls `mutate`, per this file's
    // header comment), so it's the one place to enforce "never silently
    // create a project longer than 30 seconds" without touching every
    // individual call site. An edit is blocked only if it would push the
    // total duration past the limit AND make it longer than it already was
    // — a project that's already over the limit (e.g. legacy data from
    // before this guard existed) can still be freely edited/shortened, just
    // never pushed further out. `blocked` is read after `setProject`
    // resolves; the updater callback itself must stay pure (it may run
    // twice under React StrictMode), which is why the side effect is just
    // recording a boolean rather than mutating anything external.
    let blocked = false;
    setProject((current) => {
      if (!current) return current;
      const next = updater(current);
      const nextDuration = getProjectDuration(next);
      const currentDuration = getProjectDuration(current);
      if (projectDurationExceedsLimit(next) && nextDuration > currentDuration + 0.05) {
        blocked = true;
        return current;
      }
      const now = Date.now();
      // Coalesce a burst of rapid edits (one continuous clip drag firing
      // `mutate` on every mousemove, or one continuous typing burst firing
      // it on every keystroke) into a single undo step — see lib/history's
      // header comment for why this matters.
      const coalesce = shouldCoalesce(now - lastEditAtRef.current);
      historyRef.current = pushHistory(historyRef.current, current, { coalesce });
      lastEditAtRef.current = now;
      projectRef.current = next;
      return next;
    });
    if (blocked) {
      setProjectLimitWarning(
        `That would make this project longer than the ${MAX_MEDIA_SECONDS}-second limit. Trim, shorten, or remove a clip first.`,
      );
      return;
    }
    setProjectLimitWarning(null);
    setIsDirty(true);
    setHistoryVersion((v) => v + 1);
    // R40 P-13: a new edit restarts the save-retry cycle — any pending
    // retry is dropped (the coming autosave covers the new state) and
    // a save that had given up gets a fresh set of attempts.
    retryAttemptRef.current = 0;
    finalFailureNotifiedRef.current = false;
    clearRetryTimer();
    if (savePhaseRef.current === 'retrying' || savePhaseRef.current === 'waiting-offline' || savePhaseRef.current === 'failed') {
      setSavePhase('idle');
    }
  }, [clearRetryTimer, setSavePhase]);

  const dismissProjectLimitWarning = useCallback(() => setProjectLimitWarning(null), []);

  const undo = useCallback(() => {
    setProject((current) => {
      if (!current) return current;
      const result = undoHistory(historyRef.current, current);
      if (result.value === null) return current;
      historyRef.current = result.history;
      projectRef.current = result.value;
      return result.value;
    });
    // Reset the coalescing clock so the NEXT edit always starts a fresh
    // history step rather than folding into whatever step undo just
    // restored — otherwise a quick edit right after undo could silently
    // merge into (and destroy) the just-restored snapshot.
    lastEditAtRef.current = 0;
    setIsDirty(true);
    setHistoryVersion((v) => v + 1);
  }, []);

  const redo = useCallback(() => {
    setProject((current) => {
      if (!current) return current;
      const result = redoHistory(historyRef.current, current);
      if (result.value === null) return current;
      historyRef.current = result.history;
      projectRef.current = result.value;
      return result.value;
    });
    lastEditAtRef.current = 0;
    setIsDirty(true);
    setHistoryVersion((v) => v + 1);
  }, []);

  // One save attempt (poster refresh + the Firestore write, exactly
  // as before). Returns whether the cloud copy now holds this work;
  // the retry policy lives in `save` below, not here.
  const performSaveAttempt = useCallback(async (): Promise<boolean> => {
    const current = projectRef.current;
    if (!current) return true;
    setIsSaving(true);
    setSaveError(null);
    setSavePhase('saving');
    try {
      // Dashboard poster refresh (polish batch 2): regenerate from the
      // project's first visual asset and ride along on this save, so the
      // dashboard card always shows a current cover. Strictly best-effort
      // — the thumbnails service resolves null on any failure (and is
      // cache-hot when the timeline already generated this asset's
      // poster), and a null result keeps whatever poster the project
      // already had. It must never block or fail the save itself.
      let toSave = current;
      try {
        const poster = await getProjectPoster(current);
        if (poster && poster !== current.posterDataUrl) {
          toSave = { ...current, posterDataUrl: poster };
        }
      } catch {
        /* poster generation is cosmetic — ignore and save without it */
      }
      const saved = await saveProject(toSave);
      setProject(saved);
      projectRef.current = saved;
      setLastSavedAt(saved.updatedAt);
      setIsDirty(false);
      setSavePhase('saved');
      retryAttemptRef.current = 0;
      finalFailureNotifiedRef.current = false;
      // The cloud now holds this work: a device draft it covers is
      // superseded and cleared (a NEWER draft — edited while this
      // save was in flight — is kept).
      const draft = readLocalDraft(saved.id);
      if (draftSupersededBySave(draft, saved.updatedAt)) clearLocalDraft(saved.id);
      if (restoreOffer && draftSupersededBySave(restoreOffer, saved.updatedAt)) setRestoreOffer(null);
      return true;
    } catch (err: any) {
      // Never surface the raw error: the save-state line speaks plain
      // words (localDraft.saveStatusText), and the work itself is
      // kept as a device draft below so a failure loses nothing.
      console.error('[ProjectContext] save failed:', err?.message || err);
      const latest = projectRef.current;
      if (latest) writeLocalDraft({ ...latest, updatedAt: Date.now() });
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [restoreOffer]);

  // R40 P-13: after the last retry the save is in its final failed
  // state — the line says the copy is kept on this device, and the
  // P-28 failure count fires exactly here, once, not per attempt.
  const MAX_SAVE_RETRIES = 6;
  const scheduleSaveRetry = useCallback(() => {
    if (retryAttemptRef.current >= MAX_SAVE_RETRIES) {
      setSavePhase('failed');
      setSaveError("Couldn't save — your latest copy is kept on this device");
      if (!finalFailureNotifiedRef.current) {
        finalFailureNotifiedRef.current = true;
        onSaveFinalFailureRef.current?.();
      }
      return;
    }
    const delay = saveRetryDelayMs(retryAttemptRef.current);
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    setSavePhase(offline ? 'waiting-offline' : 'retrying');
    clearRetryTimer();
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      retryAttemptRef.current += 1;
      void (async () => {
        if (saveRunningRef.current) { scheduleSaveRetry(); return; }
        saveRunningRef.current = true;
        try {
          const ok = await performSaveAttempt();
          if (!ok) scheduleSaveRetry();
        } finally {
          saveRunningRef.current = false;
        }
      })();
    }, delay);
  }, [performSaveAttempt, clearRetryTimer, setSavePhase]);

  const save = useCallback(async () => {
    if (saveRunningRef.current) return;
    clearRetryTimer();
    retryAttemptRef.current = 0;
    finalFailureNotifiedRef.current = false;
    saveRunningRef.current = true;
    try {
      const ok = await performSaveAttempt();
      if (!ok) scheduleSaveRetry();
    } finally {
      saveRunningRef.current = false;
    }
  }, [performSaveAttempt, scheduleSaveRetry, clearRetryTimer]);

  // R40 P-13: keep the device draft on the autosave cadence — every
  // dirty project state is copied locally (stamped with the edit
  // time, which is what "newer" is measured against on the next open).
  useEffect(() => {
    if (!project || !isDirty) return;
    writeLocalDraft({ ...project, updatedAt: Date.now() });
  }, [project, isDirty]);

  // Coming back online hurries a waiting save along — a help, never a
  // dependency: the backoff loop above runs either way.
  useEffect(() => {
    const onOnline = () => {
      if ((savePhaseRef.current === 'waiting-offline' || savePhaseRef.current === 'retrying') && projectRef.current) {
        void save();
      }
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [save]);

  // R40 P-13: restoring is one undo-able load — the current project is
  // pushed onto the history stack first, so Undo brings it straight
  // back. The restored copy is dirty: the autosave sends it to the
  // cloud like any other edit.
  const restoreDraft = useCallback(() => {
    const offer = restoreOffer;
    if (!offer) return;
    const current = projectRef.current;
    if (current) {
      historyRef.current = pushHistory(historyRef.current, current, { coalesce: false });
    }
    lastEditAtRef.current = 0;
    setProject(offer.project);
    projectRef.current = offer.project;
    setIsDirty(true);
    setSavePhase('idle');
    retryAttemptRef.current = 0;
    finalFailureNotifiedRef.current = false;
    setHistoryVersion((v) => v + 1);
    setRestoreOffer(null);
  }, [restoreOffer, setSavePhase]);

  const dismissRestoreOffer = useCallback(() => {
    clearLocalDraft(projectId);
    setRestoreOffer(null);
  }, [projectId]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- historyVersion exists solely to force this recompute
  const canUndo = historyRef.current.past.length > 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const canRedo = historyRef.current.future.length > 0;
  void historyVersion; // referenced only to satisfy the "why does this re-render" reader; canUndo/canRedo are read fresh from the ref every render

  return (
    <ProjectContext.Provider
      value={{
        project,
        isLoading,
        loadError,
        isSaving,
        saveError,
        isDirty,
        lastSavedAt,
        mutate,
        save,
        reload: load,
        undo,
        redo,
        canUndo,
        canRedo,
        projectLimitWarning,
        dismissProjectLimitWarning,
        savePhase,
        restoreOffer,
        restoreDraft,
        dismissRestoreOffer,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject must be used within a ProjectProvider');
  return ctx;
}
