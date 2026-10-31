import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  loadFirebase,
  isFirebaseLoadStarted,
  scheduleFirebaseLoad,
  setFirebaseImporterForTests,
  type FirebaseModule,
} from './firebaseLoader';

const fakeModule = { fake: true } as unknown as FirebaseModule;

afterEach(() => {
  setFirebaseImporterForTests(null);
});

describe('R40 P-10 — lazy Firebase loader', () => {
  it('loads once: concurrent calls share one promise and one import', async () => {
    const importer = vi.fn(async () => fakeModule);
    setFirebaseImporterForTests(importer);
    const a = loadFirebase();
    const b = loadFirebase();
    expect(a).toBe(b);
    await expect(a).resolves.toBe(fakeModule);
    await loadFirebase();
    expect(importer).toHaveBeenCalledTimes(1);
    expect(isFirebaseLoadStarted()).toBe(true);
  });

  it('a failed load is not cached — the next call retries', async () => {
    const importer = vi
      .fn<() => Promise<FirebaseModule>>()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(fakeModule);
    setFirebaseImporterForTests(importer);
    await expect(loadFirebase()).rejects.toThrow('network');
    await expect(loadFirebase()).resolves.toBe(fakeModule);
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it('the interaction path triggers the same shared load', async () => {
    const importer = vi.fn(async () => fakeModule);
    setFirebaseImporterForTests(importer);
    // A sign-in tap and the idle preload racing: still one import.
    scheduleFirebaseLoad(() => void loadFirebase(), {
      setTimeout: (cb) => cb(),
    });
    await loadFirebase();
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('schedules on the idle callback when one exists, with a timeout', () => {
    const load = vi.fn();
    const requestIdle = vi.fn((cb: () => void, _opts?: { timeout: number }) => cb());
    scheduleFirebaseLoad(load, { requestIdle, setTimeout: vi.fn() });
    expect(requestIdle).toHaveBeenCalledTimes(1);
    expect(requestIdle.mock.calls[0][1]).toEqual({ timeout: 2000 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('falls back to a timer when there is no idle callback', () => {
    const load = vi.fn();
    const setTimeoutFake = vi.fn((cb: () => void, _ms: number) => cb());
    scheduleFirebaseLoad(load, { setTimeout: setTimeoutFake });
    expect(setTimeoutFake).toHaveBeenCalledTimes(1);
    expect(setTimeoutFake.mock.calls[0][1]).toBe(1200);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
