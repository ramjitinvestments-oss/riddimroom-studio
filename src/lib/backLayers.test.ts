/**
 * R42 Phase B — history-aware Back: the layer stack's semantics,
 * driven against a stubbed window.history (the module reads only
 * history.state and calls only history.pushState — it never calls
 * history.back() itself; the browser fires the pops, EditorShell's
 * listener forwards them to handleBackPop).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __resetBackLayersForTests, backLayerCount, handleBackPop, pushBackLayer } from './backLayers';

class FakeHistory {
  state: unknown = null;
  pushState(state: unknown): void {
    this.state = state;
  }
}

let fakeHistory: FakeHistory;
const realWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  __resetBackLayersForTests();
  fakeHistory = new FakeHistory();
  (globalThis as { window?: unknown }).window = { history: fakeHistory };
});

afterEach(() => {
  __resetBackLayersForTests();
  (globalThis as { window?: unknown }).window = realWindow;
});

/** Simulates the browser landing on an entry after a Back press. */
function landOn(state: unknown): boolean {
  fakeHistory.state = state;
  return handleBackPop();
}

describe('R42 back layers — pop consumption', () => {
  it('pushing a layer records a history entry carrying its id', () => {
    pushBackLayer(() => {});
    expect(fakeHistory.state).toEqual({ rrBackLayer: 1 });
    expect(backLayerCount()).toBe(1);
  });

  it('a Back press closes only the layers above the entry it lands on', () => {
    const closed: string[] = [];
    pushBackLayer(() => closed.push('step'));
    pushBackLayer(() => closed.push('sheet'));
    // Browser pops the sheet's entry, landing on the step's entry.
    expect(landOn({ rrBackLayer: 1 })).toBe(true);
    expect(closed).toEqual(['sheet']);
    expect(backLayerCount()).toBe(1);
    // Next Back lands on a non-layer entry: the remaining layer closes.
    expect(landOn(null)).toBe(true);
    expect(closed).toEqual(['sheet', 'step']);
    expect(backLayerCount()).toBe(0);
  });

  it('with no layers left, Back is NOT consumed (leaving works as before)', () => {
    expect(landOn(null)).toBe(false);
  });

  it('closers run top-first (LIFO) when several entries are popped past at once', () => {
    const closed: string[] = [];
    pushBackLayer(() => closed.push('a'));
    pushBackLayer(() => closed.push('b'));
    pushBackLayer(() => closed.push('c'));
    expect(landOn(null)).toBe(true);
    expect(closed).toEqual(['c', 'b', 'a']);
  });

  it('a throwing closer does not strand the layers below it', () => {
    const closed: string[] = [];
    pushBackLayer(() => closed.push('below'));
    pushBackLayer(() => {
      throw new Error('boom');
    });
    expect(landOn(null)).toBe(true);
    expect(closed).toEqual(['below']);
    expect(backLayerCount()).toBe(0);
  });
});

describe('R42 back layers — programmatic close (unregister)', () => {
  it('unregister removes the layer without touching history; its stale entry is inert', () => {
    const close = vi.fn();
    const unregister = pushBackLayer(close);
    const entryState = fakeHistory.state;
    unregister();
    expect(backLayerCount()).toBe(0);
    // The module never popped history itself…
    expect(fakeHistory.state).toEqual(entryState);
    // …and a later Back press popping past the stale entry consumes nothing.
    expect(landOn(null)).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it('unregister is idempotent', () => {
    const unregister = pushBackLayer(() => {});
    unregister();
    unregister();
    expect(backLayerCount()).toBe(0);
  });
});
