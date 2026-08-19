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
  const { project, isLoading, loadError, isSaving, saveError, isDirty, lastSavedAt, mutate, save, undo, redo, canUndo, canRedo } =
    useProject();
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
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
    (asset: MediaAsset) => {
      mutate((p) => appendMediaToTimeline(p, asset));
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
        <MediaImportPanel uid={uid} onAssetUploaded={handleAssetUploaded} />
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
        <TranscribePanel uid={uid} />
      </section>

      <section>
        <ExportPanel />
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

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[280px_1fr_320px] gap-4 p-3 sm:p-4 overflow-auto min-w-0">
        <aside className="hidden lg:flex flex-col gap-4">{libraryPanel}</aside>

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
        </main>

        <aside className="hidden lg:flex flex-col gap-4">{sidePanel}</aside>
      </div>

      <BottomSheet open={mobileSheet === 'library'} onClose={() => setMobileSheet(null)} title="Media Library">
        {libraryPanel}
      </BottomSheet>
      <BottomSheet open={mobileSheet === 'panel'} onClose={() => setMobileSheet(null)} title={selectedItem ? 'Selected Item' : 'Add / Export'}>
        {sidePanel}
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
