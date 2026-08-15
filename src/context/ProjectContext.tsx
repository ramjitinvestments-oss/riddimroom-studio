import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Project } from '../types/timeline';
import { loadProject, saveProject } from '../lib/projects/persistence';

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
}

const ProjectContext = createContext<ProjectContextValue | undefined>(undefined);

export function ProjectProvider({
  projectId,
  ownerUid,
  children,
}: {
  projectId: string;
  ownerUid: string;
  children: React.ReactNode;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const projectRef = useRef<Project | null>(null);

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
    setProject((current) => {
      if (!current) return current;
      const next = updater(current);
      projectRef.current = next;
      return next;
    });
    setIsDirty(true);
  }, []);

  const save = useCallback(async () => {
    const current = projectRef.current;
    if (!current) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const saved = await saveProject(current);
      setProject(saved);
      projectRef.current = saved;
      setLastSavedAt(saved.updatedAt);
      setIsDirty(false);
    } catch (err: any) {
      setSaveError(err?.message || 'Failed to save project.');
    } finally {
      setIsSaving(false);
    }
  }, []);

  return (
    <ProjectContext.Provider
      value={{ project, isLoading, loadError, isSaving, saveError, isDirty, lastSavedAt, mutate, save, reload: load }}
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
