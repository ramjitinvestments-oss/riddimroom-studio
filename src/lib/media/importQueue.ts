/**
 * RiddimRoom Studio — WS-S1 concurrent import queue.
 *
 * MediaImportPanel used to start every picked file's upload the moment it
 * was picked, one `uploadMediaFile` call per file with no bound — a
 * 10-file pick meant 10 simultaneous resumable uploads fighting for the
 * same uplink (and 10 Firebase tasks), each crawling. This queue bounds
 * the fan-out: at most MAX_CONCURRENT_UPLOADS tasks run at once, the rest
 * wait their turn.
 *
 * Semantics the panel relies on:
 *  - Each enqueued task's promise settles with ITS OWN result — one file's
 *    failure rejects only that file's promise, never the queue and never
 *    its neighbours (per-file error/retry stays exactly as it was).
 *  - Tasks start in enqueue order as slots free up.
 *  - A task is just `() => Promise<T>` — the panel wraps the existing
 *    `uploadMediaFile` call, so resumable uploads and per-file progress
 *    callbacks behave exactly as before; progress simply starts when the
 *    task's slot opens instead of when the file was picked.
 */

export const MAX_CONCURRENT_UPLOADS = 3;

export interface ImportQueue {
  /** Runs `task` once a slot is free; resolves/rejects with the task's own outcome. */
  enqueue<T>(task: () => Promise<T>): Promise<T>;
  /** Tasks currently running. */
  readonly activeCount: number;
  /** Tasks waiting for a slot. */
  readonly pendingCount: number;
}

export function createImportQueue(concurrency: number = MAX_CONCURRENT_UPLOADS): ImportQueue {
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  let active = 0;
  const waiting: Array<() => void> = [];

  const pump = () => {
    while (active < limit && waiting.length > 0) {
      const start = waiting.shift()!;
      active += 1;
      start();
    }
  };

  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        waiting.push(() => {
          let result: Promise<T>;
          try {
            result = task();
          } catch (err) {
            active -= 1;
            reject(err);
            pump();
            return;
          }
          result.then(
            (value) => {
              active -= 1;
              resolve(value);
              pump();
            },
            (err) => {
              active -= 1;
              reject(err);
              pump();
            },
          );
        });
        pump();
      });
    },
    get activeCount() {
      return active;
    },
    get pendingCount() {
      return waiting.length;
    },
  };
}
