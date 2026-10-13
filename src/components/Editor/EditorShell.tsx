import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { ProjectProvider, useProject } from '../../context/ProjectContext';
import { PreviewPane } from './PreviewPane';
import { TimelinePanel } from './TimelinePanel';
import { ItemInspector } from './ItemInspector';
import { MediaImportPanel } from './MediaImportPanel';
import { AddTextPanel } from './AddTextPanel';
import { WatermarkPanel } from './WatermarkPanel';
import { TranscribePanel } from './TranscribePanel';
import { ExportPanel } from './ExportPanel';
import { BackgroundRemovalButton } from './BackgroundRemovalButton';
import { BottomSheet } from './BottomSheet';
import { PipPanel } from './PipPanel';
import { TemplatesPanel } from './TemplatesPanel';
import { LicensingPanel } from './LicensingPanel';
import { CaptionsExportPanel } from './CaptionsExportPanel';
import { appendMediaToTimeline } from '../../lib/timeline/insert';
import { removeItem, getProjectDuration } from '../../lib/timeline/utils';
import type { MediaAsset } from '../../types/timeline';

/**
 * Phase 1 Step 6 (Shared editor shell) — the actual authenticated editor
 * screen. Layout: media import + library (left), preview + timeline
 * (center), inspector + overlay/AI panels (right). Everything reads/writes
 * through `useProject()`, i.e. the timeline foundation's `Project` model —
 * no parallel state.
 */

function EditorInner({ uid }: { uid: string }) {
  const {
    project,
    isLoading,
    loadError,
    isSaving,
    saveError,
    isDirty,
    lastSavedAt,
    mutate,
    save,
    undo,
    redo,
    canUndo,
    canRedo,
    projectLimitWarning,
    dismissProjectLimitWarning,
  } = useProject();
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  // v1 3-step flow: 1 Capture/Upload → 2 Edit+Captions → 3 Export.
  // One clear action per screen; panels are grouped by step, no parallel state.
  const [step, setStep] = useState<1 | 2 | 3>(1);
  // Which variant (original vs background-removed) is currently selected
  // per ORIGINAL image asset id — owned here (not inside
  // BackgroundRemovalButton) because the media library row's own
  // "+ Add to timeline" button needs the same answer: adding should place
  // whichever variant the user has toggled to, not always the original.
  const [bgVariantByAssetId, setBgVariantByAssetId] = useState<Record<string, string>>({});
  const projectStateRef = useRef(project);
  projectStateRef.current = project;

  // "Final production fix" spec item 3a (mobile-first redesign) — on small
  // viewports the Library and Selected-Item/Add-panel columns (fixed side
  // `<aside>`s on desktop, see the `lg:` breakpoint on the grid below) move
  // into a `BottomSheet` instead, opened from two small header buttons.
  // `null` = no sheet open; otherwise which one.
  const [mobileSheet, setMobileSheet] = useState<'library' | 'panel' | null>(null);

  // Re-derive the toggle's highlighted variant from what's actually placed
  // on the timeline whenever the project (re)loads — `bgVariantByAssetId`
  // is deliberately local UI state (see its own comment above), so a fresh
  // page load/reload starts it empty and the Original/Background-Removed
  // pill would default to "Original" even when a placed watermark item is
  // correctly still pointing at the background-removed asset (retargeting
  // itself IS persisted correctly via each item's own `mediaAssetId` —
  // only this toggle's highlight was out of sync). Only fills in entries
  // that aren't already set, so it never clobbers a choice made later in
  // the same session (e.g. right after a fresh removal completes).
  useEffect(() => {
    if (!project) return;
    setBgVariantByAssetId((prev) => {
      let next: Record<string, string> | null = null;
      Object.values(project.mediaAssets).forEach((asset) => {
        if (!asset.backgroundRemovedAssetId) return;
        if (prev[asset.id] !== undefined) return;
        const usesRemoved = project.items.some(
          (item) => item.type === 'image' && item.mediaAssetId === asset.backgroundRemovedAssetId,
        );
        if (!next) next = { ...prev };
        next[asset.id] = usesRemoved ? asset.backgroundRemovedAssetId : asset.id;
      });
      return next ?? prev;
    });
  }, [project]);

  const handleAssetUploaded = useCallback(
    (asset: MediaAsset, options?: { trimStart?: number; trimEnd?: number }) => {
      mutate((p) => appendMediaToTimeline(p, asset, { trimStart: options?.trimStart, trimEnd: options?.trimEnd }));
    },
    [mutate],
  );

  const handleAddExistingAssetToTimeline = useCallback(
    (asset: MediaAsset) => {
      const selectedVariantId = bgVariantByAssetId[asset.id];
      const assetToAdd = (selectedVariantId && project?.mediaAssets[selectedVariantId]) || asset;
      mutate((p) => appendMediaToTimeline(p, assetToAdd, { atTime: currentTime }));
    },
    [mutate, currentTime, bgVariantByAssetId, project],
  );

  // Minimal, real keyboard shortcut set (Phase-10 audit item, extended in
  // the "final completion" pass with undo/redo): Space play/pause,
  // Delete/Backspace deletes the selected item, arrow keys nudge the
  // playhead by one frame (Shift+arrow for a 1s jump), Ctrl/Cmd+Z undoes,
  // Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y redoes. Ignored while focus is in a
  // text field/textarea/select so typing a caption word or a text item's
  // content never gets hijacked by a shortcut — e.g. pressing Delete while
  // editing caption text deletes text (the browser's native input
  // behavior), not the whole caption item; Ctrl+Z while typing invokes the
  // browser's own per-field text undo rather than our project-level undo,
  // which is the behavior a user actually wants while composing text.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target?.isContentEditable;
      if (isEditable) return;

      const mod = e.ctrlKey || e.metaKey;

      if (e.code === 'Space') {
        e.preventDefault();
        setIsPlaying((p) => !p);
      } else if (mod && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.code === 'KeyY') {
        e.preventDefault();
        redo();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedItemId) {
          e.preventDefault();
          mutate((p) => removeItem(p, selectedItemId));
          setSelectedItemId(null);
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 1 / 30;
        const delta = e.key === 'ArrowLeft' ? -step : step;
        setCurrentTime((t) => {
          const proj = projectStateRef.current;
          const max = proj ? Math.max(getProjectDuration(proj), 0) : Infinity;
          return Math.max(0, Math.min(max, t + delta));
        });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedItemId, mutate, undo, redo]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#070707] text-white/50 text-sm">
        Loading project…
      </div>
    );
  }

  if (loadError || !project) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-[#070707] text-white text-center px-6">
        <p className="text-sm text-red-400">{loadError || 'Project could not be loaded.'}</p>
        <a href="/" className="text-xs text-white/50 underline">
          Back to your projects
        </a>
      </div>
    );
  }

  const selectedItem = project.items.find((item) => item.id === selectedItemId) || null;

  // Shared between the desktop `<aside>` columns (always rendered inline,
  // `lg:` and up) and the mobile `BottomSheet`s (rendered only when open,
  // below `lg`) — the exact same JSX nodes either way, never a second
  // mobile-only copy of this markup to keep in sync.
  const libraryPanel = (
    <>
      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-white/50">Import media</h3>
        <MediaImportPanel
          uid={uid}
          canvasWidth={project.canvasWidth}
          canvasHeight={project.canvasHeight}
          onAssetUploaded={handleAssetUploaded}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-white/50">Media library</h3>
        {Object.values(project.mediaAssets).length === 0 && <p className="text-xs text-white/30">Nothing uploaded yet.</p>}
        <ul className="flex flex-col gap-1">
          {Object.values(project.mediaAssets)
            // A background-removed asset is a derivative of its original,
            // reachable via the original's own toggle
            // (BackgroundRemovalButton) rather than as an independent
            // library row — keeps the list from growing a confusing second
            // "-no-bg.png" entry every time someone toggles.
            .filter((asset) => !asset.originalAssetId)
            .map((asset) => (
              <li key={asset.id} className="flex items-center gap-2 bg-white/5 rounded px-2 py-1.5 text-xs">
                <span className="flex-1 truncate">{asset.fileName}</span>
                <span className="text-white/30 uppercase text-[10px]">{asset.kind}</span>
                <button
                  onClick={() => handleAddExistingAssetToTimeline(asset)}
                  className="text-emerald-400 hover:text-emerald-300 font-bold min-h-11 min-w-11 flex items-center justify-center text-base"
                  title="Add to timeline at playhead"
                >
                  +
                </button>
                {asset.kind === 'image' && (
                  <BackgroundRemovalButton
                    uid={uid}
                    asset={asset}
                    isRemovedSelected={!!bgVariantByAssetId[asset.id] && bgVariantByAssetId[asset.id] === asset.backgroundRemovedAssetId}
                    onSelectVariant={(assetId) => setBgVariantByAssetId((m) => ({ ...m, [asset.id]: assetId }))}
                  />
                )}
              </li>
            ))}
        </ul>
      </section>
    </>
  );

  const sidePanel = (
    <>
      {selectedItem ? (
        <section>
          <h3 className="text-xs font-bold uppercase tracking-wide text-white/50 mb-2">Selected item</h3>
          <ItemInspector item={selectedItem} />
        </section>
      ) : (
        <>
          <section>
            <AddTextPanel currentTime={currentTime} />
          </section>
          <section>
            <WatermarkPanel uid={uid} />
          </section>
        </>
      )}

      <section>
        <PipPanel />
      </section>

      <section>
        <TranscribePanel uid={uid} />
      </section>

      <section>
        <CaptionsExportPanel />
      </section>
    </>
  );

  const exportPanel = (
    <>
      <section>
        <h3 className="text-xs font-bold uppercase tracking-wide text-white/50 mb-2">Export</h3>
        <ExportPanel />
      </section>
      <section>
        <LicensingPanel />
      </section>
      <section className="bg-white/5 border border-white/10 rounded-xl p-4 text-xs text-white/60 space-y-1">
        <h3 className="font-bold text-white text-sm">Project summary</h3>
        <p>Duration: {getProjectDuration(project).toFixed(1)}s</p>
        <p>Items: {project.items.length} · Media: {Object.keys(project.mediaAssets).length}</p>
        <p>Watermark: {project.watermarkEnabled !== false ? 'On (free)' : 'Off (lifetime)'}</p>
      </section>
    </>
  );

  return (
    <div className="min-h-screen bg-[#070707] text-white flex flex-col">
      {/* Slim top bar (spec item 3a) — Back/name/Undo/Redo/Save stay, at
          touch-friendly sizes, on every viewport; on mobile two extra
          buttons open the Library / Selected-Item panels as bottom sheets
          instead of those panels being fixed side columns. */}
      <header className="flex items-center justify-between gap-2 px-3 sm:px-4 py-2 sm:py-3 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <a href="/" className="text-white/40 hover:text-white text-xs shrink-0 min-h-11 flex items-center">
            ← <span className="hidden sm:inline">Projects</span>
          </a>
          <input
            value={project.name}
            onChange={(e) => mutate((p) => ({ ...p, name: e.target.value, updatedAt: Date.now() }))}
            className="bg-transparent font-bold text-sm outline-none border-b border-transparent focus:border-white/30 min-w-0 flex-1"
          />
        </div>
        <div className="flex items-center gap-1.5 sm:gap-3 text-xs shrink-0">
          <button
            onClick={() => setMobileSheet('library')}
            title="Media library"
            className="lg:hidden min-h-11 min-w-11 flex items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 text-white text-base"
          >
            🗂
          </button>
          <button
            onClick={() => setMobileSheet('panel')}
            title={selectedItem ? 'Selected item' : 'Add / Export'}
            className="lg:hidden min-h-11 min-w-11 flex items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 text-white text-base"
          >
            ⚙
          </button>
          <div className="hidden sm:flex items-center gap-1">
            <button
              onClick={undo}
              disabled={!canUndo}
              title="Undo (Ctrl/Cmd+Z)"
              className="min-h-11 px-2.5 font-bold rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed text-white"
            >
              ↺ <span className="hidden md:inline">Undo</span>
            </button>
            <button
              onClick={redo}
              disabled={!canRedo}
              title="Redo (Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y)"
              className="min-h-11 px-2.5 font-bold rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed text-white"
            >
              ↻ <span className="hidden md:inline">Redo</span>
            </button>
          </div>
          {saveError && <span className="hidden sm:inline text-red-400">{saveError}</span>}
          <span className="hidden md:inline text-white/30">
            {isSaving ? 'Saving…' : isDirty ? 'Unsaved changes' : lastSavedAt ? `Saved ${new Date(lastSavedAt).toLocaleTimeString()}` : ''}
          </span>
          <button
            onClick={save}
            disabled={isSaving || !isDirty}
            className="min-h-11 px-3 sm:px-4 font-bold uppercase tracking-wide bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-lg text-white"
          >
            Save
          </button>
        </div>
      </header>

      {/* "Universal 30-second media standard" spec item 4 — the project-
          level guard's user-visible surface. `ProjectContext.mutate` blocks
          an edit that would grow the project past the limit and sets this
          message rather than letting it happen silently; shown here as a
          dismissible banner so the user sees WHY immediately, not just at
          export time. */}
      {projectLimitWarning && (
        <div className="mx-3 sm:mx-4 mt-2 flex items-center justify-between gap-3 rounded-lg bg-amber-500/15 border border-amber-500/30 px-3 py-2 text-xs text-amber-200">
          <span>{projectLimitWarning}</span>
          <button onClick={dismissProjectLimitWarning} className="text-amber-200/60 hover:text-amber-100 shrink-0 min-h-8 min-w-8 flex items-center justify-center">
            ×
          </button>
        </div>
      )}

      {/* v1 3-step stepper — one clear action per screen */}
      <nav className="flex items-center gap-2 px-3 sm:px-4 py-2 border-b border-white/10 shrink-0" aria-label="Editor steps">
        {([
          { n: 1 as const, label: 'Capture / Upload' },
          { n: 2 as const, label: 'Edit + Captions' },
          { n: 3 as const, label: 'Export' },
        ]).map((s, idx) => (
          <React.Fragment key={s.n}>
            {idx > 0 && <span className="text-white/20">→</span>}
            <button
              onClick={() => setStep(s.n)}
              aria-current={step === s.n ? 'step' : undefined}
              className={`min-h-11 px-3 rounded-lg text-xs font-bold ${step === s.n ? 'bg-white text-black' : 'bg-white/10 hover:bg-white/20 text-white'}`}
            >
              {s.n}. {s.label}
            </button>
          </React.Fragment>
        ))}
        <span className="ml-auto hidden sm:inline text-[11px] text-white/30">
          {step === 1 ? 'Upload, record, or pick a template' : step === 2 ? 'Edit, add captions, PiP, text' : 'Choose format, export, done'}
        </span>
      </nav>

      {step === 1 && (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 p-3 sm:p-4 overflow-auto min-w-0">
          <div className="flex flex-col gap-4">{libraryPanel}</div>
          <aside className="flex flex-col gap-4">
            <TemplatesPanel />
            <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-xs text-white/60 space-y-1">
              <p className="font-bold text-white text-sm">How it works</p>
              <p>1. Upload or record your clip.</p>
              <p>2. Edit + add captions.</p>
              <p>3. Export MP4 (or SRT/VTT).</p>
            </div>
            <button onClick={() => setStep(2)} className="min-h-11 px-4 font-bold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm">Continue to Edit →</button>
          </aside>
        </div>
      )}

      {step === 2 && (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 p-3 sm:p-4 overflow-auto min-w-0">
          <main className="flex flex-col gap-4 items-center min-w-0">
            <PreviewPane
              project={project}
              currentTime={currentTime}
              isPlaying={isPlaying}
              onTimeChange={setCurrentTime}
              onPlayingChange={setIsPlaying}
              selectedItemId={selectedItemId}
              onSelectItem={setSelectedItemId}
            />
            <div className="w-full max-w-3xl">
              <TimelinePanel
                project={project}
                currentTime={currentTime}
                onSeek={setCurrentTime}
                selectedItemId={selectedItemId}
                onSelectItem={setSelectedItemId}
              />
            </div>
            <div className="w-full max-w-3xl flex gap-2">
              <button onClick={() => setStep(1)} className="min-h-11 px-4 rounded-lg bg-white/10 hover:bg-white/20 text-sm font-bold">← Back</button>
              <button onClick={() => setStep(3)} className="min-h-11 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-bold">Continue to Export →</button>
            </div>
          </main>
          <aside className="flex flex-col gap-4">{sidePanel}</aside>
        </div>
      )}

      {step === 3 && (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 p-3 sm:p-4 overflow-auto min-w-0">
          <main className="flex flex-col gap-4 items-center min-w-0">
            <PreviewPane
              project={project}
              currentTime={currentTime}
              isPlaying={isPlaying}
              onTimeChange={setCurrentTime}
              onPlayingChange={setIsPlaying}
              selectedItemId={selectedItemId}
              onSelectItem={setSelectedItemId}
            />
            <button onClick={() => setStep(2)} className="min-h-11 px-4 rounded-lg bg-white/10 hover:bg-white/20 text-sm font-bold">← Back to Edit</button>
          </main>
          <aside className="flex flex-col gap-4">{exportPanel}</aside>
        </div>
      )}

      <BottomSheet open={mobileSheet === 'library'} onClose={() => setMobileSheet(null)} title="Media Library">
        {step === 1 ? libraryPanel : sidePanel}
      </BottomSheet>
      <BottomSheet open={mobileSheet === 'panel'} onClose={() => setMobileSheet(null)} title={selectedItem ? 'Selected Item' : 'Add / Export'}>
        {step === 3 ? exportPanel : sidePanel}
      </BottomSheet>
    </div>
  );
}

export function EditorShell({ projectId }: { projectId: string }) {
  const { currentUser } = useAuth();
  if (!currentUser) return null;
  return (
    <ProjectProvider projectId={projectId} ownerUid={currentUser.uid}>
      <EditorInner uid={currentUser.uid} />
    </ProjectProvider>
  );
}
