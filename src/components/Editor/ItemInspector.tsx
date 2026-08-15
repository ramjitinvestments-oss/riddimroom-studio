import React from 'react';
import type { TimelineItem } from '../../types/timeline';
import { useProject } from '../../context/ProjectContext';
import { updateItem, removeItem, getItemDuration } from '../../lib/timeline/utils';

/**
 * Generic property inspector for the currently-selected timeline item.
 * Fields shown depend on the item's `type` (position/size/opacity for
 * anything visual, text content/font/color for `text`, timing for
 * everything) — all edits go through `useProject().mutate` +
 * `updateItem`, i.e. through the Project/Timeline model, never local
 * component state that would need reconciling with it later.
 */

export function ItemInspector({ item }: { item: TimelineItem }) {
  const { mutate } = useProject();

  const patch = (fields: Record<string, unknown>) => {
    mutate((project) => updateItem(project, item.id, fields));
  };

  const patchPosition = (axis: 'x' | 'y', value: number) => {
    if (!('position' in item)) return;
    patch({ position: { ...(item as any).position, [axis]: value } });
  };

  const handleDelete = () => {
    mutate((project) => removeItem(project, item.id));
  };

  const duration = getItemDuration(item);

  return (
    <div className="flex flex-col gap-3 bg-white/5 rounded-lg p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-bold uppercase tracking-wide text-white/60">{item.type} item</span>
        <button onClick={handleDelete} className="text-red-400 hover:text-red-300 font-bold">
          Delete
        </button>
      </div>

      {item.type === 'text' && (
        <>
          <label className="flex flex-col gap-1">
            Text
            <textarea
              value={item.text}
              onChange={(e) => patch({ text: e.target.value })}
              className="bg-white/10 rounded px-2 py-1 text-white resize-none"
              rows={2}
            />
          </label>
          <label className="flex flex-col gap-1">
            Font size
            <input
              type="range"
              min={16}
              max={120}
              value={item.fontSize}
              onChange={(e) => patch({ fontSize: Number(e.target.value) })}
            />
          </label>
          <label className="flex items-center gap-2">
            Color
            <input type="color" value={item.color} onChange={(e) => patch({ color: e.target.value })} />
          </label>
        </>
      )}

      {(item.type === 'image' || item.type === 'video' || item.type === 'text') && 'position' in item && (
        <>
          <label className="flex flex-col gap-1">
            Position X ({(item as any).position.x.toFixed(0)}%)
            <input
              type="range"
              min={0}
              max={100}
              value={(item as any).position.x}
              onChange={(e) => patchPosition('x', Number(e.target.value))}
            />
          </label>
          <label className="flex flex-col gap-1">
            Position Y ({(item as any).position.y.toFixed(0)}%)
            <input
              type="range"
              min={0}
              max={100}
              value={(item as any).position.y}
              onChange={(e) => patchPosition('y', Number(e.target.value))}
            />
          </label>
          <label className="flex flex-col gap-1">
            Scale ({(item as any).scale.toFixed(2)}x)
            <input
              type="range"
              min={0.1}
              max={3}
              step={0.05}
              value={(item as any).scale}
              onChange={(e) => patch({ scale: Number(e.target.value) })}
            />
          </label>
          <label className="flex flex-col gap-1">
            Opacity ({Math.round((item as any).opacity * 100)}%)
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={(item as any).opacity}
              onChange={(e) => patch({ opacity: Number(e.target.value) })}
            />
          </label>
        </>
      )}

      <div className="flex items-center gap-2">
        <label className="flex flex-col gap-1 flex-1">
          Start (s)
          <input
            type="number"
            step={0.1}
            value={item.startTime}
            onChange={(e) => patch({ startTime: Number(e.target.value) })}
            className="bg-white/10 rounded px-2 py-1 text-white"
          />
        </label>
        <label className="flex flex-col gap-1 flex-1">
          End (s)
          <input
            type="number"
            step={0.1}
            value={item.endTime}
            onChange={(e) => patch({ endTime: Number(e.target.value) })}
            className="bg-white/10 rounded px-2 py-1 text-white"
          />
        </label>
      </div>
      <p className="text-white/30">Duration: {duration.toFixed(1)}s</p>

      <label className="flex items-center gap-2">
        <input type="checkbox" checked={item.visible} onChange={(e) => patch({ visible: e.target.checked })} />
        Visible
      </label>
    </div>
  );
}
