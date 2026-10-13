import React, { useState } from 'react';
import { useProject } from '../../context/ProjectContext';
import { STUDIO_TEMPLATES, getTemplate } from '../../lib/templates';
import { applyTemplateToProject } from '../../lib/templates/apply';

/**
 * v1 Templates — 12 curated premium templates.
 * Applying a template styles captions, transitions, motion, and adds a
 * title when the template has one. Everything stays editable after.
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
      {appliedId && <p className="text-[11px] text-emerald-400">Applied: {getTemplate(appliedId)?.name}</p>}
      <div className="grid grid-cols-2 gap-2">
        {STUDIO_TEMPLATES.map((t) => (
          <button
            key={t.id}
            onClick={() => handleApply(t.id)}
            className={`text-left bg-white/5 hover:bg-white/10 border rounded-xl p-3 transition min-h-16 ${appliedId === t.id ? 'border-emerald-500' : 'border-white/10'}`}
          >
            <p className="font-bold text-xs" style={{ color: t.accentColor }}>{t.name}</p>
            <p className="text-[10px] text-white/40 mt-1 leading-snug">{t.description}</p>
            <p className="text-[10px] text-white/30 mt-1 uppercase">{t.category} · {t.aspectHint}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
