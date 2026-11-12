import React from 'react';
import { useProject } from '../../context/ProjectContext';
import { captionMotionSelection, setAllCaptionMotion, type CaptionMotionSetting } from '../../lib/captions/motion';

/**
 * R42 Phase C — the Caption motion control (Step 2 Captions group).
 *
 * Captions animate in and fade out: by default each cue follows its
 * caption STYLE's own entrance (Fade / Pop / Rise — see
 * lib/captions/motion.ts), so templates carry the motion with their
 * styles and most users never touch this. The control is the
 * override: one tap sets every cue in the project to one entrance —
 * or clears the override back to follow-the-style — as a single
 * undo step. Off restores the old hard cut. There is no exit choice:
 * every cue fades out, always.
 */
const OPTIONS: Array<{ value: CaptionMotionSetting | 'style'; label: string }> = [
  { value: 'style', label: 'Style' },
  { value: 'fade', label: 'Fade' },
  { value: 'pop', label: 'Pop' },
  { value: 'rise', label: 'Rise' },
  { value: 'off', label: 'Off' },
];

export function CaptionMotionPanel() {
  const { project, mutate } = useProject();
  if (!project) return null;

  const hasCaptions = project.items.some((i) => i.type === 'caption');
  const selection = captionMotionSelection(project);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-bold uppercase tracking-wide text-white/50">Caption motion</span>
      {hasCaptions ? (
        <>
          <div className="flex items-center gap-1 bg-white/5 rounded-lg p-1" role="group" aria-label="Caption motion">
            {OPTIONS.map((option) => {
              const isActive = selection === option.value;
              return (
                <button
                  key={option.value}
                  onClick={() => mutate((p) => setAllCaptionMotion(p, option.value))}
                  aria-pressed={isActive}
                  className={`flex-1 min-h-11 px-2 inline-flex items-center justify-center text-[11px] font-bold uppercase tracking-wide rounded-md transition ${
                    isActive ? 'bg-gold text-black' : 'text-white/70 hover:bg-white/10'
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-white/50">
            {selection === 'style'
              ? 'Captions animate in the way their style suggests, and always fade out.'
              : selection === 'mixed'
                ? 'Your captions don’t all agree right now — pick one and they will.'
                : selection === 'off'
                  ? 'Captions cut in and out with no motion.'
                  : 'Every caption uses this entrance, and always fades out.'}
          </p>
        </>
      ) : (
        <p className="text-[11px] text-white/50">Add captions first — then choose how they arrive. They always fade out.</p>
      )}
    </div>
  );
}
