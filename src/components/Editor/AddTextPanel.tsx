import React, { useState } from 'react';
import { useProject } from '../../context/ProjectContext';
import { addTextItem } from '../../lib/timeline/insert';

/** Phase 1 Step 9 (Text overlay) — adds a new `text` timeline item at the current playhead. */
export function AddTextPanel({ currentTime }: { currentTime: number }) {
  const { mutate } = useProject();
  const [text, setText] = useState('');

  const handleAdd = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    mutate((project) => addTextItem(project, { text: trimmed, atTime: currentTime, durationSeconds: 3 }));
    setText('');
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-bold uppercase tracking-wide text-white/50">Add text</label>
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd();
          }}
          placeholder="Title, caption, lower-third…"
          className="flex-1 bg-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-white/30"
        />
        <button
          onClick={handleAdd}
          disabled={!text.trim()}
          className="px-3 py-2 text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 disabled:opacity-40 rounded-lg text-white"
        >
          Add
        </button>
      </div>
      <p className="text-[10px] text-white/30">Inserted at {currentTime.toFixed(1)}s, editable afterward in the inspector.</p>
    </div>
  );
}
