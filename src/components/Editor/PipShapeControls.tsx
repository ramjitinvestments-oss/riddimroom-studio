import React, { useEffect, useRef } from 'react';
import {
  PIP_BRAND_GOLD,
  PIP_GLOW_GOLD,
  PIP_GLOW_WHITE,
  PIP_SHAPES,
  tracePipShapePath,
} from '../../lib/pip';
import type { PipSettings, PipShape } from '../../types/timeline';

/**
 * R25 — the PiP shape picker shared by the PiP panel and the item
 * inspector (the two surfaces must offer the same nine shapes and the
 * same finishes, or the "mirror" between them breaks). Thumbnails are
 * LIVE renders: each chip draws the shape's actual registry path on a
 * mini canvas with the gold ring, at roughly PiP scale, so the choice
 * is made on the real geometry — the same path the compositor clips
 * and strokes in preview and export.
 */
export function PipShapeThumb({ shape, size = 26 }: { shape: PipShape; size?: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    try {
      const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, size, size);
      ctx.save();
      ctx.translate(size / 2, size / 2);
      const box = size - 6;
      ctx.beginPath();
      tracePipShapePath(ctx, shape, box, box);
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.fill();
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = PIP_BRAND_GOLD;
      ctx.stroke();
      ctx.restore();
    } catch {
      // Decorative only — a thumbnail that fails to paint never blocks the picker.
    }
  }, [shape, size]);
  return <canvas ref={ref} style={{ width: size, height: size }} aria-hidden="true" />;
}

export function PipShapeStrip({
  value,
  onChange,
}: {
  value: PipShape;
  onChange: (shape: PipShape) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-white/50">Shape</span>
      <div className="grid grid-cols-5 gap-1">
        {PIP_SHAPES.map((def) => (
          <button
            key={def.id}
            onClick={() => onChange(def.id)}
            aria-pressed={value === def.id}
            title={def.label}
            className={`flex flex-col items-center gap-0.5 px-1 py-1.5 rounded min-h-11 ${
              value === def.id ? 'bg-gold/90 text-black' : 'bg-white/10 hover:bg-white/20 text-white'
            }`}
          >
            <PipShapeThumb shape={def.id} size={24} />
            <span className="text-[8px] font-bold uppercase leading-none">{def.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ring styles + glow
// ---------------------------------------------------------------------------

export type PipRingId = 'none' | 'white' | 'gold' | 'gradient' | 'black' | 'custom';

export function pipRingId(pip: PipSettings): PipRingId {
  if (!(pip.borderWidth > 0)) return 'none';
  if (pip.ringGradient) return 'gradient';
  const c = (pip.borderColor || '').toUpperCase();
  if (c === '#FFFFFF') return 'white';
  if (c === PIP_BRAND_GOLD) return 'gold';
  if (c === '#000000' || c === '#111111') return 'black';
  return 'custom';
}

export function pipRingPatch(pip: PipSettings, id: Exclude<PipRingId, 'custom'>): Partial<PipSettings> {
  const width = pip.borderWidth > 0 ? pip.borderWidth : 4;
  switch (id) {
    case 'none':
      return { borderWidth: 0, ringGradient: false };
    case 'white':
      return { borderColor: '#FFFFFF', ringGradient: false, borderWidth: width };
    case 'gold':
      return { borderColor: PIP_BRAND_GOLD, ringGradient: false, borderWidth: width };
    case 'gradient':
      return { ringGradient: true, borderWidth: width };
    case 'black':
      return { borderColor: '#000000', ringGradient: false, borderWidth: width };
  }
}

const RING_CHIPS: { id: Exclude<PipRingId, 'custom'>; label: string; swatch: string }[] = [
  { id: 'none', label: 'None', swatch: 'transparent' },
  { id: 'white', label: 'White', swatch: '#FFFFFF' },
  { id: 'gold', label: 'Gold', swatch: PIP_BRAND_GOLD },
  { id: 'gradient', label: 'Gold gradient', swatch: 'linear-gradient(135deg,#FFE45C,#C99300)' },
  { id: 'black', label: 'Black', swatch: '#000000' },
];

export function PipRingControls({
  pip,
  onPatch,
}: {
  pip: PipSettings;
  onPatch: (patch: Partial<PipSettings>) => void;
}) {
  const active = pipRingId(pip);
  const glowOn = pip.glow === true;
  const glowColor = (pip.glowColor ?? PIP_GLOW_GOLD).toUpperCase();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-white/50">Ring</span>
        <div className="flex flex-wrap gap-1">
          {RING_CHIPS.map((chip) => (
            <button
              key={chip.id}
              onClick={() => onPatch(pipRingPatch(pip, chip.id))}
              aria-pressed={active === chip.id}
              className={`flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold uppercase rounded min-h-9 ${
                active === chip.id ? 'bg-gold text-black' : 'bg-white/10 hover:bg-white/20 text-white'
              }`}
            >
              <span
                className="inline-block w-3 h-3 rounded-full border border-black/30"
                style={{ background: chip.swatch }}
                aria-hidden="true"
              />
              {chip.label}
            </button>
          ))}
          {active === 'custom' && (
            <span className="text-[10px] text-white/40 self-center">Custom colour (inspector)</span>
          )}
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs text-white/60">
        <input
          type="checkbox"
          checked={glowOn}
          onChange={(e) => onPatch({ glow: e.target.checked })}
        />
        Glow (soft light around the shape)
      </label>
      {glowOn && (
        <div className="flex gap-1">
          {([
            ['Gold', PIP_GLOW_GOLD],
            ['White', PIP_GLOW_WHITE],
          ] as const).map(([label, color]) => (
            <button
              key={color}
              onClick={() => onPatch({ glowColor: color })}
              aria-pressed={glowColor === color}
              className={`flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold uppercase rounded min-h-9 ${
                glowColor === color ? 'bg-gold text-black' : 'bg-white/10 hover:bg-white/20 text-white'
              }`}
            >
              <span
                className="inline-block w-3 h-3 rounded-full border border-black/30"
                style={{ background: color }}
                aria-hidden="true"
              />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
