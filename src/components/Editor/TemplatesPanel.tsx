import React, { useMemo, useState } from 'react';
import { Check, Clapperboard, Clock, Music, Sparkles } from 'lucide-react';
import { useProject } from '../../context/ProjectContext';
import {
  STUDIO_TEMPLATES,
  TEMPLATE_CATEGORIES,
  getTemplate,
  templatesByKind,
  type StudioTemplate,
  type TemplateCategory,
} from '../../lib/templates';
import { applyHookToProject, applyTemplateToProject } from '../../lib/templates/apply';
import { getLoopDef } from '../../lib/media/loops';

/**
 * Templates v2 — 20 ultra-premium viral templates in two sections:
 * Hooks (1.5–4s) insert their text/effects into the open project at the
 * playhead; Full Edits (15–45s) restyle the project against a slot plan.
 * Cards keep the designed-header approach: CDN artwork where a template
 * has it, otherwise a near-black gradient with a gold monogram.
 */
export function TemplatesPanel({ currentTime = 0 }: { currentTime?: number }) {
  const { project, mutate } = useProject();
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<TemplateCategory | 'All'>('All');

  const hooks = useMemo(() => filterByCategory(templatesByKind('hook'), category), [category]);
  const fulls = useMemo(() => filterByCategory(templatesByKind('full'), category), [category]);

  if (!project) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-white/50">Templates</h3>
        <p className="text-[11px] text-white/40">Open a project first — hooks drop into the open project at the playhead, and full edits restyle it.</p>
      </div>
    );
  }

  const handleApply = (t: StudioTemplate) => {
    setError(null);
    try {
      if (t.kind === 'hook') {
        mutate((p) => applyHookToProject(p, t, currentTime));
      } else {
        mutate((p) => applyTemplateToProject(p, t));
      }
      setAppliedId(t.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not apply template.');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-xs font-bold uppercase tracking-wide text-white/50">Templates</h3>
      <p className="text-[11px] text-white/40">
        20 ultra-premium looks. <span className="text-gold">Hooks</span> drop text + effects into this project at the playhead.{' '}
        <span className="text-gold">Full edits</span> restyle captions, transitions, and motion to a proven slot plan. Edit anything after.
      </p>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {appliedId && (
        <p className="text-[11px] text-gold flex items-center gap-1">
          <Check size={12} strokeWidth={3} /> Applied: {getTemplate(appliedId)?.name}
        </p>
      )}

      <div className="flex flex-wrap gap-1">
        {(['All', ...TEMPLATE_CATEGORIES] as const).map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`px-2 py-1 rounded-full text-[10px] font-bold border transition ${
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
        onApply={handleApply}
        emptyText="No hooks in this category."
      />
      <TemplateSection
        title="Full Edits · 15–45s"
        icon={<Clapperboard size={12} className="text-gold" />}
        templates={fulls}
        appliedId={appliedId}
        onApply={handleApply}
        emptyText="No full edits in this category."
      />
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
  onApply,
  emptyText,
}: {
  title: string;
  icon: React.ReactNode;
  templates: StudioTemplate[];
  appliedId: string | null;
  onApply: (t: StudioTemplate) => void;
  emptyText: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-[11px] font-bold uppercase tracking-wider text-white/70 flex items-center gap-1.5 mt-1">
        {icon} {title}
      </h4>
      {templates.length === 0 ? (
        <p className="text-[11px] text-white/30">{emptyText}</p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {templates.map((t) => (
            <TemplateCard key={t.id} template={t} applied={appliedId === t.id} onApply={onApply} />
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateCard({ template: t, applied, onApply }: { template: StudioTemplate; applied: boolean; onApply: (t: StudioTemplate) => void }) {
  const loop = t.suggestedLoopId ? getLoopDef(t.suggestedLoopId) : undefined;
  return (
    <button
      onClick={() => onApply(t)}
      className={`text-left bg-white/5 hover:bg-white/10 border rounded-xl overflow-hidden transition min-h-16 flex flex-col ${
        applied ? 'border-gold ring-1 ring-gold/60' : 'border-white/10'
      }`}
    >
      <TemplateCardHeader template={t} applied={applied} />
      <span className="p-3 pt-2 flex flex-col gap-1 w-full">
        <span className="font-bold text-xs" style={{ color: t.accentColor }}>{t.name}</span>
        <span className="flex flex-wrap items-center gap-1">
          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-gold/15 text-gold text-[9px] font-bold">
            <Clock size={9} strokeWidth={3} /> {t.durationSeconds}s
          </span>
          {t.aspectRatios.map((r) => (
            <span key={r} className="px-1.5 py-0.5 rounded bg-white/10 text-white/60 text-[9px] font-bold">{r}</span>
          ))}
          <span className="px-1.5 py-0.5 rounded bg-white/5 text-white/40 text-[9px] font-bold uppercase">{t.category}</span>
        </span>
        <span className="text-[10px] text-white/40 leading-snug">{t.description}</span>
        {t.kind === 'full' && t.slots && (
          <span className="text-[9px] text-white/30 leading-snug">{t.slots.map((s) => s.name).join(' → ')}</span>
        )}
        {loop && (
          <span className="inline-flex items-center gap-1 text-[9px] text-gold/80">
            <Music size={9} /> Pairs with: {loop.label}
          </span>
        )}
      </span>
    </button>
  );
}

function TemplateCardHeader({ template, applied }: { template: StudioTemplate; applied: boolean }) {
  if (template.thumbnail) {
    return (
      <span className="relative block w-full aspect-video overflow-hidden bg-black">
        <img src={template.thumbnail} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
        {applied && (
          <span className="absolute top-1.5 right-1.5 flex items-center justify-center w-5 h-5 rounded-full bg-gold text-black">
            <Check size={12} strokeWidth={3.5} />
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
      className="relative block w-full aspect-video overflow-hidden"
      style={{
        background:
          'radial-gradient(circle at 85% 15%, rgba(255,209,0,0.16) 0, transparent 45%), radial-gradient(circle at 10% 90%, rgba(255,138,0,0.10) 0, transparent 50%), linear-gradient(135deg, #161616 0%, #0a0a0a 100%)',
      }}
    >
      <span className="absolute inset-0 flex items-center justify-center font-black tracking-tight text-3xl" style={{ color: template.accentColor }}>
        {initials}
      </span>
      <span className="absolute bottom-1.5 right-2 text-[9px] font-bold uppercase tracking-widest text-white/25">{template.aspectRatios[0]}</span>
      {applied && (
        <span className="absolute top-1.5 right-1.5 flex items-center justify-center w-5 h-5 rounded-full bg-gold text-black">
          <Check size={12} strokeWidth={3.5} />
        </span>
      )}
    </span>
  );
}
