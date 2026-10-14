import React, { useState } from 'react';
import { Check } from 'lucide-react';
import { useProject } from '../../context/ProjectContext';
import { STUDIO_TEMPLATES, getTemplate, type StudioTemplate } from '../../lib/templates';
import { applyTemplateToProject } from '../../lib/templates/apply';

/**
 * v1 Templates — 12 curated premium templates.
 * Applying a template styles captions, transitions, motion, and adds a
 * title when the template has one. Everything stays editable after.
 *
 * Card design (polish batch): templates with `thumbnail` artwork get a
 * real image header; the rest get a designed fallback header — near-black
 * gradient, the template's initials as a big gold monogram, and a subtle
 * radial pattern — so no card is ever a flat text block. The applied
 * state reads in brand gold (emerald stays reserved for success states).
 */
export function TemplatesPanel() {
  const { project, mutate } = useProject();
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!project) return null;

  const handleApply = (id: string) => {
    const template = getTemplate(id);
    if (!template) return;
    setError(null);
    try {
      mutate((p) => applyTemplateToProject(p, template));
      setAppliedId(id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not apply template.');
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-bold uppercase tracking-wide text-white/50">Templates</h3>
      <p className="text-[11px] text-white/40">12 curated looks. Pick one — captions, transitions, and title update instantly. Edit anything after.</p>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {appliedId && (
        <p className="text-[11px] text-gold flex items-center gap-1">
          <Check size={12} strokeWidth={3} /> Applied: {getTemplate(appliedId)?.name}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {STUDIO_TEMPLATES.map((t) => (
          <button
            key={t.id}
            onClick={() => handleApply(t.id)}
            className={`text-left bg-white/5 hover:bg-white/10 border rounded-xl overflow-hidden transition min-h-16 flex flex-col ${
              appliedId === t.id ? 'border-gold ring-1 ring-gold/60' : 'border-white/10'
            }`}
          >
            <TemplateCardHeader template={t} applied={appliedId === t.id} />
            <span className="p-3 pt-2 flex flex-col">
              <span className="font-bold text-xs" style={{ color: t.accentColor }}>{t.name}</span>
              <span className="text-[10px] text-white/40 mt-1 leading-snug">{t.description}</span>
              <span className="text-[10px] text-white/30 mt-1 uppercase">{t.category} · {t.aspectHint}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
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
      <span className="absolute bottom-1.5 right-2 text-[9px] font-bold uppercase tracking-widest text-white/25">{template.aspectHint}</span>
      {applied && (
        <span className="absolute top-1.5 right-1.5 flex items-center justify-center w-5 h-5 rounded-full bg-gold text-black">
          <Check size={12} strokeWidth={3.5} />
        </span>
      )}
    </span>
  );
}
