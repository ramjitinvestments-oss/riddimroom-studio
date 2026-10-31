import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Clapperboard, Crop, Frame, Sparkles } from 'lucide-react';
import { useProject } from '../../context/ProjectContext';
import {
  STUDIO_TEMPLATES,
  getTemplate,
  type StudioTemplate,
} from '../../lib/templates';
import type { Project, VideoTimelineItem } from '../../types/timeline';
import { applyFullTemplate, applyHookToProject, type ShortenedClipInfo } from '../../lib/templates/apply';
import {
  buildPreview,
  createPreviewCache,
  createPreviewScheduler,
  hasPreviewMedia,
  previewSignature,
  type PreviewCache,
  type PreviewScheduler,
} from '../../lib/templates/reelPreview';
import { renderPreviewCanvases } from './reelPreviewRenderer';
import {
  REEL_CHIPS,
  REEL_LAYOUT,
  reelCardModel,
  reelFilter,
  type ReelCardModel,
  type ReelChip,
} from '../../lib/templates/reelMeta';
import { findAspectRatioOption } from '../../lib/aspectRatios';
import { updateItem } from '../../lib/timeline/utils';
import { SlotTrimPicker } from './SlotTrimPicker';
import { ReframePicker } from './ReframePicker';

/**
 * Templates — R37 Phase 1: the chooser is ONE horizontal reel strip of
 * vertical cards (88×156, snap-scrolling) behind a single chip row
 * (All · Hooks · Full edits · the 8 categories), replacing the two
 * collapsible row sections + category dropdown (≈1,750px → 236px of
 * chooser; see `lib/templates/reelMeta.ts` for the height budget).
 * Cards carry Stage-A designed posters derived from the template's own
 * data (accent gradient treated with its grade filter, its headline in
 * its caption style, its slot plan as bars). Tapping an unfocused card
 * focuses it; tapping the focused card applies it — no accidental
 * applies while swiping.
 *
 * Apply behaviour is unchanged from the row era: Hooks (1.5–4s) insert
 * their text/effects into the open project at the playhead. Full Edits
 * (15–45s) make their slot plan REAL: each main-track clip/image is
 * reduced to its slot's size and re-packed into the reel, with the
 * template's transition, per-slot motion, and cinematic grade (see
 * `lib/templates/apply.ts`). R20: templates add no music — the app
 * adds no audio of its own; the user adds their own track from the
 * Music panel when they want one. After an apply that shortened any
 * video, an "Adjust clips" step offers the crop picker for each
 * shortened clip.
 */
export function TemplatesPanel({ currentTime = 0, uid }: { currentTime?: number; uid: string }) {
  const { project, mutate } = useProject();
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [chip, setChip] = useState<ReelChip>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingAdjust, setPendingAdjust] = useState<ShortenedClipInfo[] | null>(null);
  const [adjustTargetId, setAdjustTargetId] = useState<string | null>(null);
  const [framePrompt, setFramePrompt] = useState<StudioTemplate | null>(null);
  const [pendingFramed, setPendingFramed] = useState<ShortenedClipInfo[] | null>(null);
  const [reframeTargetId, setReframeTargetId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());

  const visible = useMemo(() => reelFilter(STUDIO_TEMPLATES, chip), [chip]);
  const cardModels = useMemo(
    () => new Map(visible.map((t) => [t.id, reelCardModel(t)] as const)),
    [visible],
  );
  // The focused card: the tracked id while it is in the current filter,
  // else the filter's first card.
  const focusedModel: ReelCardModel | null =
    (focusedId ? cardModels.get(focusedId) : undefined) ?? visible.map((t) => cardModels.get(t.id))[0] ?? null;

  // ── R37 Phase 2 Stage B: own-media preview frames for the focused
  // card. The cache + scheduler live in refs (created once); the
  // render function resolves its (project, template, playhead)
  // snapshot from the jobs map by cache key, so a render scheduled
  // for one card can never paint another card's frames.
  const [preview, setPreview] = useState<{ key: string; canvases: HTMLCanvasElement[] } | null>(null);
  const previewJobsRef = useRef(new Map<string, { project: Project; template: StudioTemplate; currentTime: number }>());
  const previewGenerationRef = useRef(0);
  const previewCacheRef = useRef<PreviewCache<HTMLCanvasElement[]> | null>(null);
  if (!previewCacheRef.current) previewCacheRef.current = createPreviewCache<HTMLCanvasElement[]>(12);
  const previewSchedulerRef = useRef<PreviewScheduler<HTMLCanvasElement[]> | null>(null);
  if (!previewSchedulerRef.current) {
    previewSchedulerRef.current = createPreviewScheduler<HTMLCanvasElement[]>(async (key) => {
      const job = previewJobsRef.current.get(key);
      if (!job) return null;
      const built = buildPreview(job.project, job.template, job.currentTime);
      return renderPreviewCanvases(built.project, built.timestamps);
    }, previewCacheRef.current);
  }
  const previewTemplate: StudioTemplate | undefined = focusedModel ? getTemplate(focusedModel.id) : undefined;

  useEffect(() => {
    const generation = ++previewGenerationRef.current;
    const scheduler = previewSchedulerRef.current;
    if (!project || !previewTemplate || !scheduler || !hasPreviewMedia(project)) {
      setPreview(null);
      return () => {
        previewGenerationRef.current += 1;
      };
    }
    const template = previewTemplate;
    const key = previewSignature(project, template, currentTime);
    const cached = scheduler.peek(key);
    if (cached) {
      setPreview({ key, canvases: cached });
      return () => {
        previewGenerationRef.current += 1;
      };
    }
    previewJobsRef.current.set(key, { project, template, currentTime });
    let debounceId: number | undefined;
    let idleId: number | undefined;
    let idleIsTimeout = false;
    debounceId = window.setTimeout(() => {
      const schedule = () => {
        void scheduler.request(key).then((frames) => {
          if (frames && previewGenerationRef.current === generation) {
            setPreview({ key, canvases: frames });
          }
        });
      };
      const idleWindow = window as Window & {
        requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
      };
      if (typeof idleWindow.requestIdleCallback === 'function') {
        idleId = idleWindow.requestIdleCallback(schedule, { timeout: 600 });
      } else {
        idleIsTimeout = true;
        idleId = window.setTimeout(schedule);
      }
    }, 350);
    return () => {
      previewGenerationRef.current += 1;
      if (debounceId !== undefined) window.clearTimeout(debounceId);
      if (idleId !== undefined) {
        if (idleIsTimeout) {
          window.clearTimeout(idleId);
        } else {
          const idleWindow = window as Window & { cancelIdleCallback?: (id: number) => void };
          if (typeof idleWindow.cancelIdleCallback === 'function') idleWindow.cancelIdleCallback(idleId);
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedId, project, currentTime]);

  // Scroll-driven focus: the card the user swipes to (≥90% visible in
  // the strip) becomes the focused card. Guarded for environments
  // without IntersectionObserver — tap focus still works there.
  useEffect(() => {
    if (typeof IntersectionObserver !== 'function') return;
    const root = stripRef.current;
    if (!root) return;
    const ratios = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.reelCard;
          if (id) ratios.set(id, entry.isIntersecting ? entry.intersectionRatio : 0);
        }
        let bestId: string | null = null;
        let best = 0;
        ratios.forEach((ratio, id) => {
          if (ratio >= 0.9 && ratio > best) {
            best = ratio;
            bestId = id;
          }
        });
        if (bestId) setFocusedId(bestId);
      },
      { root, threshold: [0.9] },
    );
    cardRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [visible, project]);

  if (!project) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-white/50">Templates</h3>
        <p className="text-[11px] text-white/40">Open a project first — hooks drop into the open project at the playhead, and full edits restyle it.</p>
      </div>
    );
  }

  const handleApply = async (t: StudioTemplate) => {
    if (busyId) return;
    // v9: a full-edit preset whose FRAME differs from the project canvas
    // asks first — switch the project to the preset's frame, or apply
    // inside the current size (crops still land, computed for the frame).
    if (t.kind === 'full' && t.frame) {
      const currentAspect = findAspectRatioOption(project.canvasWidth, project.canvasHeight)?.id;
      if (currentAspect && currentAspect !== t.frame.aspect) {
        setFramePrompt(t);
        return;
      }
    }
    await doApply(t, false);
  };

  const doApply = async (t: StudioTemplate, switchToFrame: boolean) => {
    if (busyId) return;
    setFramePrompt(null);
    setError(null);
    setNotice(null);
    try {
      if (t.kind === 'hook') {
        mutate((p) => applyHookToProject(p, t, currentTime));
        setAppliedId(t.id);
        setPendingAdjust(null);
        return;
      }
      // R20: templates no longer auto-add music — the app adds no
      // audio of its own; the user adds their own track when they want one.

      // Apply against the LIVE project state inside the updater (the
      // single mutate = the single undo step); the pure result is
      // captured alongside for the adjust-clips step and the notice —
      // the same record-a-value pattern ProjectContext itself uses.
      let result = applyFullTemplate(project, t, { switchToFrame });
      mutate((current) => {
        result = applyFullTemplate(current, t, { switchToFrame });
        return result.project;
      });
      setAppliedId(t.id);
      setPendingAdjust(result.shortenedClips.length > 0 ? result.shortenedClips : null);
      setPendingFramed(result.framedItems.length > 0 ? result.framedItems : null);
      if (result.canvasSwitched) {
        setNotice(`Project switched to ${t.frame?.aspect} — the frame this preset is designed for. Every clip was cropped to it.`);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not apply template.');
    }
  };

  const reframeTarget = reframeTargetId
    ? project.items.find((i) => i.id === reframeTargetId && (i.type === 'video' || i.type === 'image'))
    : undefined;
  const reframeAsset = reframeTarget && 'mediaAssetId' in reframeTarget ? project.mediaAssets[reframeTarget.mediaAssetId] : undefined;

  const adjustTarget = adjustTargetId
    ? project.items.find((i): i is VideoTimelineItem => i.id === adjustTargetId && i.type === 'video')
    : undefined;
  const adjustAsset = adjustTarget ? project.mediaAssets[adjustTarget.mediaAssetId] : undefined;

  const selectChip = (next: ReelChip) => {
    setChip(next);
    const first = reelFilter(STUDIO_TEMPLATES, next)[0];
    setFocusedId(first ? first.id : null);
  };

  // One tap, two meanings: an unfocused card only takes focus (and
  // scrolls into view); the focused card applies.
  const handleCardTap = (t: StudioTemplate) => {
    if (!focusedModel || focusedModel.id !== t.id) {
      setFocusedId(t.id);
      const el = cardRefs.current.get(t.id);
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
      }
      return;
    }
    void handleApply(t);
  };

  const focusedTemplate = focusedModel ? getTemplate(focusedModel.id) : undefined;

  return (
    <div className="flex flex-col" style={{ gap: REEL_LAYOUT.gap }}>
      <h3 className="text-[11px] font-bold uppercase tracking-wide text-white/50">Templates</h3>

      {/* R37: one chip row absorbs both old filters (the kind sections
          and the category dropdown). */}
      <div className="flex items-center gap-1.5 overflow-x-auto" style={{ height: REEL_LAYOUT.chipsHeight }}>
        {REEL_CHIPS.map((c) => {
          const selected = chip === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => selectChip(c.id)}
              aria-pressed={selected}
              className={`shrink-0 whitespace-nowrap rounded-full px-2.5 min-h-11 inline-flex items-center text-[11px] font-bold ${
                selected ? 'bg-gold text-black' : 'bg-white/5 border border-white/10 text-white/70'
              }`}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      {/* The reel strip: snap-scrolling vertical cards. touch-action
          pan-x lets horizontal swipes scroll the strip while vertical
          drags still scroll the panel around it. */}
      <div
        ref={stripRef}
        data-reel-strip
        className="overflow-x-auto [scroll-snap-type:x_mandatory]"
        style={{
          touchAction: 'pan-x',
          paddingTop: REEL_LAYOUT.stripPaddingY,
          paddingBottom: REEL_LAYOUT.stripPaddingY,
        }}
      >
        {visible.length === 0 ? (
          <p className="text-[11px] text-white/30">No templates in this filter.</p>
        ) : (
          <div className="flex" style={{ gap: REEL_LAYOUT.gap }}>
            {visible.map((t) => {
              const model = cardModels.get(t.id);
              if (!model) return null;
              const isFocusedCard = focusedModel?.id === t.id;
              return (
                <ReelTemplateCard
                  key={t.id}
                  model={model}
                  focused={isFocusedCard}
                  applied={appliedId === t.id}
                  previewCanvases={
                    isFocusedCard && preview && preview.key === previewSignature(project, t, currentTime)
                      ? preview.canvases
                      : undefined
                  }
                  onTap={() => handleCardTap(t)}
                  registerRef={(el) => {
                    if (el) cardRefs.current.set(t.id, el);
                    else cardRefs.current.delete(t.id);
                  }}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* R40 P-40: the two-tap rule, stated once under the strip. */}
      <p className="text-[11px] leading-4 text-white/60">Tap a card to preview it with your clips — tap again to use it.</p>

      {/* Focused-card detail: the facts the old rows carried (name,
          description, slot plan), at the tap point under the strip. */}
      {focusedTemplate && focusedModel && (
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-bold" style={{ color: focusedModel.accentColor }}>
            {focusedTemplate.name}
          </span>
          <p className="text-[11px] text-white/50 leading-snug">{focusedTemplate.description}</p>
          {focusedTemplate.kind === 'full' && focusedTemplate.slots && (
            <p className="text-[10px] text-white/35 leading-snug">{focusedTemplate.slots.map((s) => s.name).join(' → ')}</p>
          )}
        </div>
      )}
      <p className="text-[10px] text-white/35 leading-snug">
        Hooks drop in at the playhead and stack. Applying another full edit re-packs from your current clips.
      </p>
      {appliedId && (
        <p className="text-[11px] text-gold flex items-center gap-1">
          <Check size={12} strokeWidth={3} /> Applied: {getTemplate(appliedId)?.name}
        </p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {notice && <p className="text-[11px] text-white/50">{notice}</p>}

      {/* v9 frame prompt: the preset's frame ≠ the project's size —
          one clear choice, in place, before anything is applied. */}
      {framePrompt && framePrompt.frame && (
        <div className="flex flex-col gap-1.5 rounded-xl border border-gold/30 bg-gold/5 p-2.5">
          <span className="text-[11px] font-bold uppercase tracking-wide text-gold">
            {framePrompt.name} is a {framePrompt.frame.aspect} preset
          </span>
          <p className="text-[11px] text-white/50 leading-snug">
            Your project is {findAspectRatioOption(project.canvasWidth, project.canvasHeight)?.id ?? `${project.canvasWidth}×${project.canvasHeight}`}.
            Switch the project to {framePrompt.frame.aspect} for the exact preset frame, or apply inside your current size — either way every clip gets cropped to the preset and graded.
          </p>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => void doApply(framePrompt, true)}
              className="min-h-11 px-3 rounded-lg bg-gold hover:bg-gold-bright text-black text-[11px] font-bold"
            >
              Switch to {framePrompt.frame.aspect} + apply
            </button>
            <button
              onClick={() => void doApply(framePrompt, false)}
              className="min-h-11 px-3 rounded-lg border border-white/20 bg-white/5 hover:bg-white/10 text-white text-[11px] font-bold"
            >
              Apply in current size
            </button>
            <button
              onClick={() => setFramePrompt(null)}
              className="min-h-11 px-3 text-[11px] font-bold uppercase tracking-wide text-white/60 hover:text-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Post-apply crop step: every video the template shortened can
          have its surviving segment re-chosen in the crop picker. */}
      {pendingAdjust && (
        <div className="flex flex-col gap-1.5 rounded-xl border border-gold/30 bg-gold/5 p-2.5">
          <span className="text-[11px] font-bold uppercase tracking-wide text-gold flex items-center gap-1.5">
            <Crop size={12} /> Adjust clips
          </span>
          <p className="text-[11px] text-white/50 leading-snug">
            The template shortened {pendingAdjust.length} clip{pendingAdjust.length === 1 ? '' : 's'}. Pick which part of each one survives — or skip and keep the default crop.
          </p>
          {pendingAdjust.map((clip) => (
            <div key={clip.itemId} className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate text-xs text-white/80">{clip.fileName}</span>
              <button
                onClick={() => setAdjustTargetId(clip.itemId)}
                className="shrink-0 min-h-11 px-3 rounded-lg border border-gold/40 bg-gold/10 hover:bg-gold/20 text-gold text-[11px] font-bold"
              >
                Adjust crop
              </button>
            </div>
          ))}
          <button
            onClick={() => setPendingAdjust(null)}
            className="self-end min-h-11 px-3 text-[11px] font-bold uppercase tracking-wide text-white/60 hover:text-white"
          >
            Done
          </button>
        </div>
      )}

      {/* v9 post-apply reframe step: every clip the preset cropped to
          its frame can have its window re-positioned. */}
      {pendingFramed && !reframeTarget && (
        <div className="flex flex-col gap-1.5 rounded-xl border border-gold/30 bg-gold/5 p-2.5">
          <span className="text-[11px] font-bold uppercase tracking-wide text-gold flex items-center gap-1.5">
            <Frame size={12} /> Reframe clips
          </span>
          <p className="text-[11px] text-white/50 leading-snug">
            The preset cropped {pendingFramed.length} clip{pendingFramed.length === 1 ? '' : 's'} to its frame. Slide any
            window if the crop missed the subject — or skip and keep the smart default.
          </p>
          {pendingFramed.map((clip) => (
            <div key={clip.itemId} className="flex items-center gap-2">
              <span className="flex-1 min-w-0 truncate text-xs text-white/80">{clip.fileName}</span>
              <button
                onClick={() => setReframeTargetId(clip.itemId)}
                className="shrink-0 min-h-11 px-3 rounded-lg border border-gold/40 bg-gold/10 hover:bg-gold/20 text-gold text-[11px] font-bold"
              >
                Reframe
              </button>
            </div>
          ))}
          <button
            onClick={() => setPendingFramed(null)}
            className="self-end min-h-11 px-3 text-[11px] font-bold uppercase tracking-wide text-white/60 hover:text-white"
          >
            Done
          </button>
        </div>
      )}

      {reframeTarget && reframeAsset && (reframeTarget.type === 'video' || reframeTarget.type === 'image') && (
        <ReframePicker
          item={reframeTarget}
          asset={reframeAsset}
          onCancel={() => setReframeTargetId(null)}
          onConfirm={(crop) => {
            mutate((p) => updateItem(p, reframeTarget.id, { crop }));
            setReframeTargetId(null);
          }}
        />
      )}

      {adjustTarget && adjustAsset && adjustTarget.type === 'video' && (
        <SlotTrimPicker
          item={adjustTarget}
          asset={adjustAsset}
          onCancel={() => setAdjustTargetId(null)}
          onConfirm={(trimStart) => {
            const length = adjustTarget.trimEnd - adjustTarget.trimStart;
            mutate((p) => updateItem(p, adjustTarget.id, { trimStart, trimEnd: trimStart + length }));
            setAdjustTargetId(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * One reel card: the Stage-A poster (accent gradient treated with the
 * template's grade filter — the filter sits on the poster layer only,
 * never on the type above it), its headline in its caption style, the
 * slot-plan bars, and the two facts a card carries (duration, clips).
 */
/**
 * Stage-B preview host: the focused card's own-media frames, moved
 * into this layer (appendChild — the preview cache keeps the canvas
 * references; on unmount they stay parented here and are simply
 * orphaned if the cache evicts them). With more than one frame the
 * layer crossfades between them; a single frame is static.
 */
function ReelPreviewLayer({ canvases }: { canvases: HTMLCanvasElement[] }) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren();
    canvases.forEach((canvas, i) => {
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.objectFit = 'contain';
      canvas.style.transition = 'opacity 500ms ease';
      canvas.style.opacity = i === 0 ? '1' : '0';
      host.appendChild(canvas);
    });
    setActiveIndex(0);
  }, [canvases]);

  useEffect(() => {
    if (canvases.length <= 1) return;
    const id = window.setInterval(() => {
      setActiveIndex((a) => (a + 1) % canvases.length);
    }, 1400);
    return () => window.clearInterval(id);
  }, [canvases]);

  useEffect(() => {
    canvases.forEach((canvas, i) => {
      canvas.style.opacity = i === activeIndex ? '1' : '0';
    });
  }, [canvases, activeIndex]);

  return <span ref={hostRef} aria-hidden className="absolute inset-0 block" />;
}

function ReelTemplateCard({
  model,
  focused,
  applied,
  previewCanvases,
  onTap,
  registerRef,
}: {
  model: ReelCardModel;
  focused: boolean;
  applied: boolean;
  previewCanvases?: HTMLCanvasElement[];
  onTap: () => void;
  registerRef: (el: HTMLButtonElement | null) => void;
}) {
  const { poster } = model;
  return (
    <button
      type="button"
      ref={registerRef}
      data-reel-card={model.id}
      onClick={onTap}
      aria-pressed={focused}
      aria-label={`${model.name} — ${model.kindLabel}, ${model.durationLabel}`}
      className={`relative shrink-0 overflow-hidden rounded-xl text-left ${
        focused ? 'ring-2 ring-gold' : 'ring-1 ring-white/15'
      }`}
      style={{
        width: REEL_LAYOUT.cardWidth,
        height: REEL_LAYOUT.cardHeight,
        scrollSnapAlign: 'start',
      }}
    >
      {/* Poster base — the grade treats this layer only. */}
      <span
        aria-hidden
        className="absolute inset-0 block"
        style={{
          background: poster.gradientCss,
          ...(poster.gradeFilter ? { filter: poster.gradeFilter } : {}),
        }}
      />
      {poster.headline && (
        <span
          aria-hidden
          className="absolute inset-x-1 text-center text-[11px] leading-tight line-clamp-3"
          style={{
            top: '30%',
            fontFamily: poster.headline.fontFamily,
            fontWeight: poster.headline.fontWeight,
            color: poster.headline.color,
            textTransform: poster.headline.uppercase ? 'uppercase' : 'none',
          }}
        >
          {poster.headline.text}
        </span>
      )}

      {/* Stage-B own-media preview: above the poster, below every
          overlay/chip; only ever on the focused card. */}
      {focused && previewCanvases && previewCanvases.length > 0 && (
        <ReelPreviewLayer canvases={previewCanvases} />
      )}

      {/* Kind glyph, top-left. */}
      <span className="absolute left-1 top-1 flex items-center justify-center rounded-full bg-black/55 p-1 text-white/85">
        {model.kind === 'hook' ? <Sparkles size={11} /> : <Clapperboard size={11} />}
      </span>

      {/* Top-right stack: applied check, then duration, then frame. */}
      <span className="absolute right-1 top-1 flex flex-col items-end gap-1">
        {applied && (
          <span className="flex items-center justify-center rounded-full bg-gold p-1 text-black">
            <Check size={11} strokeWidth={3.5} />
          </span>
        )}
        <span className="rounded-full bg-black/55 px-1.5 py-0.5 text-[9px] font-bold text-white/85">{model.durationLabel}</span>
        {model.frameAspect && (
          <span className="rounded-full bg-black/55 px-1.5 py-0.5 text-[9px] font-bold text-white/85">{model.frameAspect}</span>
        )}
      </span>

      {/* Bottom stack: slot bars over the name overlay. */}
      <span className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-black/75 via-black/35 to-transparent px-1.5 pb-1.5 pt-4">
        {poster.slotSegments.length > 0 && (
          <span aria-hidden className="flex gap-px">
            {poster.slotSegments.map((seg) => (
              <span
                key={seg.name}
                className="block h-[3px] rounded-full"
                style={{
                  flexGrow: seg.fraction,
                  flexBasis: '0%',
                  background: model.accentColor,
                  opacity: 0.45 + 0.55 * seg.fraction,
                }}
              />
            ))}
          </span>
        )}
        <span className="truncate text-[10px] font-bold leading-tight" style={{ color: model.accentColor }}>
          {model.name}
        </span>
        <span className="flex items-center justify-between gap-1">
          <span className="truncate text-[8.5px] leading-tight text-white/60">
            {model.kindLabel}
            {model.slotCount ? ` · ${model.slotCount} clips` : ''}
          </span>
          {focused &&
            (applied ? (
              <span className="shrink-0 rounded-full border border-gold/50 bg-gold/15 px-1.5 py-0.5 text-[9px] font-bold text-gold">Applied</span>
            ) : (
              <span className="shrink-0 rounded-full bg-gold px-1.5 py-0.5 text-[9px] font-bold text-black">Apply</span>
            ))}
        </span>
      </span>
    </button>
  );
}
