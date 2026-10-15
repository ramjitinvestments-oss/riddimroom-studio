import React, { useState } from 'react';
import { useProject } from '../../context/ProjectContext';
import { captionsToSRT, captionsToVTT, downloadTextFile, collectCues } from '../../lib/captions/export';
import { getItemsByTrackType } from '../../lib/timeline/utils';
import type { CaptionTimelineItem } from '../../types/timeline';

/** v1 captions export — SRT / VTT for YouTube, TikTok, Instagram, etc. Burn-in happens at export; these files are the sidecar option. */
export function CaptionsExportPanel() {
  const { project } = useProject();
  const [message, setMessage] = useState<string | null>(null);
  if (!project) return null;

  const captionItems = getItemsByTrackType(project, 'caption').filter((i) => i.type === 'caption') as CaptionTimelineItem[];
  const cues = collectCues(captionItems);
  const hasCues = cues.length > 0;

  const handleExport = (format: 'srt' | 'vtt') => {
    if (!hasCues) { setMessage('No captions yet — transcribe first, then export.'); return; }
    const base = (project.name || 'riddimroom-captions').replace(/[^\w-]+/g, '-').toLowerCase();
    const text = format === 'srt' ? captionsToSRT(cues) : captionsToVTT(cues);
    downloadTextFile(`${base}.${format}`, text, format === 'srt' ? 'text/plain' : 'text/vtt');
    setMessage(`Downloaded ${base}.${format} (${cues.length} cues).`);
  };

  return (
    <div className="flex flex-col gap-2 bg-white/5 border border-white/10 rounded-xl p-3">
      <h3 className="text-xs font-bold uppercase tracking-wide text-white/50">Export captions</h3>
      <p className="text-[11px] text-white/40">{hasCues ? `${cues.length} caption cues ready.` : 'No captions yet — transcribe a clip first.'}</p>
      <div className="flex gap-2">
        <button onClick={() => handleExport('srt')} disabled={!hasCues} className="px-3 py-2 rounded bg-white/10 hover:bg-white/20 text-xs font-bold disabled:opacity-40 min-h-10">Export SRT</button>
        <button onClick={() => handleExport('vtt')} disabled={!hasCues} className="px-3 py-2 rounded bg-white/10 hover:bg-white/20 text-xs font-bold disabled:opacity-40 min-h-10">Export VTT</button>
      </div>
      {message && <p className="text-[11px] text-emerald-400">{message}</p>}
    </div>
  );
}
