import React, { useEffect } from 'react';
import { X } from 'lucide-react';

/**
 * "Final production fix" spec item 3a (mobile-first redesign) — a hand-
 * built slide-up panel + backdrop, no new dependency needed per the plan.
 * Used on small viewports (below `lg`) to hold the Library and Selected
 * Item / Add panels that live as fixed side columns on desktop — see
 * `EditorShell.tsx`'s `<aside>` sections, which render the SAME child
 * content either inline (desktop) or inside this sheet (mobile), never a
 * second parallel mobile-only copy of the panel markup.
 *
 * Deliberately simple: fixed to the viewport bottom, a translate-based
 * open/close so it can transition, closes on backdrop tap or the header's
 * close button. Body scroll is locked while open so a background drag
 * doesn't scroll the page underneath the sheet.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  return (
    <div className={`fixed inset-0 z-40 lg:hidden ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open}>
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/60 transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        className={`absolute left-0 right-0 bottom-0 max-h-[80vh] bg-[#111111] rounded-t-2xl border-t border-white/10 flex flex-col transition-transform duration-200 ${
          open ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
          <span className="text-sm font-bold uppercase tracking-wide text-white/70">{title}</span>
          <button
            onClick={onClose}
            title="Close"
            className="min-h-11 min-w-11 flex items-center justify-center rounded-lg bg-white/10 hover:bg-white/20 text-white leading-none"
          >
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto p-4 flex flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}
