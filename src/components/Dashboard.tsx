import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { createProject, listProjects, deleteProjects, renameProject, type ProjectSummary } from '../lib/projects/persistence';
import { cleanedProjectName, filterProjectsByName } from '../lib/projects/library';
import { Check, Trash2, X } from 'lucide-react';
import { ASPECT_RATIO_OPTIONS, findAspectRatioOption, type AspectRatioOption } from '../lib/aspectRatios';
import BrandLogo from './BrandLogo';
import { useLicenseTier } from '../hooks/useLicenseTier';
import { SupportLink, SUPPORT_MAILTO } from './SupportLink';
import { requestAccountDeletion } from '../lib/accountDeletion';
import { OPEN_PLAN_SESSION_KEY } from '../lib/upgradeRequest';

/**
 * Phase 1 Step 6 — authenticated home screen. Replaces the placeholder
 * "Capture, upload, and the shared editor are added in the next build
 * steps" text from `App.tsx` with the actual product entry point: a list
 * of the signed-in user's projects plus "New project".
 */

interface DashboardProps {
  onOpenProject: (projectId: string) => void;
  /** Phase 2 (Plan v5): opens the Admin screen; the button renders only for admins. */
  onOpenAdmin?: () => void;
  /** Viral Promo mode entry point. */
  onOpenPromo?: () => void;
  /** R40 P-04: opens the public Privacy / Terms pages. */
  onOpenLegal?: (path: '/privacy' | '/terms') => void;
}

export function Dashboard({ onOpenProject, onOpenAdmin, onOpenPromo, onOpenLegal }: DashboardProps) {
  const { currentUser, userProfile, signOut, idToken } = useAuth();
  const { tier } = useLicenseTier();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  // Aspect ratio is locked in at creation (spec item 1 + item 11's mobile
  // workflow both assume a project's format never changes mid-edit) — this
  // just tracks whether the 4-option picker step is open, not any ratio
  // state itself. The chosen ratio's width/height goes straight into
  // `createProject` and becomes `Project.canvasWidth/canvasHeight`, the
  // single source of truth `lib/aspectRatios.ts` documents.
  const [showRatioPicker, setShowRatioPicker] = useState(false);
  // Multi-select cleanup mode: cards toggle selection instead of opening,
  // and a sticky action bar drives the batch delete. Deletion always goes
  // through the in-app confirm (single or batch) — never window.confirm.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<{ ids: string[]; label: string } | null>(null);
  // R40 P-27 — account deletion: the confirm dialog's two phases
  // (explain + confirm, then "request is in"). Confirming records the
  // request (fire-and-forget) — nothing is deleted by the tap itself.
  const [deleteAccountPhase, setDeleteAccountPhase] = useState<'closed' | 'confirm' | 'done'>('closed');
  const [isDeleting, setIsDeleting] = useState(false);
  // R40 P-53 — project search + rename on the home library.
  const [searchQuery, setSearchQuery] = useState('');
  const [renameTarget, setRenameTarget] = useState<ProjectSummary | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);

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

  const handleCreate = useCallback(
    async (ratio: AspectRatioOption) => {
      if (!currentUser) return;
      setIsCreating(true);
      setError(null);
      try {
        const project = await createProject(currentUser.uid, 'Untitled Project', ratio.canvasWidth, ratio.canvasHeight, { watermarkEnabled: tier !== 'lifetime' });
        setShowRatioPicker(false);
        onOpenProject(project.id);
      } catch (err: any) {
        setError(err?.message || 'Failed to create a new project.');
      } finally {
        setIsCreating(false);
      }
    },
    [currentUser, onOpenProject, tier],
  );

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelected = useCallback((projectId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);

  // R40 P-53 — rename through the same project-update path the
  // editor header uses (name + updatedAt, whole doc via saveProject,
  // inside renameProject in persistence).
  const handleConfirmRename = useCallback(async () => {
    if (!renameTarget || !currentUser) return;
    const name = cleanedProjectName(renameValue);
    if (!name) return;
    setIsRenaming(true);
    setError(null);
    try {
      const saved = await renameProject(renameTarget.id, currentUser.uid, name);
      setProjects((prev) =>
        prev
          ? prev.map((p) => (p.id === saved.id ? { ...p, name: saved.name, updatedAt: saved.updatedAt } : p))
          : prev,
      );
      setRenameTarget(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to rename project.');
      setRenameTarget(null);
    } finally {
      setIsRenaming(false);
    }
  }, [renameTarget, renameValue, currentUser]);

  const handleConfirmDelete = useCallback(async () => {
    if (!confirmDelete) return;
    const ids = confirmDelete.ids;
    setIsDeleting(true);
    setError(null);
    try {
      await deleteProjects(ids);
      setConfirmDelete(null);
      exitSelectMode();
      await refresh();
    } catch (err: any) {
      setError(err?.message || 'Failed to delete project.');
      setConfirmDelete(null);
    } finally {
      setIsDeleting(false);
    }
  }, [confirmDelete, exitSelectMode, refresh]);

  const visibleProjects = projects ? filterProjectsByName(projects, searchQuery) : null;

  return (
    <div className="min-h-screen bg-[#070707] text-white">
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/10">
        <BrandLogo size="sm" />
        <div className="flex items-center gap-3 text-xs text-white/50">
          <span className="hidden sm:inline">{userProfile?.email || currentUser?.email}</span>
          <span className="text-gold/90">
            {userProfile ? `${userProfile.dailyCount} of ${userProfile.maxFree} transcriptions used today` : 'Checking plan…'}
          </span>
          {userProfile?.isAdmin && onOpenAdmin && (
            <button
              onClick={onOpenAdmin}
              className="px-3 py-1.5 min-h-11 inline-flex items-center justify-center bg-gold/15 hover:bg-gold/25 border border-gold/60 text-gold rounded-lg font-bold uppercase"
            >
              Admin
            </button>
          )}
          <button onClick={signOut} className="px-3 py-1.5 min-h-11 inline-flex items-center justify-center bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg font-bold uppercase">
            Sign out
          </button>
        </div>
      </header>

      <main className={`max-w-3xl mx-auto px-6 py-8 ${selectMode ? 'pb-28' : ''}`}>
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <span className="px-3 py-1.5 rounded-full bg-white/10 border border-white/10 text-xs font-bold">
            Plan: {tier === 'lifetime' ? 'Lifetime' : 'Free'}
          </span>
          <span className="text-xs text-white/60">Free (Basic): projects up to 30 seconds · 3 exports a day · 2 transcription sessions a day · watermark on · Lifetime: projects up to 10 minutes · Unlimited exports · no watermark · 10 transcriptions a day</span>
          {tier !== 'lifetime' && (
            <button
              onClick={() => {
                // R40 P-19: the strip's upgrade button takes the user to
                // the plan surface (Step 3 of the editor). With projects,
                // open the most recent one with the plan flag set; with
                // none, the format picker creates one and lands there.
                try {
                  sessionStorage.setItem(OPEN_PLAN_SESSION_KEY, '1');
                } catch {
                  // Storage unavailable — the editor still opens.
                }
                if (projects && projects.length > 0) onOpenProject(projects[0].id);
                else setShowRatioPicker(true);
              }}
              className="px-4 py-2 min-h-11 inline-flex items-center justify-center text-xs font-bold uppercase tracking-wide bg-gold hover:bg-gold-bright rounded-lg text-black"
            >
              Upgrade to Lifetime
            </button>
          )}
        </div>
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 mb-6 text-xs text-white/60 space-y-1">
          <p className="font-bold text-white text-sm">How it works</p>
          <p><span className="font-bold text-white">1. Capture / Upload</span> — record, upload, or pick a template.</p>
          <p><span className="font-bold text-white">2. Edit + Captions</span> — trim, add captions, PiP overlay, text.</p>
          <p><span className="font-bold text-white">3. Export</span> — an MP4 video ready to post, or a caption file for YouTube/TikTok.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
          {onOpenPromo && (
            <button
              onClick={onOpenPromo}
              className="text-left bg-white/5 hover:bg-white/10 border border-gold/60 rounded-xl p-4 transition"
            >
              <span className="block text-sm font-bold uppercase tracking-wide text-gold">Viral Promo</span>
              <span className="block text-xs text-white/50 mt-1 leading-relaxed">
                Upload a flyer, poster or logo. We take it apart, build it back on the beat, and hand you a promo ready to post.
              </span>
            </button>
          )}
          <button
            onClick={() => setShowRatioPicker(true)}
            disabled={isCreating}
            className="text-left bg-white/5 hover:bg-white/10 disabled:opacity-50 border border-white/10 rounded-xl p-4 transition"
          >
            <span className="block text-sm font-bold uppercase tracking-wide text-white">
              {isCreating ? 'Creating…' : 'New project'}
            </span>
            <span className="block text-xs text-white/50 mt-1 leading-relaxed">
              Start blank: add your own clips and photos, add captions, and export a video ready to post.
            </span>
          </button>
          {onOpenPromo && (
            <button
              onClick={() => {
                try {
                  sessionStorage.setItem('rr-promo-start', 'poster');
                } catch {
                  // Storage unavailable — the Promo page still opens.
                }
                onOpenPromo();
              }}
              className="text-left bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl p-4 transition"
            >
              <span className="block text-sm font-bold uppercase tracking-wide text-white">Headline Poster</span>
              <span className="block text-xs text-white/50 mt-1 leading-relaxed">
                Turn your own photo into the poster format — one heavy headline, one sub-line, locked premium type over your picture.
              </span>
            </button>
          )}
        </div>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-sm font-bold uppercase tracking-wide text-white/60">Your projects</h2>
          <div className="flex items-center gap-2">
            {projects && projects.length > 0 && (
              <button
                onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
                className={`px-4 py-2 min-h-[36px] text-xs font-bold uppercase tracking-wide rounded-lg border transition ${
                  selectMode
                    ? 'bg-gold/15 border-gold/60 text-gold'
                    : 'bg-white/5 hover:bg-white/10 border-white/10 text-white/70'
                }`}
              >
                {selectMode ? 'Done' : 'Select'}
              </button>
            )}
          </div>
        </div>

        {projects && projects.length > 0 && (
          <div className="mb-4">
            <label className="block text-[11px] font-bold uppercase tracking-wide text-white/40 mb-1" htmlFor="project-search">
              Search projects
            </label>
            <input
              id="project-search"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name"
              className="w-full min-h-11 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-base text-white placeholder-white/30 focus:outline-none focus:border-gold/60"
            />
          </div>
        )}

        {error && <p className="text-sm text-red-400 mb-4">{error}</p>}

        {projects === null && !error && (
          <div>
            <p className="text-sm text-white/50 mb-3">Loading your projects…</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" aria-label="Loading projects">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="bg-white/5 border border-white/10 rounded-xl p-4 animate-pulse">
                  <div className="h-4 w-2/3 rounded bg-white/10" />
                  <div className="h-3 w-1/2 rounded bg-white/5 mt-2" />
                </div>
              ))}
            </div>
          </div>
        )}

        {projects !== null && projects.length === 0 && (
          <div className="text-center py-16 border border-dashed border-white/10 rounded-xl">
            <p className="text-sm text-white/40">No projects yet. Create one to start capturing, uploading, and editing.</p>
            <button
              onClick={() => setShowRatioPicker(true)}
              disabled={isCreating}
              className="mt-6 px-4 py-2 min-h-11 inline-flex items-center justify-center text-xs font-bold uppercase tracking-wide bg-gold hover:bg-gold-bright disabled:opacity-50 rounded-lg text-black"
            >
              {isCreating ? 'Creating…' : 'Create your first project'}
            </button>
          </div>
        )}

        {projects && projects.length > 0 && visibleProjects && visibleProjects.length === 0 && (
          <p className="text-sm text-white/40 text-center py-10 border border-dashed border-white/10 rounded-xl">
            No projects match your search.
          </p>
        )}

        {visibleProjects && visibleProjects.length > 0 && (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {visibleProjects.map((project) => {
              const ratio = findAspectRatioOption(project.canvasWidth, project.canvasHeight);
              const metaLine = `${ratio ? `${ratio.ratioLabel} ${ratio.name}` : `${project.canvasWidth}×${project.canvasHeight}`} · updated ${new Date(project.updatedAt).toLocaleString()}`;
              const isSelected = selectedIds.has(project.id);
              return (
                <li
                  key={project.id}
                  className={`group relative bg-white/5 hover:bg-white/10 border rounded-xl overflow-hidden cursor-pointer transition ${
                    isSelected ? 'border-gold ring-2 ring-gold' : 'border-white/10'
                  }`}
                  onClick={() => (selectMode ? toggleSelected(project.id) : onOpenProject(project.id))}
                >
                  {/* Card cover (polish batch 2): the project's saved poster
                      when it has one; otherwise a designed branded cover —
                      never a bare text row. Name + meta sit on a black
                      gradient at the bottom either way. */}
                  <div className="relative aspect-video w-full bg-black">
                    {project.posterDataUrl ? (
                      <img src={project.posterDataUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
                    ) : (
                      <div className="absolute inset-0 bg-gradient-to-br from-[#1c1c1c] via-[#0a0a0a] to-black flex flex-col items-center justify-center gap-2 px-4">
                        <BrandLogo size="sm" />
                        <span className="text-gold font-bold text-sm truncate max-w-full">{project.name}</span>
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/45 to-transparent px-4 pt-8 pb-3">
                      {project.posterDataUrl && <p className="font-bold truncate">{project.name}</p>}
                      <p className={`text-xs text-white/50 ${project.posterDataUrl ? 'mt-0.5' : ''}`}>{metaLine}</p>
                    </div>
                  </div>
                  {selectMode ? (
                    <span
                      aria-hidden="true"
                      className={`absolute top-2 left-2 z-10 flex items-center justify-center w-8 h-8 rounded-lg border backdrop-blur transition ${
                        isSelected ? 'bg-gold border-gold text-black' : 'bg-black/60 border-white/30 text-transparent'
                      }`}
                    >
                      <Check size={18} strokeWidth={3} />
                    </span>
                  ) : (
                    <>
                    <button
                      type="button"
                      aria-label={`Rename ${project.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenameValue(project.name);
                        setRenameTarget(project);
                      }}
                      className="absolute top-2 left-2 z-10 flex items-center justify-center min-h-[36px] px-2.5 rounded-lg bg-black/60 hover:bg-black/85 backdrop-blur text-white/80 hover:text-white text-[11px] font-bold transition"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${project.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete({ ids: [project.id], label: project.name });
                      }}
                      className="absolute top-2 right-2 z-10 flex items-center justify-center min-w-[36px] min-h-[36px] w-9 h-9 rounded-lg bg-black/60 hover:bg-black/85 backdrop-blur text-red-400/90 hover:text-red-400 transition"
                    >
                      <Trash2 size={18} />
                    </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <footer className="mt-10 border-t border-white/10 pt-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-1">
          <SupportLink />
          <button
            onClick={() => setDeleteAccountPhase('confirm')}
            className="min-h-11 inline-flex items-center text-xs font-bold text-white/60 hover:text-red-300"
          >
            Delete my account
          </button>
          {onOpenLegal && (
            <>
              <button onClick={() => onOpenLegal('/privacy')} className="min-h-11 inline-flex items-center text-xs font-bold text-white/60 hover:text-white">
                Privacy
              </button>
              <button onClick={() => onOpenLegal('/terms')} className="min-h-11 inline-flex items-center text-xs font-bold text-white/60 hover:text-white">
                Terms
              </button>
            </>
          )}
        </footer>
      </main>

      {selectMode && (
        <div className="fixed bottom-0 inset-x-0 z-40 bg-[#0a0a0a]/95 backdrop-blur border-t border-white/10">
          <div className="max-w-3xl mx-auto px-6 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] flex items-center gap-3">
            <span className="text-sm font-bold text-white/80">{selectedIds.size} selected</span>
            <div className="flex-1" />
            <button
              onClick={exitSelectMode}
              className="px-4 py-2 min-h-[40px] text-xs font-bold uppercase tracking-wide bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-white/70"
            >
              Cancel
            </button>
            <button
              onClick={() =>
                setConfirmDelete({
                  ids: [...selectedIds],
                  label: `${selectedIds.size} project${selectedIds.size === 1 ? '' : 's'}`,
                })
              }
              disabled={selectedIds.size === 0}
              className="px-4 py-2 min-h-[40px] text-xs font-bold uppercase tracking-wide bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:hover:bg-red-600 rounded-lg text-white"
            >
              Delete selected
            </button>
          </div>
        </div>
      )}

      {renameTarget && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => !isRenaming && setRenameTarget(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Rename project"
            className="bg-[#111] border border-white/10 rounded-2xl p-6 max-w-sm w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 mb-2">
              <h2 className="font-bold text-base">Rename project</h2>
              <button
                onClick={() => !isRenaming && setRenameTarget(null)}
                disabled={isRenaming}
                aria-label="Cancel"
                className="text-white/40 hover:text-white/70 disabled:opacity-50 -mt-1 -mr-1 p-1"
              >
                <X size={18} />
              </button>
            </div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-white/40 mb-1" htmlFor="project-rename">
              Project name
            </label>
            <input
              id="project-rename"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              className="w-full min-h-11 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-base text-white focus:outline-none focus:border-gold/60 mb-6"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setRenameTarget(null)}
                disabled={isRenaming}
                className="flex-1 px-4 py-2.5 min-h-[44px] text-xs font-bold uppercase tracking-wide bg-white/5 hover:bg-white/10 disabled:opacity-50 border border-white/10 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleConfirmRename()}
                disabled={isRenaming || !cleanedProjectName(renameValue)}
                className="flex-1 px-4 py-2.5 min-h-[44px] text-xs font-bold uppercase tracking-wide bg-gold hover:bg-gold-bright disabled:opacity-50 rounded-lg text-black"
              >
                {isRenaming ? 'Renaming…' : 'Save name'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => !isDeleting && setConfirmDelete(null)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="Confirm project deletion"
            className="bg-[#111] border border-white/10 rounded-2xl p-6 max-w-sm w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 mb-2">
              <h2 className="font-bold text-base">
                {confirmDelete.ids.length === 1 ? (
                  <>Delete &ldquo;{confirmDelete.label}&rdquo;?</>
                ) : (
                  <>Delete {confirmDelete.label}?</>
                )}
              </h2>
              <button
                onClick={() => !isDeleting && setConfirmDelete(null)}
                disabled={isDeleting}
                aria-label="Cancel"
                className="text-white/40 hover:text-white/70 disabled:opacity-50 -mt-1 -mr-1 p-1"
              >
                <X size={18} />
              </button>
            </div>
            <p className="text-sm text-white/50 mb-6">This can&rsquo;t be undone.</p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                disabled={isDeleting}
                className="flex-1 px-4 py-2.5 min-h-[44px] text-xs font-bold uppercase tracking-wide bg-white/5 hover:bg-white/10 disabled:opacity-50 border border-white/10 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                className="flex-1 px-4 py-2.5 min-h-[44px] text-xs font-bold uppercase tracking-wide bg-red-600 hover:bg-red-500 disabled:opacity-50 rounded-lg text-white"
              >
                {isDeleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteAccountPhase !== 'closed' && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setDeleteAccountPhase('closed')}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label="Delete my account"
            className="bg-[#111] border border-white/10 rounded-2xl p-6 max-w-sm w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-bold text-base mb-2">Delete my account?</h2>
            {deleteAccountPhase === 'confirm' ? (
              <>
                <p className="text-sm text-white/50 mb-4">
                  Deleting removes your account, your projects, and the files you uploaded. The owner
                  completes it by hand — nothing is deleted the moment you tap, and it can&rsquo;t be
                  undone once it&rsquo;s done.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setDeleteAccountPhase('closed')}
                    className="flex-1 px-4 py-2.5 min-h-[44px] text-xs font-bold uppercase tracking-wide bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      requestAccountDeletion(idToken);
                      setDeleteAccountPhase('done');
                    }}
                    className="flex-1 px-4 py-2.5 min-h-[44px] text-xs font-bold uppercase tracking-wide bg-red-600 hover:bg-red-500 rounded-lg text-white"
                  >
                    Request deletion
                  </button>
                </div>
                <a href={SUPPORT_MAILTO} className="mt-3 min-h-11 flex items-center justify-center text-xs font-bold text-gold hover:underline">
                  or email us now
                </a>
              </>
            ) : (
              <>
                <p className="text-sm text-white/50 mb-4">
                  Your request is in. The owner will complete it and email you if anything is needed.
                  You can keep using Studio until then.
                </p>
                <button
                  onClick={() => setDeleteAccountPhase('closed')}
                  className="w-full px-4 py-2.5 min-h-[44px] text-xs font-bold uppercase tracking-wide bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg"
                >
                  Close
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {showRatioPicker && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => !isCreating && setShowRatioPicker(false)}
        >
          <div
            className="bg-[#111] border border-white/10 rounded-2xl p-6 max-w-xl w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-bold uppercase tracking-wide text-white/60 mb-1">Choose a format</h2>
            <p className="text-xs text-white/40 mb-5">
              This sets your project's shape for preview, positioning, and export — pick the one that matches where the video is going.
            </p>
            <p className="text-sm text-white/70 mb-4">Not sure? Start with Vertical — it's what TikTok/Reels use.</p>
            <div className="grid grid-cols-2 gap-3">
              {ASPECT_RATIO_OPTIONS.map((ratio) => (
                <button
                  key={ratio.id}
                  onClick={() => handleCreate(ratio)}
                  disabled={isCreating}
                  className="text-left bg-white/5 hover:bg-white/10 disabled:opacity-50 border border-white/10 hover:border-gold/60 rounded-xl p-4 transition flex flex-col items-center gap-3"
                >
                  <RatioGlyph ratioW={ratio.canvasWidth} ratioH={ratio.canvasHeight} />
                  <div className="text-center">
                    <p className="font-bold">{ratio.name}</p>
                    <p className="text-xs text-white/40">{ratio.ratioLabel}</p>
                    <p className="text-[10px] text-white/30 mt-1 leading-snug">{ratio.useCases.join(' · ')}</p>
                  </div>
                </button>
              ))}
            </div>
            {error && <p className="text-sm text-red-400 mt-4">{error}</p>}
            <button
              onClick={() => setShowRatioPicker(false)}
              disabled={isCreating}
              className="mt-5 text-xs text-white/40 hover:text-white/70 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Small proportional-rectangle glyph for a ratio card — no icon library needed, just an SVG sized to the actual ratio. */
function RatioGlyph({ ratioW, ratioH }: { ratioW: number; ratioH: number }) {
  const maxSide = 40;
  const scale = maxSide / Math.max(ratioW, ratioH);
  const w = Math.round(ratioW * scale);
  const h = Math.round(ratioH * scale);
  return (
    <svg width={maxSide + 8} height={maxSide + 8} viewBox={`0 0 ${maxSide + 8} ${maxSide + 8}`} aria-hidden="true">
      <rect
        x={(maxSide + 8 - w) / 2}
        y={(maxSide + 8 - h) / 2}
        width={w}
        height={h}
        rx={2}
        className="fill-gold/20 stroke-gold"
        strokeWidth={1.5}
      />
    </svg>
  );
}
