import { describe, it, expect } from 'vitest';
import { createImportQueue, MAX_CONCURRENT_UPLOADS } from './importQueue';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets queued microtasks / queue pumps run to quiescence. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('createImportQueue', () => {
  it('defaults to MAX_CONCURRENT_UPLOADS = 3', () => {
    expect(MAX_CONCURRENT_UPLOADS).toBe(3);
  });

  it('never runs more than 3 tasks at once, and every task completes', async () => {
    const queue = createImportQueue();
    let inFlight = 0;
    let maxInFlight = 0;
    const gates: Array<Deferred<number>> = [];
    const results: Array<Promise<number>> = [];

    for (let i = 0; i < 8; i++) {
      const gate = deferred<number>();
      gates.push(gate);
      results.push(
        queue.enqueue(async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          const value = await gate.promise;
          inFlight -= 1;
          return value;
        }),
      );
    }

    await flush();
    expect(inFlight).toBe(3);
    expect(queue.activeCount).toBe(3);
    expect(queue.pendingCount).toBe(5);

    // Release gates one at a time — each completion admits exactly one more.
    for (let i = 0; i < 8; i++) {
      gates[i].resolve(i * 10);
      await flush();
      expect(inFlight).toBeLessThanOrEqual(3);
    }

    await expect(Promise.all(results)).resolves.toEqual([0, 10, 20, 30, 40, 50, 60, 70]);
    expect(maxInFlight).toBe(3);
    expect(queue.activeCount).toBe(0);
    expect(queue.pendingCount).toBe(0);
  });

  it('starts tasks in enqueue order as slots free up', async () => {
    const queue = createImportQueue(2);
    const started: number[] = [];
    const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];
    const runs = gates.map((gate, i) =>
      queue.enqueue(async () => {
        started.push(i);
        await gate.promise;
        return i;
      }),
    );
    await flush();
    expect(started).toEqual([0, 1]);
    gates[0].resolve();
    await flush();
    expect(started).toEqual([0, 1, 2]);
    gates[1].resolve();
    gates[2].resolve();
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[3].resolve();
    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2, 3]);
  });

  it("one task's failure rejects only its own promise — the queue keeps going", async () => {
    const queue = createImportQueue(2);
    const bad = queue.enqueue(async () => {
      throw new Error('upload failed');
    });
    const good1 = queue.enqueue(async () => 'a');
    const good2 = queue.enqueue(async () => 'b');
    const good3 = queue.enqueue(async () => 'c');
    await expect(bad).rejects.toThrow('upload failed');
    await expect(good1).resolves.toBe('a');
    await expect(good2).resolves.toBe('b');
    await expect(good3).resolves.toBe('c');
    expect(queue.activeCount).toBe(0);
    // The queue is still usable after a failure.
    await expect(queue.enqueue(async () => 'after')).resolves.toBe('after');
  });

  it('a synchronously-throwing task rejects its promise and frees its slot', async () => {
    const queue = createImportQueue(1);
    const bad = queue.enqueue(() => {
      throw new Error('sync boom');
    });
    const next = queue.enqueue(async () => 'next');
    await expect(bad).rejects.toThrow('sync boom');
    await expect(next).resolves.toBe('next');
  });

  it('per-file progress callbacks fire independently per task', async () => {
    const queue = createImportQueue(2);
    const progressByFile = new Map<string, number[]>();
    const makeTask = (name: string, steps: number[]) => () => {
      const seen: number[] = [];
      progressByFile.set(name, seen);
      return (async () => {
        for (const step of steps) {
          seen.push(step);
          await flush();
        }
        return name;
      })();
    };
    const a = queue.enqueue(makeTask('a.mp4', [0.25, 0.5, 1]));
    const b = queue.enqueue(makeTask('b.mp4', [0.5, 1]));
    const c = queue.enqueue(makeTask('c.mp4', [1]));
    await expect(Promise.all([a, b, c])).resolves.toEqual(['a.mp4', 'b.mp4', 'c.mp4']);
    expect(progressByFile.get('a.mp4')).toEqual([0.25, 0.5, 1]);
    expect(progressByFile.get('b.mp4')).toEqual([0.5, 1]);
    expect(progressByFile.get('c.mp4')).toEqual([1]);
  });

  it('respects a custom concurrency of 1 (strictly serial)', async () => {
    const queue = createImportQueue(1);
    let inFlight = 0;
    let maxInFlight = 0;
    const runs = [0, 1, 2].map((i) =>
      queue.enqueue(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await flush();
        inFlight -= 1;
        return i;
      }),
    );
    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2]);
    expect(maxInFlight).toBe(1);
  });
});
