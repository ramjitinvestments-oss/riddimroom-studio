import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { createProject, listProjects, deleteProjects, type ProjectSummary } from '../lib/projects/persistence';
import { Check, Trash2, X } from 'lucide-react';
import { ASPECT_RATIO_OPTIONS, findAspectRatioOption, type AspectRatioOption } from '../lib/aspectRatios';
import BrandLogo from './BrandLogo';
import { useLicenseTier } from '../hooks/useLicenseTier';

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
}

export function Dashboard({ onOpenProject, onOpenAdmin, onOpenPromo }: DashboardProps) {
  const { currentUser, userProfile, signOut } = useAuth();
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
  const [isDeleting, setIsDeleting] = useState(false);

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

  return (
    <div className="min-h-screen bg-[#070707] text-white">
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/10">
        <BrandLogo size="sm" />
        <div className="flex items-center gap-3 text-xs text-white/50">
          <span className="hidden sm:inline">{userProfile?.email || currentUser?.email}</span>
          <span className="text-gold/90">
            {userProfile ? `${userProfile.dailyCount}/${userProfile.maxFree} today` : '…'}
          </span>
          {userProfile?.isAdmin && onOpenAdmin && (
            <button
              onClick={onOpenAdmin}
              className="px-3 py-1.5 bg-gold/15 hover:bg-gold/25 border border-gold/60 text-gold rounded-lg font-bold uppercase"
            >
              Admin
            </button>
          )}
          <button onClick={signOut} className="px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg font-bold uppercase">
            Sign out
          </button>
        </div>
      </header>

      <main className={`max-w-3xl mx-auto px-6 py-8 ${selectMode ? 'pb-28' : ''}`}>
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <span className="px-3 py-1.5 rounded-full bg-white/10 border border-white/10 text-xs font-bold">
            Plan: {tier === 'lifetime' ? 'Lifetime' : 'Free'}
          </span>
          <span className="text-xs text-white/40">Free: 30s projects · 3 exports/day · watermark · Lifetime: up to 10 min · no watermark · all templates</span>
        </div>
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 mb-6 text-xs text-white/60 space-y-1">
          <p className="font-bold text-white text-sm">How it works</p>
          <p><span className="font-bold text-white">1. Capture / Upload</span> — record, upload, or pick a template.</p>
          <p><span className="font-bold text-white">2. Edit + Captions</span> — trim, add captions, PiP overlay, text.</p>
          <p><span className="font-bold text-white">3. Export</span> — MP4 (H.264 + AAC) or SRT/VTT captions.</p>
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
            {onOpenPromo && (
              <button
                onClick={onOpenPromo}
                className="px-4 py-2 min-h-[36px] text-xs font-bold uppercase tracking-wide bg-gold/15 hover:bg-gold/25 border border-gold/60 text-gold rounded-lg"
              >
                Viral Promo
              </button>
            )}
            <button
              onClick={() => setShowRatioPicker(true)}
              disabled={isCreating}
              className="px-4 py-2 min-h-[36px] text-xs font-bold uppercase tracking-wide bg-gold hover:bg-gold-bright disabled:opacity-50 rounded-lg text-black"
            >
              {isCreating ? 'Creating…' : 'New project'}
            </button>
          </div>
        </div>

        {error && <p className="text-sm text-red-400 mb-4">{error}</p>}

        {projects === null && !error && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" aria-label="Loading projects">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="bg-white/5 border border-white/10 rounded-xl p-4 animate-pulse">
                <div className="h-4 w-2/3 rounded bg-white/10" />
                <div className="h-3 w-1/2 rounded bg-white/5 mt-2" />
              </div>
            ))}
          </div>
        )}

        {projects !== null && projects.length === 0 && (
          <div className="text-center py-16 border border-dashed border-white/10 rounded-xl">
            <p className="text-sm text-white/40">No projects yet. Create one to start capturing, uploading, and editing.</p>
          </div>
        )}

        {projects && projects.length > 0 && (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {projects.map((project) => {
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
                  )}
                </li>
              );
            })}
          </ul>
        )}
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
