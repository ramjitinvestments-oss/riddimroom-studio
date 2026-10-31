import { describe, it, expect, vi } from 'vitest';
import {
  writeLocalDraft,
  readLocalDraft,
  clearLocalDraft,
  isDraftNewerThan,
  draftSupersededBySave,
  localDraftKey,
  saveRetryDelayMs,
  saveStatusText,
  SAVE_RETRY_DELAYS_MS,
  type DraftStorage,
} from './localDraft';
import type { Project } from '../../types/timeline';

function makeStorage(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function makeProject(updatedAt: number, id = 'proj-1'): Project {
  return {
    id, ownerUid: 'uid-1', name: 'Test', schemaVersion: 1,
    tracks: [], items: [], mediaAssets: {},
    canvasWidth: 1080, canvasHeight: 1920, frameRate: 30,
    createdAt: 100, updatedAt,
  };
}

describe('R40 P-13 — device-local draft', () => {
  it('writes and reads back a draft keyed by project id', () => {
    const storage = makeStorage();
    const project = makeProject(5000);
    expect(writeLocalDraft(project, storage, 6000)).toBe(true);
    expect(storage.map.has(localDraftKey('proj-1'))).toBe(true);
    const draft = readLocalDraft('proj-1', storage);
    expect(draft?.project.updatedAt).toBe(5000);
    expect(draft?.savedAt).toBe(6000);
  });

  it('a full or broken storage is silent — write reports false, never throws', () => {
    const full: DraftStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => undefined,
    };
    expect(writeLocalDraft(makeProject(1), full)).toBe(false);
    expect(readLocalDraft('proj-1', null)).toBeNull();
    expect(writeLocalDraft(makeProject(1), null)).toBe(false);
  });

  it('an unreadable or mismatched stored value reads as no draft', () => {
    const storage = makeStorage();
    storage.setItem(localDraftKey('proj-1'), '{not json');
    expect(readLocalDraft('proj-1', storage)).toBeNull();
    storage.setItem(localDraftKey('proj-1'), JSON.stringify({ project: makeProject(9, 'other'), savedAt: 1 }));
    expect(readLocalDraft('proj-1', storage)).toBeNull();
  });

  it('clear removes the copy', () => {
    const storage = makeStorage();
    writeLocalDraft(makeProject(5), storage);
    clearLocalDraft('proj-1', storage);
    expect(readLocalDraft('proj-1', storage)).toBeNull();
  });

  it('restore is offered only when the draft is strictly newer than the loaded copy', () => {
    const draft = { project: makeProject(2000), savedAt: 2100 };
    expect(isDraftNewerThan(draft, 1000)).toBe(true);
    expect(isDraftNewerThan(draft, 2000)).toBe(false); // equal: the cloud already holds it
    expect(isDraftNewerThan(draft, 3000)).toBe(false); // older: stale
    expect(isDraftNewerThan(null, 0)).toBe(false);
  });

  it('a confirmed save supersedes the draft only when newer-or-equal', () => {
    const draft = { project: makeProject(2000), savedAt: 2100 };
    expect(draftSupersededBySave(draft, 2000)).toBe(true);
    expect(draftSupersededBySave(draft, 2500)).toBe(true);
    expect(draftSupersededBySave(draft, 1500)).toBe(false); // an older save must not clear a newer draft
    expect(draftSupersededBySave(null, 9999)).toBe(false);
  });
});

describe('R40 P-13 — save retry schedule', () => {
  it('backs off 2s → 5s → 15s → 30s and then holds at the cap', () => {
    expect(SAVE_RETRY_DELAYS_MS).toEqual([2000, 5000, 15000, 30000]);
    expect(saveRetryDelayMs(0)).toBe(2000);
    expect(saveRetryDelayMs(1)).toBe(5000);
    expect(saveRetryDelayMs(2)).toBe(15000);
    expect(saveRetryDelayMs(3)).toBe(30000);
    expect(saveRetryDelayMs(9)).toBe(30000);
  });

  it('a failing save retries on the schedule and stops after the cap (fake timers)', () => {
    vi.useFakeTimers();
    try {
      // The ProjectContext loop's contract, driven exactly as the
      // context drives it: attempt, wait saveRetryDelayMs(attempt),
      // attempt again, give up after 6 retries.
      const attempt = vi.fn(() => false); // every attempt fails
      let retries = 0;
      const step = (): boolean => {
        if (attempt()) return true;
        if (retries >= 6) return false; // final failed state
        const delay = saveRetryDelayMs(retries);
        retries += 1;
        setTimeout(step, delay);
        return false;
      };
      step();
      expect(attempt).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1999);
      expect(attempt).toHaveBeenCalledTimes(1); // nothing before 2s
      vi.advanceTimersByTime(1);
      expect(attempt).toHaveBeenCalledTimes(2); // first retry at 2s
      vi.advanceTimersByTime(5000);
      expect(attempt).toHaveBeenCalledTimes(3); // then 5s
      vi.advanceTimersByTime(15000);
      expect(attempt).toHaveBeenCalledTimes(4); // then 15s
      vi.advanceTimersByTime(30000);
      expect(attempt).toHaveBeenCalledTimes(5); // then the 30s cap
      vi.advanceTimersByTime(30000);
      expect(attempt).toHaveBeenCalledTimes(6);
      vi.advanceTimersByTime(30000);
      expect(attempt).toHaveBeenCalledTimes(7); // 1 try + 6 retries
      vi.advanceTimersByTime(120000);
      expect(attempt).toHaveBeenCalledTimes(7); // given up — no loop forever
    } finally {
      vi.useRealTimers();
    }
  });

  it('the status line speaks plain words for every phase — never a raw error', () => {
    const fmt = (t: number) => `T${t}`;
    expect(saveStatusText('saving', null, fmt)).toBe('Saving…');
    expect(saveStatusText('retrying', null, fmt)).toContain('retrying');
    expect(saveStatusText('waiting-offline', null, fmt)).toContain('on this device');
    expect(saveStatusText('waiting-offline', null, fmt)).toContain('back online');
    expect(saveStatusText('failed', null, fmt)).toContain('on this device');
    expect(saveStatusText('saved', 42, fmt)).toBe('Saved · T42');
    for (const phase of ['saving', 'retrying', 'waiting-offline', 'failed', 'saved'] as const) {
      expect(saveStatusText(phase, 1, fmt)).not.toMatch(/error|failed to|exception/i);
    }
  });
});
