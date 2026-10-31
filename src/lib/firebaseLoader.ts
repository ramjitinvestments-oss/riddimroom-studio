/**
 * R40 P-10 — the lazy Firebase loader.
 *
 * The Firebase code (~730 KB) used to be statically imported by the
 * auth context, so it was part of the first download and the login
 * screen could not paint until it arrived. Now nothing on the login
 * route imports it statically: this loader pulls it in on demand —
 *
 *   1. immediately, the moment any sign-in control is used, and
 *   2. shortly after first paint, on an idle callback (with a plain
 *      timer fallback), so a returning user's saved session is
 *      restored without them having to tap anything.
 *
 * The loader is deliberately tiny and dependency-free: it knows how
 * to start ONE shared load and how to schedule one. Every caller
 * awaits the same promise, so concurrent taps and the idle preload
 * can never start the download twice.
 */

export type FirebaseModule = typeof import('./firebase');
export type FirebaseImporter = () => Promise<FirebaseModule>;

let sharedLoad: Promise<FirebaseModule> | null = null;
let importerOverride: FirebaseImporter | null = null;

/** Test seam: replace the real dynamic import with a fake importer. */
export function setFirebaseImporterForTests(importer: FirebaseImporter | null): void {
  importerOverride = importer;
  sharedLoad = null;
}

/**
 * Load the Firebase module, sharing one in-flight promise across all
 * callers. A failed load is NOT cached — the next call tries again.
 */
export function loadFirebase(): Promise<FirebaseModule> {
  if (!sharedLoad) {
    const importer = importerOverride ?? (() => import('./firebase'));
    sharedLoad = importer().catch((err) => {
      sharedLoad = null;
      throw err;
    });
  }
  return sharedLoad;
}

/** True once a load has been started (settled or not). */
export function isFirebaseLoadStarted(): boolean {
  return sharedLoad !== null;
}

export interface IdleScheduler {
  requestIdle?: (cb: () => void, opts?: { timeout: number }) => void;
  setTimeout: (cb: () => void, ms: number) => void;
}

const defaultScheduler: IdleScheduler = {
  requestIdle:
    typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function'
      ? (cb, opts) => void window.requestIdleCallback(cb, opts)
      : undefined,
  setTimeout: (cb, ms) => void setTimeout(cb, ms),
};

/**
 * Schedule `load` shortly after first paint: on the idle callback
 * when the browser offers one (with a 2s idle timeout so it still
 * happens on a busy page), otherwise a plain 1.2s timer. Returns
 * nothing — this is a preload, and its caller (the auth provider)
 * also loads on demand, so a scheduler that never fires costs
 * nothing but the wait.
 */
export function scheduleFirebaseLoad(load: () => void, scheduler: IdleScheduler = defaultScheduler): void {
  if (scheduler.requestIdle) {
    scheduler.requestIdle(load, { timeout: 2000 });
  } else {
    scheduler.setTimeout(load, 1200);
  }
}
