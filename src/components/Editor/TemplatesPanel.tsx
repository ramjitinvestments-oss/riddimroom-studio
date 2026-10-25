import React, { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Clapperboard, Crop, Loader2, Music, Sparkles } from 'lucide-react';
import { useProject } from '../../context/ProjectContext';
import {
  TEMPLATE_CATEGORIES,
  getTemplate,
  templatesByKind,
  type StudioTemplate,
  type TemplateCategory,
} from '../../lib/templates';
import type { MediaAsset, VideoTimelineItem } from '../../types/timeline';
import { applyFullTemplate, applyHookToProject, type ShortenedClipInfo } from '../../lib/templates/apply';
import { getLoopDef, renderLoopFile } from '../../lib/media/loops';
import { findAspectRatioOption } from '../../lib/aspectRatios';
import { uploadMediaFile } from '../../lib/media/upload';
import { updateItem } from '../../lib/timeline/utils';
import { SlotTrimPicker } from './SlotTrimPicker';

/**
 * Templates v3 — 20 ultra-premium viral templates in two collapsible
 * sections of COMPACT ROWS (v3 compact pass: thumbnail h-14/w-24, name +
 * one-line meta, small gold Apply pill — same actions as the v2 cards,
 * a fraction of the height).
 *
 * Hooks (1.5–4s) insert their text/effects into the open project at the
 * playhead. Full Edits (15–45s) now make their slot plan REAL: each
 * main-track clip/image is reduced to its slot's size and re-packed
 * into the reel, with the template's transition, per-slot motion, and
 * cinematic grade (see `lib/templates/apply.ts`). When a full template
 * suggests a built-in loop and the project has no music yet, the panel
 * renders + uploads that loop FIRST (the exact MusicPanel path) and
 * hands the asset to the apply, so the whole thing — trims, styling,
 * fitted music — still lands as ONE `mutate`, i.e. one undo step.
 * After an apply that shortened any video, an "Adjust clips" step
 * offers the crop picker for each shortened clip.
 */
export function TemplatesPanel({ currentTime = 0, uid }: { currentTime?: number; uid: string }) {
  const { project, mutate } = useProject();
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [category, setCategory] = useState<TemplateCategory | 'All'>('All');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<{ hooks: boolean; full: boolean }>({ hooks: true, full: true });
  const [pendingAdjust, setPendingAdjust] = useState<ShortenedClipInfo[] | null>(null);
  const [adjustTargetId, setAdjustTargetId] = useState<string | null>(null);

  const hooks = useMemo(() => filterByCategory(templatesByKind('hook'), category), [category]);
  const fulls = useMemo(() => filterByCategory(templatesByKind('full'), category), [category]);

  if (!project) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-white/50">Templates</h3>
        <p className="text-[11px] text-white/40">Open a project first — hooks drop into the open project at the playhead, and full edits restyle it.</p>
      </div>
    );
  }

  const [framePrompt, setFramePrompt] = useState<StudioTemplate | null>(null);

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
      // Full edit: pre-render the suggested loop (only when the project
      // has no music yet) so it can ride along in the same mutate.
      let loopAsset: MediaAsset | undefined;
      const needsMusic = !!t.suggestedLoopId && !project.items.some((i) => i.type === 'audio' && i.role === 'music');
      if (needsMusic) {
        const def = getLoopDef(t.suggestedLoopId!);
        if (def) {
          setBusyId(t.id);
          try {
            const file = await renderLoopFile(def);
            const uploaded = await uploadMediaFile({ uid, file });
            loopAsset = uploaded.asset;
          } catch {
            // Music is a bonus layer — the template still applies
            // without it (the note below says so honestly).
            loopAsset = undefined;
          } finally {
            setBusyId(null);
          }
        }
      }
      // Apply against the LIVE project state inside the updater (the
      // single mutate = the single undo step); the pure result is
      // captured alongside for the adjust-clips step and the notice —
      // the same record-a-value pattern ProjectContext itself uses.
      let result = applyFullTemplate(project, t, { loopAsset, switchToFrame });
      mutate((current) => {
        result = applyFullTemplate(current, t, { loopAsset, switchToFrame });
        return result.project;
      });
      setAppliedId(t.id);
      setPendingAdjust(result.shortenedClips.length > 0 ? result.shortenedClips : null);
      if (result.canvasSwitched) {
        setNotice(`Project switched to ${t.frame?.aspect} — the frame this preset is designed for. Every clip was cropped to it.`);
      } else if (needsMusic) {
        setNotice(
          result.musicAdded
            ? `Music added: ${getLoopDef(t.suggestedLoopId!)?.label ?? 'built-in loop'}, fitted to your ${Math.max(0, result.reelEndSeconds - result.reelStartSeconds).toFixed(1)}s reel.`
            : 'The suggested loop could not be created (connection?) — template applied without music. You can add it from the Music panel.',
        );
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not apply template.');
    }
  };

  const adjustTarget = adjustTargetId
    ? project.items.find((i): i is VideoTimelineItem => i.id === adjustTargetId && i.type === 'video')
    : undefined;
  const adjustAsset = adjustTarget ? project.mediaAssets[adjustTarget.mediaAssetId] : undefined;

  return (
    <div className="flex flex-col gap-2.5">
      <h3 className="text-[11px] font-bold uppercase tracking-wide text-white/50">Templates</h3>
      <p className="text-[11px] text-white/40 leading-snug">
        <span className="text-gold">Hooks</span> drop into this project at the playhead. <span className="text-gold">Full edits</span> trim
        your clips to the slot plan and re-pack them into the reel.
      </p>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {notice && <p className="text-[11px] text-white/50">{notice}</p>}
      {appliedId && (
        <p className="text-[11px] text-gold flex items-center gap-1">
          <Check size={12} strokeWidth={3} /> Applied: {getTemplate(appliedId)?.name}
        </p>
      )}

      {/* Category chips: one slim scrollable row (v3 compact pass). */}
      <div className="flex flex-nowrap gap-1 overflow-x-auto pb-0.5 -mx-0.5 px-0.5">
        {(['All', ...TEMPLATE_CATEGORIES] as const).map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`shrink-0 min-h-10 px-2.5 rounded-full text-[10px] font-bold border transition flex items-center ${
              category === c ? 'bg-gold text-black border-gold' : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10'
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      <TemplateSection
        title="Hooks · 1.5–4s"
        icon={<Sparkles size={12} className="text-gold" />}
        templates={hooks}
        appliedId={appliedId}
        busyId={busyId}
        onApply={handleApply}
        emptyText="No hooks in this category."
        open={openSections.hooks}
        onToggle={() => setOpenSections((s) => ({ ...s, hooks: !s.hooks }))}
      />
      <TemplateSection
        title="Full Edits · 15–45s"
        icon={<Clapperboard size={12} className="text-gold" />}
        templates={fulls}
        appliedId={appliedId}
        busyId={busyId}
        onApply={handleApply}
        emptyText="No full edits in this category."
        open={openSections.full}
        onToggle={() => setOpenSections((s) => ({ ...s, full: !s.full }))}
      />

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
              className="min-h-10 px-3 rounded-lg bg-gold hover:bg-gold-bright text-black text-[11px] font-bold"
            >
              Switch to {framePrompt.frame.aspect} + apply
            </button>
            <button
              onClick={() => void doApply(framePrompt, false)}
              className="min-h-10 px-3 rounded-lg border border-white/20 bg-white/5 hover:bg-white/10 text-white text-[11px] font-bold"
            >
              Apply in current size
            </button>
            <button
              onClick={() => setFramePrompt(null)}
              className="min-h-10 px-3 text-[11px] font-bold uppercase tracking-wide text-white/60 hover:text-white"
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
                className="shrink-0 min-h-10 px-3 rounded-lg border border-gold/40 bg-gold/10 hover:bg-gold/20 text-gold text-[11px] font-bold"
              >
                Adjust crop
              </button>
            </div>
          ))}
          <button
            onClick={() => setPendingAdjust(null)}
            className="self-end min-h-10 px-3 text-[11px] font-bold uppercase tracking-wide text-white/60 hover:text-white"
          >
            Done
          </button>
        </div>
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

function filterByCategory(list: StudioTemplate[], category: TemplateCategory | 'All'): StudioTemplate[] {
  return category === 'All' ? list : list.filter((t) => t.category === category);
}

function TemplateSection({
  title,
  icon,
  templates,
  appliedId,
  busyId,
  onApply,
  emptyText,
  open,
  onToggle,
}: {
  title: string;
  icon: React.ReactNode;
  templates: StudioTemplate[];
  appliedId: string | null;
  busyId: string | null;
  onApply: (t: StudioTemplate) => void;
  emptyText: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-1.5 min-h-10 text-left text-[11px] font-bold uppercase tracking-wider text-white/70 hover:text-white"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {icon} {title}
        <span className="text-white/30 normal-case tracking-normal font-normal">({templates.length})</span>
      </button>
      {open &&
        (templates.length === 0 ? (
          <p className="text-[11px] text-white/30">{emptyText}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {templates.map((t) => (
              <TemplateRow key={t.id} template={t} applied={appliedId === t.id} busy={busyId === t.id} onApply={onApply} />
            ))}
          </div>
        ))}
    </div>
  );
}

function TemplateRow({ template: t, applied, busy, onApply }: { template: StudioTemplate; applied: boolean; busy: boolean; onApply: (t: StudioTemplate) => void }) {
  const loop = t.suggestedLoopId ? getLoopDef(t.suggestedLoopId) : undefined;
  const meta = t.frame
    ? `${t.durationSeconds}s · Frame ${t.frame.aspect} ${t.frame.stage === 'card' ? '· Card stage' : '· Full-bleed'} · ${t.category}`
    : `${t.durationSeconds}s · ${t.aspectRatios.join(' ')} · ${t.category}`;
  return (
    <div
      className={`flex items-center gap-2 rounded-xl border bg-white/5 p-1.5 transition ${
        applied ? 'border-gold ring-1 ring-gold/60' : 'border-white/10'
      }`}
    >
      <TemplateRowThumb template={t} applied={applied} />
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span className="font-bold text-xs leading-tight truncate" style={{ color: t.accentColor }}>{t.name}</span>
        <span className="text-[10px] text-white/45 leading-tight truncate">{meta}</span>
        {t.kind === 'full' && t.slots ? (
          <span className="text-[9px] text-white/30 leading-tight truncate">{t.slots.map((s) => s.name).join(' → ')}</span>
        ) : (
          <span className="text-[9px] text-white/30 leading-tight truncate">{t.description}</span>
        )}
        {loop && (
          <span className="inline-flex items-center gap-1 text-[9px] text-gold/80 leading-tight">
            <Music size={9} /> {t.kind === 'full' ? 'Adds' : 'Pairs with'}: {loop.label}
          </span>
        )}
      </div>
      <button
        onClick={() => onApply(t)}
        disabled={busy}
        className={`shrink-0 min-h-10 px-3 rounded-full text-[11px] font-bold flex items-center gap-1 transition disabled:opacity-60 ${
          applied ? 'bg-gold/15 text-gold border border-gold/50' : 'bg-gold hover:bg-gold-bright text-black'
        }`}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : applied ? <Check size={12} strokeWidth={3} /> : null}
        {busy ? 'Applying…' : applied ? 'Applied' : 'Apply'}
      </button>
    </div>
  );
}

function TemplateRowThumb({ template, applied }: { template: StudioTemplate; applied: boolean }) {
  if (template.thumbnail) {
    return (
      <span className="relative block w-24 h-14 shrink-0 overflow-hidden rounded-lg bg-black">
        <img src={template.thumbnail} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
        {applied && (
          <span className="absolute top-1 right-1 flex items-center justify-center w-4 h-4 rounded-full bg-gold text-black">
            <Check size={10} strokeWidth={3.5} />
          </span>
        )}
      </span>
    );
  }
  const initials = template.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return (
    <span
      className="relative block w-24 h-14 shrink-0 overflow-hidden rounded-lg"
      style={{
        background:
          'radial-gradient(circle at 85% 15%, rgba(255,209,0,0.16) 0, transparent 45%), radial-gradient(circle at 10% 90%, rgba(255,138,0,0.10) 0, transparent 50%), linear-gradient(135deg, #161616 0%, #0a0a0a 100%)',
      }}
    >
      <span className="absolute inset-0 flex items-center justify-center font-black tracking-tight text-lg" style={{ color: template.accentColor }}>
        {initials}
      </span>
      {applied && (
        <span className="absolute top-1 right-1 flex items-center justify-center w-4 h-4 rounded-full bg-gold text-black">
          <Check size={10} strokeWidth={3.5} />
        </span>
      )}
    </span>
  );
}
