import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { createProject, listProjects, deleteProject, type ProjectSummary } from '../lib/projects/persistence';

/**
 * Phase 1 Step 6 — authenticated home screen. Replaces the placeholder
 * "Capture, upload, and the shared editor are added in the next build
 * steps" text from `App.tsx` with the actual product entry point: a list
 * of the signed-in user's projects plus "New project".
 */

interface DashboardProps {
  onOpenProject: (projectId: string) => void;
}

export function Dashboard({ onOpenProject }: DashboardProps) {
  const { currentUser, userProfile, signOut } = useAuth();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentUser) return;
    setError(null);
    try {
      const list = await listProjects(currentUser.uid);
      setProjects(list);
    } catch (err: any) {
      setError(err?.message || 'Failed to load your projects.');
    }
  }, [currentUser]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreate = useCallback(async () => {
    if (!currentUser) return;
    setIsCreating(true);
    setError(null);
    try {
      const project = await createProject(currentUser.uid, 'Untitled Project');
      onOpenProject(project.id);
    } catch (err: any) {
      setError(err?.message || 'Failed to create a new project.');
    } finally {
      setIsCreating(false);
    }
  }, [currentUser, onOpenProject]);

  const handleDelete = useCallback(
    async (projectId: string) => {
      try {
        await deleteProject(projectId);
        setProjects((list) => (list ? list.filter((p) => p.id !== projectId) : list));
      } catch (err: any) {
        setError(err?.message || 'Failed to delete project.');
      }
    },
    [],
  );

  return (
    <div className="min-h-screen bg-[#070707] text-white">
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/10">
        <h1 className="text-lg font-black uppercase tracking-tight">RiddimRoom Studio</h1>
        <div className="flex items-center gap-3 text-xs text-white/50">
          <span>{userProfile?.email || currentUser?.email}</span>
          <span className="text-emerald-400">
            {userProfile ? `${userProfile.dailyCount}/${userProfile.maxFree} today` : '…'}
          </span>
          <button onClick={signOut} className="px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg font-bold uppercase">
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-white/60">Your projects</h2>
          <button
            onClick={handleCreate}
            disabled={isCreating}
            className="px-4 py-2 text-xs font-bold uppercase tracking-wide bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg text-white"
          >
            {isCreating ? 'Creating…' : 'New project'}
          </button>
        </div>

        {error && <p className="text-sm text-red-400 mb-4">{error}</p>}

        {projects === null && !error && <p className="text-sm text-white/40">Loading projects…</p>}

        {projects !== null && projects.length === 0 && (
          <div className="text-center py-16 border border-dashed border-white/10 rounded-xl">
            <p className="text-sm text-white/40">No projects yet. Create one to start capturing, uploading, and editing.</p>
          </div>
        )}

        {projects && projects.length > 0 && (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {projects.map((project) => (
              <li
                key={project.id}
                className="group relative bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl p-4 cursor-pointer transition"
                onClick={() => onOpenProject(project.id)}
              >
                <p className="font-bold truncate">{project.name}</p>
                <p className="text-xs text-white/40 mt-1">
                  {project.canvasWidth}×{project.canvasHeight} · updated {new Date(project.updatedAt).toLocaleString()}
                </p>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete "${project.name}"? This cannot be undone.`)) handleDelete(project.id);
                  }}
                  className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-white/40 hover:text-red-400 text-xs px-2 py-1 transition"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
