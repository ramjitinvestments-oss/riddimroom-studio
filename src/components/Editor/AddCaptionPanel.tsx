import React, { useState } from 'react';
import { useProject } from '../../context/ProjectContext';
import { addManualCaptionCue } from '../../lib/timeline/insert';

/**
 * Manual caption creation (five-star surface audit, pre-live build 4) —
 * adds a hand-typed caption cue at the current playhead. Until this
 * panel existed, cues could only arrive via AI transcription or a
 * subtitle-file import, so "captions are fully editable" had no answer
 * for "…but I want to add one of my own" (a hook line, a name, a patois
 * line spelled the creator's way). Modeled on AddTextPanel: type, Add,
 * then refine wording/timing/style in the CaptionInspector like any
 * other cue — one caption model, no parallel state.
 */
export function AddCaptionPanel({ currentTime }: { currentTime: number }) {
  const { project, mutate } = useProject();
  const [text, setText] = useState('');

  if (!project) return null;

  const handleAdd = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    mutate((p) => addManualCaptionCue(p, { text: trimmed, atTime: currentTime }));
    setText('');
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-bold uppercase tracking-wide text-white/50">Add caption</label>
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd();
          }}
          placeholder="Type a caption line…"
          className="flex-1 min-w-0 bg-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-white/30"
        />
        <button
          onClick={handleAdd}
          disabled={!text.trim()}
          className="px-3 py-2 min-h-10 text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 disabled:opacity-40 rounded-lg text-white"
        >
          Add
        </button>
      </div>
      <p className="text-[10px] text-white/30">
        Added at the playhead ({currentTime.toFixed(1)}s) as a 2s cue — tap it on the timeline to edit wording, timing and style.
      </p>
    </div>
  );
}
