import React, { useCallback, useRef } from 'react';
import type { Project } from '../../types/timeline';
import { getProjectDuration, getItemsForTrack } from '../../lib/timeline/utils';

interface TimelinePanelProps {
  project: Project;
  currentTime: number;
  onSeek: (time: number) => void;
  selectedItemId: string | null;
  onSelectItem: (itemId: string | null) => void;
}

const TRACK_COLORS: Record<string, string> = {
  video: 'bg-blue-500/70',
  image: 'bg-purple-500/70',
  text: 'bg-amber-500/70',
  caption: 'bg-pink-500/70',
  audio: 'bg-emerald-500/70',
};

export function TimelinePanel({ project, currentTime, onSeek, selectedItemId, onSelectItem }: TimelinePanelProps) {
  const trackAreaRef = useRef<HTMLDivElement>(null);
  const duration = Math.max(getProjectDuration(project), 1);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = trackAreaRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      onSeek(fraction * duration);
    },
    [duration, onSeek],
  );

  const sortedTracks = [...project.tracks].sort((a, b) => a.order - b.order);

  return (
    <div className="flex flex-col gap-1 bg-white/5 rounded-lg p-3">
      <div className="flex items-center justify-between text-[10px] text-white/40 font-mono mb-1">
        <span>0:00</span>
        <span>{duration.toFixed(1)}s total</span>
      </div>
      <div
        ref={trackAreaRef}
        onClick={(e) => seekFromClientX(e.clientX)}
        className="relative flex flex-col gap-1 cursor-pointer select-none"
      >
        <div
          className="absolute top-0 bottom-0 w-px bg-white z-10 pointer-events-none"
          style={{ left: `${Math.min(100, (currentTime / duration) * 100)}%` }}
        />
        {sortedTracks.map((track) => {
          const items = getItemsForTrack(project, track.id);
          return (
            <div key={track.id} className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-[10px] text-white/40 uppercase tracking-wide truncate">{track.name}</span>
              <div className="relative flex-1 h-6 bg-white/5 rounded overflow-hidden">
                {items.map((item) => {
                  const left = (item.startTime / duration) * 100;
                  const width = Math.max(0.5, ((item.endTime - item.startTime) / duration) * 100);
                  const isSelected = item.id === selectedItemId;
                  return (
                    <div
                      key={item.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectItem(item.id);
                        onSeek(item.startTime);
                      }}
                      title={item.type}
                      className={`absolute top-0.5 bottom-0.5 rounded ${TRACK_COLORS[track.type] || 'bg-white/40'} ${
                        isSelected ? 'ring-2 ring-white' : ''
                      } ${!item.visible ? 'opacity-30' : ''}`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
        {sortedTracks.length === 0 && <p className="text-xs text-white/30 py-4 text-center">No tracks yet.</p>}
      </div>
    </div>
  );
}
