import { useEffect, useRef } from 'react';

/**
 * R42 Phase B — history-aware Back inside the editor.
 *
 * The problem (R42 plan, Ask 1): the app's router is path-based and the
 * editor's steps/sheets/modals are internal state, so the phone's own
 * Back button — the most natural "take me back" gesture there is —
 * left the project entirely instead of stepping back one screen.
 *
 * The model: every "layer" a Back press should consume (an editor
 * step change, an open bottom sheet, an open modal/picker) registers
 * a closer here AND pushes one browser-history entry (same URL, state
 * `{ rrBackLayer: id }`). EditorShell owns the single popstate
 * listener: on pop, `handleBackPop` compares the entry the browser
 * landed on with the registry and runs the closers of every layer
 * whose entry was popped past, top first. When no layers remain, the
 * handler does nothing and the router's own popstate handling takes
 * the user out of the editor exactly as before — leaving from the top
 * level is unchanged.
 *
 * Programmatic closes (a sheet's own X button, a picker's Cancel)
 * unregister their layer WITHOUT touching history. The stale history
 * entry that leaves behind is inert: a later Back press pops past it,
 * the handler finds no layer for it, and nothing happens on screen
 * for that one press. That bounded cost buys a hard guarantee — this
 * module never calls history.back() itself, so unmounts and nested
 * closes can never yank the user's history around.
 */

export interface BackLayer {
  id: number;
  close: () => void;
}

const layers: BackLayer[] = [];
let nextId = 1;

function currentHistoryLayerId(): number | null {
  try {
    const state = window.history.state as { rrBackLayer?: unknown } | null;
    return state && typeof state.rrBackLayer === 'number' ? state.rrBackLayer : null;
  } catch {
    return null;
  }
}

/**
 * Registers a Back layer and pushes its history entry. Returns an
 * idempotent unregister (programmatic close / unmount): removes the
 * layer from the registry only — see the module comment for why it
 * never pops history itself.
 */
export function pushBackLayer(close: () => void): () => void {
  const layer: BackLayer = { id: nextId++, close };
  layers.push(layer);
  try {
    window.history.pushState({ rrBackLayer: layer.id }, '');
  } catch {
    // History unavailable (rare embedded contexts): the layer still
    // registers, Back simply falls back to leaving the editor.
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const idx = layers.findIndex((l) => l.id === layer.id);
    if (idx >= 0) layers.splice(idx, 1);
  };
}

/**
 * EditorShell's popstate handler. Closes (top first) every layer
 * whose history entry the browser just popped past — i.e. every
 * layer above the entry it landed on, or ALL layers when it landed
 * on an entry that carries no layer id. Returns true when at least
 * one layer was consumed.
 */
export function handleBackPop(): boolean {
  const landedId = currentHistoryLayerId();
  let consumed = false;
  while (layers.length > 0) {
    const top = layers[layers.length - 1];
    if (landedId !== null && top.id <= landedId) break;
    layers.pop();
    consumed = true;
    try {
      top.close();
    } catch {
      // A closer that throws must not strand the remaining layers.
    }
  }
  return consumed;
}

/** Live layer count — diagnostics/tests. */
export function backLayerCount(): number {
  return layers.length;
}

/** Test-only reset (the registry is module state). */
export function __resetBackLayersForTests(): void {
  layers.length = 0;
  nextId = 1;
}

/**
 * React hook form: while `active` is true, a Back press runs
 * `onClose` (always the latest render's callback). Registration is
 * an effect, so mounting a modal registers it and unmounting
 * unregisters it; toggling `active` off unregisters.
 */
export function useBackLayer(active: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!active) return;
    return pushBackLayer(() => closeRef.current());
  }, [active]);
}
