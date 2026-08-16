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
  const projectStateRef = useRef(project);
  projectStateRef.current = project;

  const handleAssetUploaded = useCallback(
    (asset: MediaAsset) => {
      mutate((p) => appendMediaToTimeline(p, asset));
    },
    [mutate],
  );

  const handleAddExistingAssetToTimeline = useCallback(
    (asset: MediaAsset) => {
      mutate((p) => appendMediaToTimeline(p, asset, { atTime: currentTime }));
    },
    [mutate, currentTime],
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

  return (
    <div className="min-h-screen bg-[#070707] text-white flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-3">
          <a href="/" className="text-white/40 hover:text-white text-xs">
            ← Projects
          </a>
          <input
            value={project.name}
            onChange={(e) => mutate((p) => ({ ...p, name: e.target.value, updatedAt: Date.now() }))}
            className="bg-transparent font-bold text-sm outline-none border-b border-transparent focus:border-white/30"
          />
        </div>
        <div className="flex items-center gap-3 text-xs">
          <div className="flex items-center gap-1">
            <button
              onClick={undo}
              disabled={!canUndo}
              title="Undo (Ctrl/Cmd+Z)"
              className="px-2.5 py-1.5 font-bold rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed text-white"
            >
              ↺ Undo
            </button>
            <button
              onClick={redo}
              disabled={!canRedo}
              title="Redo (Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y)"
              className="px-2.5 py-1.5 font-bold rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed text-white"
            >
              ↻ Redo
            </button>
          </div>
          {saveError && <span className="text-red-400">{saveError}</span>}
          <span className="text-white/30">
            {isSaving ? 'Saving…' : isDirty ? 'Unsaved changes' : lastSavedAt ? `Saved ${new Date(lastSavedAt).toLocaleTimeString()}` : ''}
          </span>
          <button
            onClick={save}
            disabled={isSaving || !isDirty}
            className="px-4 py-1.5 font-bold uppercase tracking-wide bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded-lg text-white"
          >
            Save
          </button>
        </div>
      </header>

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[280px_1fr_320px] gap-4 p-4 overflow-auto">
        <aside className="flex flex-col gap-4">
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wide text-white/50">Import media</h3>
            <MediaImportPanel uid={uid} onAssetUploaded={handleAssetUploaded} />
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wide text-white/50">Media library</h3>
            {Object.values(project.mediaAssets).length === 0 && (
              <p className="text-xs text-white/30">Nothing uploaded yet.</p>
            )}
            <ul className="flex flex-col gap-1">
              {Object.values(project.mediaAssets).map((asset) => (
                <li key={asset.id} className="flex items-center gap-2 bg-white/5 rounded px-2 py-1.5 text-xs">
                  <span className="flex-1 truncate">{asset.fileName}</span>
                  <span className="text-white/30 uppercase text-[10px]">{asset.kind}</span>
                  <button
                    onClick={() => handleAddExistingAssetToTimeline(asset)}
                    className="text-emerald-400 hover:text-emerald-300 font-bold"
                    title="Add to timeline at playhead"
                  >
                    +
                  </button>
                  {asset.kind === 'image' && <BackgroundRemovalButton uid={uid} asset={asset} />}
                </li>
              ))}
            </ul>
          </section>
        </aside>

        <main className="flex flex-col gap-4 items-center">
          <PreviewPane
            project={project}
            currentTime={currentTime}
            isPlaying={isPlaying}
            onTimeChange={setCurrentTime}
            onPlayingChange={setIsPlaying}
          />
          <div className="w-full max-w-2xl">
            <TimelinePanel
              project={project}
              currentTime={currentTime}
              onSeek={setCurrentTime}
              selectedItemId={selectedItemId}
              onSelectItem={setSelectedItemId}
            />
          </div>
        </main>

        <aside className="flex flex-col gap-4">
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
        </aside>
      </div>
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
