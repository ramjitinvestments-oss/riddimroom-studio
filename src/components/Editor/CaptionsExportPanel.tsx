import React, { useRef, useState } from 'react';
import { useProject } from '../../context/ProjectContext';
import { captionsToSRT, captionsToVTT, downloadTextFile, collectCues } from '../../lib/captions/export';
import { applyImportedCaptions, parseSubtitleFile, SubtitleImportError } from '../../lib/captions/subtitleImport';
import { getItemsByTrackType } from '../../lib/timeline/utils';
import type { CaptionTimelineItem } from '../../types/timeline';

/** v1 captions export — SRT / VTT for YouTube, TikTok, Instagram, etc. Burn-in happens at export; these files are the sidecar option. Import (SRT/ASS) brings an existing caption file into the same caption model transcription writes to. */
export function CaptionsExportPanel() {
  const { project, mutate } = useProject();
  const [message, setMessage] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  if (!project) return null;

  const captionItems = getItemsByTrackType(project, 'caption').filter((i) => i.type === 'caption') as CaptionTimelineItem[];
  const cues = collectCues(captionItems);
  const hasCues = cues.length > 0;

  /** R17 Viral Finish: one tap restyles every cue to the signature
      word-by-word Viral Gold Pop — the compositor already pops the
      active word and fills it gold from the words[] timings. */
  const handleMakeViral = () => {
    mutate((p) => ({
      ...p,
      items: p.items.map((i) => (i.type === 'caption' ? { ...i, captionStyleId: 'viral-gold-pop' } : i)),
    }));
    setMessage(`All ${cues.length} captions now use Viral Gold Pop — word by word, gold on the beat of the voice.`);
  };

  const handleExport = (format: 'srt' | 'vtt') => {
    if (!hasCues) { setMessage('No captions yet — transcribe first, then export.'); return; }
    const base = (project.name || 'riddimroom-captions').replace(/[^\w-]+/g, '-').toLowerCase();
    const text = format === 'srt' ? captionsToSRT(cues) : captionsToVTT(cues);
    downloadTextFile(`${base}.${format}`, text, format === 'srt' ? 'text/plain' : 'text/vtt');
    setMessage(`Downloaded ${base}.${format} (${cues.length} cues).`);
  };

  const handleImportFile = async (file: File) => {
    setMessage(null);
    setImportError(null);
    try {
      const content = await file.text();
      const result = parseSubtitleFile(content, file.name);
      mutate((p) => applyImportedCaptions(p, result.cues));
      setMessage(
        `Imported ${result.cues.length} caption${result.cues.length === 1 ? '' : 's'} from ${file.name}` +
        (result.skippedCount > 0 ? ` — ${result.skippedCount} malformed ${result.skippedCount === 1 ? 'entry' : 'entries'} skipped.` : '.'),
      );
    } catch (err: any) {
      setImportError(err instanceof SubtitleImportError ? err.message : 'That subtitle file could not be read.');
    }
  };

  return (
    <div className="flex flex-col gap-2 bg-white/5 border border-white/10 rounded-xl p-3">
      <h3 className="text-xs font-bold uppercase tracking-wide text-white/50">Caption files</h3>
      <p className="text-[11px] text-white/40">{hasCues ? `${cues.length} caption cues ready.` : 'No captions yet — transcribe a clip, add one by hand above, or import a caption file.'}</p>
      {hasCues && (
        <button onClick={handleMakeViral} className="px-3 py-2 rounded bg-gold text-black hover:bg-gold/90 text-xs font-bold min-h-10">
          Make captions viral — word by word
        </button>
      )}
      <div className="flex gap-2">
        <button onClick={() => handleExport('srt')} disabled={!hasCues} className="px-3 py-2 rounded bg-white/10 hover:bg-white/20 text-xs font-bold disabled:opacity-40 min-h-10">Export SRT</button>
        <button onClick={() => handleExport('vtt')} disabled={!hasCues} className="px-3 py-2 rounded bg-white/10 hover:bg-white/20 text-xs font-bold disabled:opacity-40 min-h-10">Export VTT</button>
        <button onClick={() => fileInputRef.current?.click()} className="px-3 py-2 rounded bg-white/10 hover:bg-white/20 text-xs font-bold min-h-10">Import captions</button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".srt,.ass,.ssa"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset so picking the same file again after an edit re-fires.
          e.target.value = '';
          if (file) void handleImportFile(file);
        }}
      />
      <p className="text-[11px] text-white/30">Import an .srt or .ass file — it replaces the current captions and stays fully editable.</p>
      {message && <p className="text-[11px] text-emerald-400">{message}</p>}
      {importError && <p className="text-[11px] text-red-400">{importError}</p>}
    </div>
  );
}
