import { describe, it, expect, beforeEach } from 'vitest';
import {
  ensureTemplatesPanelProject,
  getOrCreatePreviewScheduler,
  getPreviewCache,
  getPreviewJobs,
  getTemplatesPanelScrollLeft,
  getTemplatesPanelState,
  initialTemplatesPanelState,
  resetTemplatesPanelStore,
  setTemplatesPanelScrollLeft,
  subscribeTemplatesPanelState,
  updateTemplatesPanelState,
} from './panelStore';

describe('R40 P-06 — shared Templates panel store', () => {
  beforeEach(() => {
    resetTemplatesPanelStore();
  });

  it('starts as a fresh panel bound to no project', () => {
    expect(getTemplatesPanelState()).toEqual(initialTemplatesPanelState(null));
  });

  it('state written by one mount is read back by the next (the step switch)', () => {
    ensureTemplatesPanelProject('project-a');
    // Mount 1 (Step 1): apply a template, start an Adjust step, focus a card.
    updateTemplatesPanelState({
      appliedId: 'viral-hook-story',
      pendingAdjust: [{ itemId: 'item-1', fileName: 'clip.mp4' }],
      focusedId: 'music-video',
      chip: 'full',
    });
    // Mount 1 unmounts; mount 2 (Step 2) binds to the same project…
    ensureTemplatesPanelProject('project-a');
    // …and sees everything mount 1 left behind.
    const state = getTemplatesPanelState();
    expect(state.appliedId).toBe('viral-hook-story');
    expect(state.pendingAdjust).toHaveLength(1);
    expect(state.focusedId).toBe('music-video');
    expect(state.chip).toBe('full');
  });

  it('an unfinished Reframe step and an open frame prompt survive the round trip', () => {
    ensureTemplatesPanelProject('project-a');
    updateTemplatesPanelState({
      pendingFramed: [{ itemId: 'item-2', fileName: 'photo.jpg' }],
      reframeTargetId: 'item-2',
      framePromptId: 'music-video',
    });
    ensureTemplatesPanelProject('project-a');
    const state = getTemplatesPanelState();
    expect(state.pendingFramed).toHaveLength(1);
    expect(state.reframeTargetId).toBe('item-2');
    expect(state.framePromptId).toBe('music-video');
  });

  it('opening a DIFFERENT project resets the panel — nothing leaks across projects', () => {
    ensureTemplatesPanelProject('project-a');
    updateTemplatesPanelState({ appliedId: 'viral-hook-story', focusedId: 'music-video' });
    setTemplatesPanelScrollLeft(240);
    getPreviewCache().set('key-a', [] as unknown as HTMLCanvasElement[]);
    ensureTemplatesPanelProject('project-b');
    const state = getTemplatesPanelState();
    expect(state.projectId).toBe('project-b');
    expect(state.appliedId).toBeNull();
    expect(state.focusedId).toBeNull();
    expect(getTemplatesPanelScrollLeft()).toBe(0);
    expect(getPreviewCache().has('key-a')).toBe(false);
    expect(getPreviewJobs().size).toBe(0);
  });

  it('the preview cache + scheduler are shared: a preview renders once across mounts', async () => {
    ensureTemplatesPanelProject('project-a');
    let renders = 0;
    const render = async (key: string) => {
      renders += 1;
      return [`frame:${key}`] as unknown as HTMLCanvasElement[];
    };
    // Mount 1 renders the focused card's preview.
    const first = getOrCreatePreviewScheduler(render);
    await first.request('sig-1');
    expect(renders).toBe(1);
    // Mount 2 asks for the same scheduler and the same key: cache hit.
    const second = getOrCreatePreviewScheduler(render);
    expect(second).toBe(first);
    await expect(second.request('sig-1')).resolves.toEqual(['frame:sig-1']);
    expect(renders).toBe(1);
    expect(getPreviewCache().has('sig-1')).toBe(true);
  });

  it('the strip scroll position is kept as a plain value', () => {
    setTemplatesPanelScrollLeft(132);
    expect(getTemplatesPanelScrollLeft()).toBe(132);
    setTemplatesPanelScrollLeft(-5);
    expect(getTemplatesPanelScrollLeft()).toBe(0);
  });

  it('subscribers are notified on update and on project switch', () => {
    let calls = 0;
    const unsubscribe = subscribeTemplatesPanelState(() => {
      calls += 1;
    });
    ensureTemplatesPanelProject('project-a');
    updateTemplatesPanelState({ notice: 'Done' });
    expect(calls).toBe(2);
    unsubscribe();
    updateTemplatesPanelState({ notice: null });
    expect(calls).toBe(2);
  });
});
