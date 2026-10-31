import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, FolderOpen, Plus, Redo2, Settings, Undo2, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import BrandLogo from '../BrandLogo';
import { ProjectProvider, useProject } from '../../context/ProjectContext';
import { PreviewPane } from './PreviewPane';
import { TimelinePanel } from './TimelinePanel';
import { ItemInspector } from './ItemInspector';
import { MediaImportPanel } from './MediaImportPanel';
import { AddTextPanel } from './AddTextPanel';
import { WatermarkPanel } from './WatermarkPanel';
import { TranscribePanel } from './TranscribePanel';
import { AddCaptionPanel } from './AddCaptionPanel';
import { ExportPanel } from './ExportPanel';
import { BackgroundRemovalButton } from './BackgroundRemovalButton';
import { BottomSheet } from './BottomSheet';
import { PipPanel } from './PipPanel';
import { TemplatesPanel } from './TemplatesPanel';
import { TransitionsPanel } from './TransitionsPanel';
import { EffectsPanel } from './EffectsPanel';
import { MusicPanel } from './MusicPanel';
import { LicensingPanel } from './LicensingPanel';
import { CaptionsExportPanel } from './CaptionsExportPanel';
import { appendDualCaptureToTimeline, appendMediaToTimeline, placeImportPair } from '../../lib/timeline/insert';
import { addPipOverlay, isPipItem } from '../../lib/pip';
import { removeItem, getProjectDuration } from '../../lib/timeline/utils';
import { evaluateProjectExportGate } from '../../lib/projectDurationGate';
import { useLicenseTier } from '../../hooks/useLicenseTier';
import { OPEN_PLAN_EVENT, OPEN_PLAN_SESSION_KEY } from '../../lib/upgradeRequest';
import { saveStatusText } from '../../lib/projects/localDraft';
import { recordFailure } from '../../lib/failureCounts';
import type { AudioTimelineItem, MediaAsset } from '../../types/timeline';

/**
 * Phase 1 Step 6 (Shared editor shell) — the actual authenticated editor
 * screen. Layout: media import + library (left), preview + timeline
 * (center), inspector + overlay/AI panels (right). Everything reads/writes
 * through `useProject()`, i.e. the timeline foundation's `Project` model —
 * no parallel state.
 */

/**
 * v9 accordion group for the editor side panel: a slim 44px header row;
 * the body renders only while the group is open (one group at a time —
 * the shell owns which). Same node on desktop and in the mobile sheet.
 */
function PanelGroup({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/[0.03]">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="w-full min-h-11 px-3 flex items-center gap-1.5 text-left text-[11px] font-bold uppercase tracking-wide text-white/70 hover:text-white"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {title}
      </button>
      {open && <div className="px-3 pb-3 flex flex-col gap-3">{children}</div>}
    </section>
  );
}

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
    savePhase,
    restoreOffer,
    restoreDraft,
    dismissRestoreOffer,
  } = useProject();
  // R35: proactive tier-cap line for Free users (the export gate's
  // indicator) — visible on every step, before the Export step's own
  // copy, so an over-cap project is never a surprise at export time.
  const { tier } = useLicenseTier();
  const durationGate = project ? evaluateProjectExportGate(project, tier) : null;
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

  // R27 WS-M1 — open where the work is: a project that already has
  // content when it FIRST loads opens on Step 2 (Edit) instead of the
  // upload screen. One-shot guard keyed by project id: it fires only on
  // the first non-null project object for that project, and never if
  // the user has already changed steps themselves, so it can never
  // override later navigation or re-fire on later project updates.
  const stepInitForProjectRef = useRef<string | null>(null);
  const userChangedStepRef = useRef(false);
  const goToStep = useCallback((n: 1 | 2 | 3) => {
    userChangedStepRef.current = true;
    setStep(n);
  }, []);
  useEffect(() => {
    if (!project) return;
    if (stepInitForProjectRef.current === project.id) return;
    stepInitForProjectRef.current = project.id;
    if (!userChangedStepRef.current && project.items.length > 0) setStep(2);
  }, [project]);

  // R27 WS-M6 — autosave. (a) Save on step change when there are
  // unsaved edits. (b) Debounced save ~2s after edits go quiet. The
  // manual Save button stays. Refs keep the effects from re-firing on
  // every render. R40 P-13: retries after a failed save are owned by
  // ProjectContext's own backoff loop (these effects still only fire
  // on step changes and fresh edits), and every dirty state is also
  // kept as a device-local draft there.
  // isDirty starts false on load, so neither fires on first load.
  const saveRef = useRef(save);
  saveRef.current = save;
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;
  const isSavingRef = useRef(isSaving);
  isSavingRef.current = isSaving;
  const prevStepRef = useRef(step);
  useEffect(() => {
    if (prevStepRef.current === step) return;
    prevStepRef.current = step;
    if (isDirtyRef.current && !isSavingRef.current) void saveRef.current();
  }, [step]);
  useEffect(() => {
    if (!project || !isDirty) return;
    const timer = setTimeout(() => {
      if (isDirtyRef.current && !isSavingRef.current) void saveRef.current();
    }, 2000);
    return () => clearTimeout(timer);
  }, [project, isDirty]);

  // R27 WS-M6 — undo toast: other panels (ItemInspector, TimelinePanel)
  // dispatch 'rr:undo-toast' after a delete; show the message with a
  // one-tap Undo here, auto-dismissing after ~6s.
  const [undoToast, setUndoToast] = useState<string | null>(null);
  const undoToastTimerRef = useRef<number | null>(null);
  // R40 P-19 — upgrade walls anywhere in the editor dispatch
  // 'rr:open-plan'; the shell owns the step state, so it listens and
  // moves to Step 3, where the plan surface (LicensingPanel) mounts.
  // The dashboard's plan strip uses the session flag instead: it is
  // set before a project opens and read once here.
  useEffect(() => {
    const handler = () => goToStep(3);
    window.addEventListener(OPEN_PLAN_EVENT, handler);
    try {
      if (sessionStorage.getItem(OPEN_PLAN_SESSION_KEY) === '1') {
        sessionStorage.removeItem(OPEN_PLAN_SESSION_KEY);
        goToStep(3);
      }
    } catch {
      // Storage unavailable — in-editor walls still work via the event.
    }
    return () => window.removeEventListener(OPEN_PLAN_EVENT, handler);
  }, [goToStep]);

  useEffect(() => {
    const handler = (e: Event) => {
      const message = (e as CustomEvent<{ message?: string }>).detail?.message;
      setUndoToast(typeof message === 'string' && message ? message : 'Deleted');
      if (undoToastTimerRef.current !== null) window.clearTimeout(undoToastTimerRef.current);
      undoToastTimerRef.current = window.setTimeout(() => setUndoToast(null), 6000);
    };
    window.addEventListener('rr:undo-toast', handler);
    return () => {
      window.removeEventListener('rr:undo-toast', handler);
      if (undoToastTimerRef.current !== null) window.clearTimeout(undoToastTimerRef.current);
    };
  }, []);

  // "Final production fix" spec item 3a (mobile-first redesign) — on small
  // viewports the Library and Selected-Item/Add-panel columns (fixed side
  // `<aside>`s on desktop, see the `lg:` breakpoint on the grid below) move
  // into a `BottomSheet` instead, opened from two small header buttons.
  // `null` = no sheet open; otherwise which one.
  const [mobileSheet, setMobileSheet] = useState<'library' | 'panel' | null>(null);

  // v9 mobile-first: the side panel is an ACCORDION — one group open at
  // a time, so a phone shows six slim headers instead of nine stacked
  // panels. Selecting a timeline item auto-opens its group.
  const [openGroup, setOpenGroup] = useState<string>('add');
  useEffect(() => {
    if (!selectedItemId) return;
    // R36 WS-1 — a PiP or pair item's controls live in the Overlay
    // group (PipPanel), so selecting one opens that group instead of
    // the inspector group. This is also what leaves the PipPanel open
    // on a freshly recorded/uploaded PiP: the overlay insert path
    // selects the new item (see handleOverlayAssetUploaded).
    const selected = projectStateRef.current?.items.find((i) => i.id === selectedItemId);
    const isPairItem = !!selected && (selected.type === 'video' || selected.type === 'image') && !!selected.pair;
    setOpenGroup(selected && (isPipItem(selected) || isPairItem) ? 'overlay' : 'item');
    // R27 WS-M3 — on a small viewport, tapping a clip visibly does
    // something: its item sheet opens (desktop keeps the side column).
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1023px)').matches) {
      setMobileSheet('panel');
    }
  }, [selectedItemId]);

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
    (asset: MediaAsset, options?: { trimStart?: number; trimEnd?: number; role?: AudioTimelineItem['role'] }) => {
      // First-run flow: the moment the first clip lands in an empty
      // project, move the user to Step 2 (Edit) instead of leaving them
      // on the upload screen wondering what to do next.
      const wasEmpty = (projectStateRef.current?.items.length ?? 0) === 0;
      mutate((p) =>
        appendMediaToTimeline(p, asset, { trimStart: options?.trimStart, trimEnd: options?.trimEnd, role: options?.role }),
      );
      if (wasEmpty) setStep(2);
    },
    [mutate],
  );

  // R29 — a finished dual-camera pair (MediaImportPanel dual routing):
  // the rear recording lands as the main video and the front recording
  // as its PiP overlay in one mutate (one undo step), already lined up
  // by the measured recorder start delta.
  const handleDualAssetUploaded = useCallback(
    (main: MediaAsset, overlay: MediaAsset, options: { startDeltaMs: number; layout: 'pip' | 'split' }) => {
      const wasEmpty = (projectStateRef.current?.items.length ?? 0) === 0;
      mutate((p) =>
        appendDualCaptureToTimeline(p, main, overlay, { startDeltaMs: options.startDeltaMs, layout: options.layout }),
      );
      if (wasEmpty) setStep(2);
    },
    [mutate],
  );

  // R32 Phase 4 — a finished imported pair (MediaImportPanel pair
  // routing): two visual files placed together as Corner PiP or
  // Split 50/50 in one mutate (one undo step).
  const handlePairAssetUploaded = useCallback(
    (assetA: MediaAsset, assetB: MediaAsset, options: { layout: 'pip' | 'split' }) => {
      const wasEmpty = (projectStateRef.current?.items.length ?? 0) === 0;
      mutate((p) => placeImportPair(p, assetA, assetB, { layout: options.layout }));
      if (wasEmpty) setStep(2);
    },
    [mutate],
  );

  // Tweaks round — "Add Overlay" uploads (MediaImportPanel purpose
  // 'overlay'). Videos go through the SAME PiP insert path as PipPanel
  // (bottom-right layout preset, muted by default for uploaded files —
  // camera talking-head takes pass muted:false — draggable/resizable
  // on canvas afterwards); images land as corner-placed overlay items on
  // the image track, sized like an overlay rather than a full-frame
  // photo. Either way the overlay starts at the playhead.
  // R36 WS-1 — a landed overlay becomes the SELECTED item: the
  // insert helpers generate the new item's id inside the mutate, so
  // the handler only raises a flag; the effect below resolves the
  // flag against the post-mutate project (the first newly-appeared
  // PiP / overlay item) and selects it. The selection effect above
  // then opens the Overlay group, leaving the PipPanel open on it.
  const overlaySelectPendingRef = useRef(false);
  const prevItemIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!project) return;
    const prev = prevItemIdsRef.current;
    if (overlaySelectPendingRef.current) {
      overlaySelectPendingRef.current = false;
      const added = project.items.find(
        (i) =>
          !prev.has(i.id) &&
          (isPipItem(i) || (i.type === 'image' && i.role === 'overlay')),
      );
      if (added) setSelectedItemId(added.id);
    }
    prevItemIdsRef.current = new Set(project.items.map((i) => i.id));
  }, [project]);

  const handleOverlayAssetUploaded = useCallback(
    (asset: MediaAsset, options?: { trimStart?: number; trimEnd?: number; muted?: boolean }) => {
      if (asset.kind === 'video' || asset.kind === 'image') overlaySelectPendingRef.current = true;
      if (asset.kind === 'video') {
        mutate((p) =>
          addPipOverlay(p, asset, {
            layoutId: 'bottom-right',
            atTime: currentTime,
            trimStart: options?.trimStart,
            trimEnd: options?.trimEnd,
            // Camera talking-head takes arrive with muted:false (sound
            // on); uploaded files omit it and keep the muted default.
            muted: options?.muted,
          }),
        );
      } else if (asset.kind === 'image') {
        mutate((p) =>
          appendMediaToTimeline(p, asset, {
            atTime: currentTime,
            role: 'overlay',
            position: { x: 82, y: 78 },
            scale: 0.32,
          }),
        );
      }
      // Overlay work is editing work: land on Step 2 where the
      // timeline's Overlay lane and the PipPanel live.
      setStep(2);
    },
    [mutate, currentTime],
  );

  const handleAddExistingAssetToTimeline = useCallback(
    (asset: MediaAsset) => {
      const wasEmpty = (projectStateRef.current?.items.length ?? 0) === 0;
      const selectedVariantId = bgVariantByAssetId[asset.id];
      const assetToAdd = (selectedVariantId && project?.mediaAssets[selectedVariantId]) || asset;
      mutate((p) => appendMediaToTimeline(p, assetToAdd, { atTime: currentTime }));
      if (wasEmpty) setStep(2);
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
          // R27 WS-M6 — a keyboard delete is a real delete: surface the
          // undo toast exactly like the inspector's Delete button does.
          window.dispatchEvent(new CustomEvent('rr:undo-toast', { detail: { message: 'Clip deleted' } }));
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
      <div className="min-h-screen flex flex-col items-center justify-center gap-5 bg-[#070707]">
        <BrandLogo size="lg" />
        <div className="w-10 h-10 rounded-full border-4 border-gold/20 border-t-gold animate-spin" aria-label="Loading project" />
        <p className="text-white/40 text-xs uppercase tracking-wide">Loading project…</p>
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
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-white/50">Import media</h3>
        <MediaImportPanel
          uid={uid}
          canvasWidth={project.canvasWidth}
          canvasHeight={project.canvasHeight}
          onAssetUploaded={handleAssetUploaded}
          onOverlayAssetUploaded={handleOverlayAssetUploaded}
          onDualAssetUploaded={handleDualAssetUploaded}
          onPairAssetUploaded={handlePairAssetUploaded}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-white/50">Media library</h3>
        {Object.values(project.mediaAssets).length === 0 && <p className="text-xs text-white/60">Nothing uploaded yet — import a clip above and it lands here.</p>}
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
                <span className="text-white/60 uppercase text-[10px]">{asset.kind}</span>
                <button
                  onClick={() => handleAddExistingAssetToTimeline(asset)}
                  className="text-gold hover:text-gold-bright font-bold min-h-11 min-w-11 flex items-center justify-center"
                  title="Add to timeline at playhead"
                >
                  <Plus size={18} strokeWidth={3} />
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

  // v9: the side panel as an accordion — one group open at a time.
  // Every panel below is the SAME component instance as before (same
  // sidePanel node → desktop aside + mobile BottomSheet, never a second
  // copy); only the chrome changed. Groups: Add · Item · Style
  // (Transitions + Effects, the v9 "Style" merge) · Audio · Overlay ·
  // Captions (Transcribe + manual + export, the v9 Captions merge).
  const groupProps = (id: string) => ({
    open: openGroup === id,
    onToggle: () => setOpenGroup((g) => (g === id ? '' : id)),
  });
  const sidePanel = (
    <>
      <PanelGroup title="Add media" {...groupProps('add')}>
        <MediaImportPanel
          uid={uid}
          canvasWidth={project.canvasWidth}
          canvasHeight={project.canvasHeight}
          onAssetUploaded={handleAssetUploaded}
          onOverlayAssetUploaded={handleOverlayAssetUploaded}
          onDualAssetUploaded={handleDualAssetUploaded}
          onPairAssetUploaded={handlePairAssetUploaded}
        />
      </PanelGroup>

      <PanelGroup title="Templates" {...groupProps('templates')}>
        <TemplatesPanel currentTime={currentTime} uid={uid} />
      </PanelGroup>

      <PanelGroup title={selectedItem ? 'Selected item' : 'Text & watermark'} {...groupProps('item')}>
        {selectedItem ? (
          <ItemInspector item={selectedItem} />
        ) : (
          <>
            <AddTextPanel currentTime={currentTime} />
            <WatermarkPanel uid={uid} />
          </>
        )}
      </PanelGroup>

      <PanelGroup title="Style — transitions & effects" {...groupProps('style')}>
        <TransitionsPanel item={selectedItem} />
        <EffectsPanel item={selectedItem} />
      </PanelGroup>

      <PanelGroup title="Music & audio" {...groupProps('audio')}>
        <MusicPanel uid={uid} item={selectedItem} />
      </PanelGroup>

      <PanelGroup title="Overlay — picture in picture" {...groupProps('overlay')}>
        <PipPanel item={selectedItem} />
      </PanelGroup>

      <PanelGroup title="Captions" {...groupProps('captions')}>
        <p className="text-[10px] font-bold uppercase tracking-wide text-white/40 -mb-1">Write captions for me</p>
        <TranscribePanel uid={uid} />
        <p className="text-[10px] font-bold uppercase tracking-wide text-white/40 -mb-1">Add your own</p>
        <AddCaptionPanel currentTime={currentTime} />
        <p className="text-[10px] font-bold uppercase tracking-wide text-white/40 -mb-1">Caption files</p>
        <CaptionsExportPanel />
      </PanelGroup>
    </>
  );

  const exportPanel = (
    <>
      <section>
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-white/50 mb-1.5">Export</h3>
        <ExportPanel />
      </section>
      {/* R40 P-30 — caption files live in Step 3 too, next to Export
          video, where the Step-1 map promises them. The panel's state
          is a local message only, so mounting it here as well as in
          the Step-2 Captions group is safe. */}
      <section>
        <CaptionsExportPanel />
      </section>
      <section>
        <LicensingPanel />
      </section>
      <section className="bg-white/5 border border-white/10 rounded-xl p-4 text-xs text-white/60 space-y-1">
        <h3 className="font-bold text-white text-sm">Project summary</h3>
        <p>Duration: {getProjectDuration(project).toFixed(1)}s</p>
        <p>Items: {project.items.length} · Media: {Object.keys(project.mediaAssets).length}</p>
        <p>Watermark: {project.watermarkEnabled !== false ? 'On' : 'Off'}</p>
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
          <a href="/" className="text-white/40 hover:text-white text-xs shrink-0 min-h-11 flex items-center gap-1">
            <ArrowLeft size={16} /> <span className="hidden sm:inline">Projects</span>
          </a>
          <input
            value={project.name}
            onChange={(e) => mutate((p) => ({ ...p, name: e.target.value, updatedAt: Date.now() }))}
            className="bg-transparent font-bold text-base outline-none border-b border-transparent focus:border-white/30 min-w-0 flex-1"
          />
        </div>
        <div className="flex items-center gap-1.5 sm:gap-3 text-xs shrink-0">
          <div className="flex items-center gap-1">
            <button
              onClick={undo}
              disabled={!canUndo}
              title="Undo (Ctrl/Cmd+Z)"
              className="min-h-11 px-2.5 font-bold rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed text-white flex items-center gap-1.5"
            >
              <Undo2 size={16} /> <span>Undo</span>
            </button>
            <button
              onClick={redo}
              disabled={!canRedo}
              title="Redo (Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y)"
              className="min-h-11 px-2.5 font-bold rounded-lg bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed text-white flex items-center gap-1.5"
            >
              <Redo2 size={16} /> <span>Redo</span>
            </button>
          </div>
          <span className="text-white/60">
            {isSaving
              ? saveStatusText('saving', lastSavedAt, (t) => new Date(t).toLocaleTimeString())
              : savePhase === 'retrying' || savePhase === 'waiting-offline' || savePhase === 'failed'
                ? saveStatusText(savePhase, lastSavedAt, (t) => new Date(t).toLocaleTimeString())
                : isDirty
                  ? 'Unsaved changes'
                  : saveStatusText('saved', lastSavedAt, (t) => new Date(t).toLocaleTimeString())}
          </span>
          <button
            onClick={save}
            disabled={isSaving || !isDirty}
            className="min-h-11 px-3 sm:px-4 font-bold uppercase tracking-wide bg-gold hover:bg-gold-bright disabled:opacity-40 rounded-lg text-black"
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
          <button onClick={dismissProjectLimitWarning} aria-label="Dismiss" className="text-amber-200/60 hover:text-amber-100 shrink-0 min-h-8 min-w-8 flex items-center justify-center">
            <X size={14} strokeWidth={3} />
          </button>
        </div>
      )}

      {/* R40 P-13 — a newer copy kept on this device (a save that
          never landed, or a tab that died) is offered back in plain
          words; restoring is one undo-able load, never silent. */}
      {restoreOffer && (
        <div className="mx-3 sm:mx-4 mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white/5 border border-gold/40 px-3 py-2 text-xs text-white/85">
          <span>
            We saved a copy on this device at {new Date(restoreOffer.savedAt).toLocaleTimeString()} — restore it?
          </span>
          <span className="flex gap-2">
            <button
              onClick={restoreDraft}
              className="min-h-11 px-3 rounded-lg bg-gold hover:bg-gold-bright text-black font-bold uppercase tracking-wide"
            >
              Restore
            </button>
            <button
              onClick={dismissRestoreOffer}
              className="min-h-11 px-3 rounded-lg bg-white/10 hover:bg-white/20 font-bold"
            >
              Keep the saved version
            </button>
          </span>
        </div>
      )}

      {tier === 'free' && durationGate && (
        <p className={`px-3 sm:px-4 py-1.5 text-[11px] border-b border-white/10 shrink-0 ${durationGate.exceedsCap ? 'font-bold text-amber-300' : 'text-white/60'}`}>
          {durationGate.indicator}
        </p>
      )}

      {/* v1 3-step stepper — one clear action per screen */}
      <nav className="flex items-center gap-2 px-3 sm:px-4 py-2 border-b border-white/10 shrink-0" aria-label="Editor steps">
        {([
          { n: 1 as const, label: 'Capture / Upload' },
          { n: 2 as const, label: 'Edit + Captions' },
          { n: 3 as const, label: 'Export' },
        ]).map((s, idx) => (
          <React.Fragment key={s.n}>
            {idx > 0 && <ChevronRight size={14} className="text-white/20 shrink-0" />}
            <button
              onClick={() => goToStep(s.n)}
              aria-current={step === s.n ? 'step' : undefined}
              className={`min-h-11 px-3 rounded-lg text-xs font-bold ${step === s.n ? 'bg-gold text-black' : 'bg-white/10 hover:bg-white/20 text-white'}`}
            >
              {s.n}. {s.label}
            </button>
          </React.Fragment>
        ))}
        <span className="ml-auto hidden sm:inline text-[11px] text-white/60">
          {step === 1 ? 'Upload, record, or pick a template' : step === 2 ? 'Edit, transitions, effects, captions, PiP' : 'Choose format and quality, export, done'}
        </span>
      </nav>

      {step === 1 && (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 p-3 sm:p-4 overflow-auto min-w-0">
          <div className="flex flex-col gap-4">{libraryPanel}</div>
          <aside className="flex flex-col gap-4">
            <TemplatesPanel currentTime={currentTime} uid={uid} />
            <div className="hidden lg:block bg-white/5 border border-white/10 rounded-xl p-4 text-xs text-white/60 space-y-1">
              <p className="font-bold text-white text-sm">How it works</p>
              <p>1. Upload or record your clip.</p>
              <p>2. Edit + add captions.</p>
              <p>3. Export MP4 (or SRT/VTT).</p>
            </div>
            <button onClick={() => goToStep(2)} className="min-h-11 px-4 font-bold rounded-lg bg-gold hover:bg-gold-bright text-black text-sm flex items-center justify-center gap-1.5">Continue to Edit <ArrowRight size={16} /></button>
          </aside>
        </div>
      )}

      {step === 2 && (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 p-3 pb-24 sm:p-4 overflow-auto min-w-0">
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
              <button onClick={() => goToStep(1)} className="min-h-11 px-4 rounded-lg bg-white/10 hover:bg-white/20 text-sm font-bold flex items-center gap-1.5"><ArrowLeft size={16} /> Back</button>
              <button onClick={() => goToStep(3)} className="min-h-11 px-4 rounded-lg bg-gold hover:bg-gold-bright text-black text-sm font-bold flex items-center gap-1.5">Continue to Export <ArrowRight size={16} /></button>
            </div>
          </main>
          {/* Hidden below lg: on mobile this panel mounts once, inside the
              BottomSheet below — rendering it inline too double-mounted
              every panel (duplicate stateful widgets) on phones. */}
          <aside className="hidden lg:flex flex-col gap-4">{sidePanel}</aside>
        </div>
      )}

      {step === 3 && (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 p-3 pb-24 sm:p-4 overflow-auto min-w-0">
          <main className="flex flex-col gap-4 items-center min-w-0">
            {project.items.length === 0 ? (
              <div className="w-full max-w-3xl rounded-xl border border-white/10 bg-white/5 p-5 flex flex-col items-center gap-3 text-center">
                <p className="text-sm font-bold text-white">Add a video or photo first</p>
                <p className="text-xs text-white/50">There is nothing to export yet — add a clip in Step 1, then come back here.</p>
                <button onClick={() => goToStep(1)} className="min-h-11 px-4 rounded-lg bg-gold hover:bg-gold-bright text-black text-sm font-bold flex items-center gap-1.5"><ArrowLeft size={16} /> Go to Step 1</button>
              </div>
            ) : (
              <>
                <PreviewPane
                  project={project}
                  currentTime={currentTime}
                  isPlaying={isPlaying}
                  onTimeChange={setCurrentTime}
                  onPlayingChange={setIsPlaying}
                  selectedItemId={selectedItemId}
                  onSelectItem={setSelectedItemId}
                />
                <div className="flex gap-2">
                  <button onClick={() => goToStep(2)} className="min-h-11 px-4 rounded-lg bg-white/10 hover:bg-white/20 text-sm font-bold flex items-center gap-1.5"><ArrowLeft size={16} /> Back to Edit</button>
                </div>
                {/* R27 WS-M3 — export controls live in the mobile main
                    column too (the panel sheet stays as a shortcut);
                    desktop keeps them in the aside on the right. */}
                <div className="lg:hidden w-full max-w-3xl flex flex-col gap-4">{exportPanel}</div>
              </>
            )}
          </main>
          <aside className="hidden lg:flex flex-col gap-4">{exportPanel}</aside>
        </div>
      )}

      {/* v9 mobile bottom bar (steps 2–3): thumb-reach Library / Tools,
          plus a direct Export jump on step 2. Replaces the two header
          icon buttons; desktop keeps the side columns and shows no bar. */}
      {step !== 1 && (
        <nav style={{ paddingBottom: 'env(safe-area-inset-bottom)' }} className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-[#0b0b0b]/95 backdrop-blur border-t border-white/10 flex" aria-label="Editor tools">
          <button
            onClick={() => setMobileSheet('library')}
            className="flex-1 min-h-[56px] flex flex-col items-center justify-center gap-0.5 text-[10px] font-bold uppercase tracking-wide text-white/80"
          >
            <FolderOpen size={18} /> Library
          </button>
          <button
            onClick={() => setMobileSheet('panel')}
            className="flex-1 min-h-[56px] flex flex-col items-center justify-center gap-0.5 text-[10px] font-bold uppercase tracking-wide text-white/80"
          >
            <Settings size={18} /> {step === 3 ? 'Export' : selectedItem ? 'Selected item' : 'Tools'}
          </button>
          {step === 2 && (
            <button
              onClick={() => goToStep(3)}
              className="flex-1 min-h-[56px] flex flex-col items-center justify-center gap-0.5 text-[10px] font-black uppercase tracking-wide bg-gold text-black"
            >
              <ArrowRight size={18} /> Export
            </button>
          )}
        </nav>
      )}

      {undoToast && (
        <div className="fixed bottom-24 lg:bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl bg-[#1c1c1c] border border-white/15 px-4 py-2.5 shadow-2xl" role="status">
          <span className="text-sm text-white/85 whitespace-nowrap">{undoToast}</span>
          <button
            onClick={() => { undo(); setUndoToast(null); }}
            className="min-h-11 px-3 rounded-lg bg-gold hover:bg-gold-bright text-black text-xs font-black uppercase tracking-wide"
          >
            Undo
          </button>
          <button onClick={() => setUndoToast(null)} aria-label="Dismiss" className="min-h-11 min-w-11 flex items-center justify-center text-white/50 hover:text-white">
            <X size={14} strokeWidth={3} />
          </button>
        </div>
      )}

      <BottomSheet open={mobileSheet === 'library'} onClose={() => setMobileSheet(null)} title="Media Library">
        {libraryPanel}
      </BottomSheet>
      <BottomSheet open={mobileSheet === 'panel'} onClose={() => setMobileSheet(null)} title={selectedItem ? 'Selected Item' : 'Add / Export'}>
        {step === 3 ? exportPanel : sidePanel}
      </BottomSheet>
    </div>
  );
}

export function EditorShell({ projectId }: { projectId: string }) {
  const { currentUser, idToken } = useAuth();
  if (!currentUser) return null;
  return (
    <ProjectProvider
      projectId={projectId}
      ownerUid={currentUser.uid}
      onSaveFinalFailure={() => recordFailure('save', idToken)}
    >
      <EditorInner uid={currentUser.uid} />
    </ProjectProvider>
  );
}
