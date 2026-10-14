import React, { useState } from 'react';
import { Loader2, Music, Plus, Repeat, Scissors } from 'lucide-react';
import { useProject } from '../../context/ProjectContext';
import type { AudioTimelineItem, MediaAsset, TimelineItem } from '../../types/timeline';
import { appendMediaToTimeline } from '../../lib/timeline/insert';
import { getContentEndTime, loopAudioToProjectEnd, trimAudioToProjectEnd, updateItem } from '../../lib/timeline/utils';
import { LOOP_DEFS, renderLoopFile, type LoopDef } from '../../lib/media/loops';
import { uploadMediaFile } from '../../lib/media/upload';
import { MAX_FADE_SECONDS } from '../../lib/media/constants';

/**
 * Phase 2.3 — Music/Audio as a first-class Step 2 panel.
 *
 * (a) The project's own audio assets (uploaded/generated — the shared
 * `mediaAssets` pool, no separate library) with one-tap placement onto
 * the audio track through the same `appendMediaToTimeline` helper uploads
 * use.
 * (b) When an audio item is selected, its volume/mute/fade controls —
 * the same `AudioTimelineItem` fields ItemInspector's audio section
 * writes (one model, two surfaces, exactly like EffectsPanel vs the
 * inspector's motion section). Preview already applies volume ×
 * `computeFadeOpacity` per frame and the export renderer applies the
 * same pair to its Web Audio gains, so every control here is audible in
 * both.
 * (c) Built-in loops synthesized client-side (`lib/media/loops.ts`),
 * rendered to WAV and uploaded through `uploadMediaFile` — the identical
 * path a user audio upload takes — then placed as music items.
 */
export function MusicPanel({ uid, item }: { uid: string; item: TimelineItem | null }) {
  const { project, mutate } = useProject();
  const [busyLoopId, setBusyLoopId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!project) return null;

  const audioAssets: MediaAsset[] = Object.values(project.mediaAssets).filter((a) => a.kind === 'audio');
  const selectedAudio: AudioTimelineItem | null = item?.type === 'audio' ? item : null;

  const addAssetToTimeline = (asset: MediaAsset) => {
    mutate((p) => appendMediaToTimeline(p, asset, { role: 'music' }));
  };

  const addLoop = async (def: LoopDef) => {
    if (busyLoopId) return;
    setBusyLoopId(def.id);
    setError(null);
    try {
      const file = await renderLoopFile(def);
      const { asset } = await uploadMediaFile({ uid, file });
      mutate((p) => appendMediaToTimeline(p, asset, { role: 'music' }));
    } catch {
      setError(`Could not create "${def.label}" — check your connection and try again.`);
    } finally {
      setBusyLoopId(null);
    }
  };

  const header = (
    <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-white/50">
      <Music size={14} className="text-gold" /> Music & Audio
    </h3>
  );

  return (
    <div className="flex flex-col gap-3">
      {header}

      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wide text-white/40">Built-in loops</span>
        {LOOP_DEFS.map((def) => (
          <div key={def.id} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-2">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-white/90">{def.label}</p>
              <p className="text-[11px] text-white/40 leading-snug">{def.description}</p>
            </div>
            <button
              onClick={() => addLoop(def)}
              disabled={busyLoopId !== null}
              className="min-h-11 px-3 shrink-0 rounded-lg bg-gold hover:bg-gold-bright text-black text-xs font-bold flex items-center gap-1 transition disabled:opacity-50"
            >
              {busyLoopId === def.id ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} strokeWidth={3} />}
              {busyLoopId === def.id ? 'Creating…' : 'Add'}
            </button>
          </div>
        ))}
        {error && <p className="text-[11px] text-red-400">{error}</p>}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wide text-white/40">Your audio</span>
        {audioAssets.length === 0 ? (
          <p className="text-[11px] text-white/40">No audio in this project yet — use Add Audio under “Add media”, or add a built-in loop above.</p>
        ) : (
          audioAssets.map((asset) => (
            <div key={asset.id} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2.5 py-2">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-bold text-white/90 truncate">{asset.fileName}</p>
                <p className="text-[11px] text-white/40">
                  {asset.durationSeconds ? `${asset.durationSeconds.toFixed(1)}s` : 'Audio'}
                </p>
              </div>
              <button
                onClick={() => addAssetToTimeline(asset)}
                className="min-h-11 px-3 shrink-0 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/80 text-xs font-bold flex items-center gap-1 transition"
              >
                <Plus size={14} strokeWidth={3} /> Add to timeline
              </button>
            </div>
          ))
        )}
      </div>

      {selectedAudio ? (
        <AudioItemControls item={selectedAudio} />
      ) : (
        <p className="text-[11px] text-white/40">Select an audio clip on the timeline to adjust its volume and fades.</p>
      )}
    </div>
  );
}

/** Volume/mute/fade for the selected audio item — writes the item's real fields via `updateItem`, mirroring ItemInspector's audio section (fade clamped to min(MAX_FADE_SECONDS, clip duration), same as the inspector). */
function AudioItemControls({ item }: { item: AudioTimelineItem }) {
  const { project, mutate } = useProject();
  const patch = (fields: Record<string, unknown>) => {
    mutate((project) => updateItem(project, item.id, fields));
  };
  const clipDuration = item.endTime - item.startTime;
  const maxFade = Math.min(MAX_FADE_SECONDS, clipDuration);
  // Fit (tweaks round): both actions align this clip's end with the end
  // of everything ELSE on the timeline (`getContentEndTime` excluding
  // this item) — they never grow the project itself. Disabled with an
  // explanation when there is nothing else to fit to.
  const contentEnd = project ? getContentEndTime(project, item.id) : 0;
  const canFit = contentEnd > item.startTime + 0.1;
  return (
    <div className="flex flex-col gap-2 border-t border-white/10 pt-2">
      <span className="text-[10px] font-bold uppercase tracking-wide text-white/40">Selected audio clip</span>
      <div className="flex items-center gap-2">
        <label className="flex flex-col gap-1 flex-1 text-xs text-white/60">
          Volume ({Math.round(item.volume * 100)}%)
          <input type="range" min={0} max={1} step={0.05} value={item.volume} onChange={(e) => patch({ volume: Number(e.target.value) })} className="w-full" />
        </label>
        <label className="flex items-center gap-2 text-xs text-white/60">
          <input type="checkbox" checked={item.muted} onChange={(e) => patch({ muted: e.target.checked })} />
          Mute
        </label>
      </div>
      <div className="flex items-center gap-2">
        <label className="flex flex-col gap-1 flex-1 text-xs text-white/60">
          Fade in (s, max {maxFade.toFixed(1)})
          <input
            type="number"
            min={0}
            max={maxFade}
            step={0.1}
            value={item.fade.fadeInDuration}
            onChange={(e) => patch({ fade: { fadeInDuration: Math.max(0, Math.min(Number(e.target.value), maxFade)), fadeOutDuration: item.fade.fadeOutDuration } })}
            className="bg-white/10 rounded px-2 py-1 text-white"
          />
        </label>
        <label className="flex flex-col gap-1 flex-1 text-xs text-white/60">
          Fade out (s, max {maxFade.toFixed(1)})
          <input
            type="number"
            min={0}
            max={maxFade}
            step={0.1}
            value={item.fade.fadeOutDuration}
            onChange={(e) => patch({ fade: { fadeInDuration: item.fade.fadeInDuration, fadeOutDuration: Math.max(0, Math.min(Number(e.target.value), maxFade)) } })}
            className="bg-white/10 rounded px-2 py-1 text-white"
          />
        </label>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-white/10 pt-2">
        <span className="text-[10px] font-bold uppercase tracking-wide text-white/40">Fit to project</span>
        {item.loop && (
          <p className="text-[11px] font-bold text-gold flex items-center gap-1">
            <Repeat size={12} /> Looping — repeats to the project’s end
          </p>
        )}
        <div className="flex gap-2">
          <button
            onClick={() => mutate((p) => trimAudioToProjectEnd(p, item.id))}
            disabled={!canFit}
            className="min-h-11 flex-1 px-2 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 disabled:opacity-40 text-white/85 text-xs font-bold flex items-center justify-center gap-1.5 transition"
            title="Play this clip’s source once, cut or extended so it ends exactly when the rest of the project ends"
          >
            <Scissors size={14} /> Trim to project end
          </button>
          <button
            onClick={() => mutate((p) => loopAudioToProjectEnd(p, item.id))}
            disabled={!canFit}
            aria-pressed={!!item.loop}
            className={`min-h-11 flex-1 px-2 rounded-lg border text-xs font-bold flex items-center justify-center gap-1.5 transition disabled:opacity-40 ${
              item.loop
                ? 'border-gold ring-1 ring-gold/60 bg-gold/10 text-gold'
                : 'border-white/10 bg-white/5 hover:bg-white/10 text-white/85'
            }`}
            title="Repeat this clip inside its span until it reaches the project’s end — for music beds shorter than the video"
          >
            <Repeat size={14} /> Loop to fill project
          </button>
        </div>
        <p className="text-[11px] text-white/35 leading-snug">
          {canFit
            ? '“Trim” plays the source once, ending with the rest of the project. “Loop” repeats it to cover the whole project. Both add a short fade-out at the end if the clip has none.'
            : 'Nothing else on the timeline to fit to yet — add video or other content first.'}
        </p>
      </div>
    </div>
  );
}
