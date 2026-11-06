import { describe, it, expect, vi } from 'vitest';
import {
  takeTierBucket,
  fpsBucket,
  dropBucketForFraction,
  dropBucketForEstimate,
  takeDurationBucket,
  exportDurationBucket,
  sessionTotalBucket,
  sessionOver200Bucket,
  buildTakeBuckets,
  takeBucketsFromReceipt,
  recordHealthEvent,
  recordTakeHealth,
  recordExportSuccess,
  recordSaveSuccess,
  recordDoorOpen,
  startSessionLongtaskCollector,
  healthStorageKey,
} from './healthEvents';
import {
  validateHealthEvent,
  buildHealthIncrement,
  healthStorageKeysFor,
  recordHealthEvent as recordHealthEventServer,
  recordFailureCount,
  fetchFailureCounts,
  summarizeHealthCounts,
} from '../../api/_lib';

// Firestore REST fake pattern from failureCounts.test.ts.
type Plain = Record<string, unknown>;
const store = new Map<string, Plain>();
function encVal(v: unknown): unknown {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return { integerValue: String(v) };
  if (typeof v === 'boolean') return { booleanValue: v };
  return { stringValue: String(v) };
}
function decVal(v: any): unknown {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('booleanValue' in v) return v.booleanValue;
  return null;
}
function installFetchFake() {
  store.clear();
  store.set('admins/admin-1', { uid: 'admin-1' });
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    const clean = String(url).split('?')[0];
    const marker = '/documents/';
    const path = clean.slice(clean.indexOf(marker) + marker.length);
    const method = init?.method || 'GET';
    if (method === 'GET' && path.includes('/')) {
      const data = store.get(path);
      if (!data) return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
      return {
        ok: true, status: 200,
        json: async () => ({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, encVal(v)])) }),
        text: async () => '',
      };
    }
    if (method === 'GET') {
      const docs = [...store.entries()]
        .filter(([k]) => k.startsWith('failureCounts/'))
        .map(([k, data]) => ({
          name: `projects/x/databases/(default)/documents/${k}`,
          fields: Object.fromEntries(Object.entries(data).map(([kk, v]) => [kk, encVal(v)])),
        }));
      return { ok: true, status: 200, json: async () => ({ documents: docs }), text: async () => '' };
    }
    if (method === 'PATCH') {
      const body = JSON.parse(init?.body || '{}') as { fields: Plain };
      const fields = Object.fromEntries(Object.entries(body.fields || {}).map(([k, v]) => [k, decVal(v)]));
      store.set(path, { ...(store.get(path) || {}), ...fields });
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    return { ok: false, status: 405, json: async () => ({}), text: async () => '' };
  });
}

describe('R41 WS-D — pure bucket derivation', () => {
  it('tier buckets reuse the shared short-side classes', () => {
    expect(takeTierBucket(2160)).toBe('2160');
    expect(takeTierBucket(1440)).toBe('1440');
    expect(takeTierBucket(1080)).toBe('1080');
    expect(takeTierBucket(720)).toBe('720');
    expect(takeTierBucket(480)).toBe('low');
    expect(takeTierBucket(0)).toBe('unknown');
    expect(takeTierBucket(NaN)).toBe('unknown');
  });

  it('fps buckets: near 60 / near 30 / other / unknown', () => {
    expect(fpsBucket(60)).toBe('60');
    expect(fpsBucket(59)).toBe('60');
    expect(fpsBucket(30)).toBe('30');
    expect(fpsBucket(24)).toBe('other');
    expect(fpsBucket(0)).toBe('unknown');
    expect(fpsBucket(null)).toBe('unknown');
    expect(fpsBucket(undefined)).toBe('unknown');
  });

  it('drop buckets align with the 2% warning fraction, then 10%', () => {
    expect(dropBucketForFraction(0)).toBe('none');
    expect(dropBucketForFraction(0.02)).toBe('none');
    expect(dropBucketForFraction(0.021)).toBe('low');
    expect(dropBucketForFraction(0.1)).toBe('low');
    expect(dropBucketForFraction(0.11)).toBe('high');
    expect(dropBucketForFraction(null)).toBe('unknown');
    expect(dropBucketForEstimate(null)).toBe('unknown');
    expect(dropBucketForEstimate({ presentedFrames: 90, expectedFrames: 100, droppedFramesEstimate: 10 })).toBe('low');
    expect(dropBucketForEstimate({ presentedFrames: 0, expectedFrames: 0, droppedFramesEstimate: 0 })).toBe('unknown');
  });

  it('duration buckets split at their stated edges', () => {
    expect(takeDurationBucket(14.9)).toBe('under15');
    expect(takeDurationBucket(15)).toBe('15to60');
    expect(takeDurationBucket(60)).toBe('15to60');
    expect(takeDurationBucket(61)).toBe('over60');
    expect(exportDurationBucket(9.9)).toBe('under10');
    expect(exportDurationBucket(10)).toBe('10to60');
    expect(exportDurationBucket(60)).toBe('10to60');
    expect(exportDurationBucket(61)).toBe('over60');
  });

  it('session buckets: totals 0 / 1–5 / 6+, over-200ms 0 / 1+', () => {
    expect(sessionTotalBucket(0)).toBe('0');
    expect(sessionTotalBucket(1)).toBe('1to5');
    expect(sessionTotalBucket(5)).toBe('1to5');
    expect(sessionTotalBucket(6)).toBe('6plus');
    expect(sessionOver200Bucket(0)).toBe('0');
    expect(sessionOver200Bucket(1)).toBe('1plus');
  });

  it('builds a full take bucket set, and from a receipt', () => {
    expect(
      buildTakeBuckets({
        shortSide: 1080,
        fps: 30,
        frameDropEstimate: { presentedFrames: 100, expectedFrames: 100, droppedFramesEstimate: 0 },
        durationSeconds: 20,
      }),
    ).toEqual({ tier: '1080', fps: '30', drops: 'none', duration: '15to60' });
    expect(
      takeBucketsFromReceipt({
        actualWidth: 1920,
        actualHeight: 1080,
        actualFps: 60,
        durationSeconds: 5,
        droppedFramesEstimate: undefined,
        expectedFramesEstimate: undefined,
      }),
    ).toEqual({ tier: '1080', fps: '60', drops: 'unknown', duration: 'under15' });
  });

  it('storage keys are namespaced per type', () => {
    expect(healthStorageKey('take', 'tier', '1080')).toBe('health_take_tier_1080');
    expect(healthStorageKey('door', 'door', 'promo')).toBe('health_door_promo');
    expect(healthStorageKey('save', '', '')).toBe('health_save_success');
  });
});

describe('R41 WS-D — client recorders', () => {
  it('post only the health shape, with the caller token, and swallow failures', () => {
    const fetcher = vi.fn(async () => ({ ok: true }));
    recordExportSuccess(30, 'tok-1', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe('/api/failure-count');
    expect(JSON.parse(init.body)).toEqual({ health: { type: 'export', buckets: { duration: '10to60' } } });
    expect(init.headers.Authorization).toBe(['Bearer','tok-1'].join(' '));

    recordSaveSuccess('tok-1', fetcher);
    expect(JSON.parse((fetcher.mock.calls[1] as any)[1].body)).toEqual({ health: { type: 'save', buckets: {} } });
    recordDoorOpen('camera', 'tok-1', fetcher);
    expect(JSON.parse((fetcher.mock.calls[2] as any)[1].body)).toEqual({
      health: { type: 'door', buckets: { door: 'camera' } },
    });
    recordTakeHealth({ shortSide: 720, fps: 60, frameDropEstimate: null, durationSeconds: 3 }, 'tok-1', fetcher);
    expect(JSON.parse((fetcher.mock.calls[3] as any)[1].body)).toEqual({
      health: { type: 'take', buckets: { tier: '720', fps: '60', drops: 'unknown', duration: 'under15' } },
    });

    const broken = vi.fn(async () => { throw new Error('offline'); });
    expect(() => recordHealthEvent({ type: 'save', buckets: {} }, 'tok-1', broken)).not.toThrow();
    recordExportSuccess(5, null, fetcher); // no token: no call at all
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

describe('R41 WS-D — session longtask collector', () => {
  function fakeObserverEnv() {
    const listeners = new Map<string, Array<() => void>>();
    const target = {
      addEventListener: (t: string, fn: () => void) => {
        listeners.set(t, [...(listeners.get(t) ?? []), fn]);
      },
      removeEventListener: (t: string, fn: () => void) => {
        listeners.set(t, (listeners.get(t) ?? []).filter((f) => f !== fn));
      },
      fire: (t: string) => (listeners.get(t) ?? []).forEach((f) => f()),
    };
    let callback: ((list: { getEntries: () => Array<{ duration: number }> }) => void) | null = null;
    class FakeObserver {
      static supportedEntryTypes = ['longtask'];
      constructor(cb: typeof callback) { callback = cb; }
      observe() {}
      disconnect() {}
      emit(durations: number[]) { callback?.({ getEntries: () => durations.map((duration) => ({ duration })) }); }
    }
    return { target, FakeObserver: FakeObserver as any };
  }

  it('counts, reports ONE aggregate event on pagehide, then stops', () => {
    const { target, FakeObserver } = fakeObserverEnv();
    const fetcher = vi.fn(async () => ({ ok: true }));
    const collector = startSessionLongtaskCollector('tok-1', {
      fetcher,
      observerCtor: FakeObserver,
      target: target as any,
    });
    expect(collector).not.toBeNull();
    target.fire('pagehide');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetcher.mock.calls[0] as any)[1].body)).toEqual({
      health: { type: 'session', buckets: { total: '0', over200: '0' } },
    });
    target.fire('pagehide');
    collector!.flush();
    expect(fetcher).toHaveBeenCalledTimes(1); // at most one per session
  });

  it('buckets counted entries over 200ms', () => {
    const { target, FakeObserver } = fakeObserverEnv();
    const fetcher = vi.fn(async () => ({ ok: true }));
    let captured: ((list: { getEntries: () => Array<{ duration: number }> }) => void) | null = null;
    class CapturingObserver extends (FakeObserver as any) {
      constructor(cb: any) { super(cb); captured = cb; }
    }
    const collector = startSessionLongtaskCollector('tok-1', {
      fetcher,
      observerCtor: CapturingObserver as any,
      target: target as any,
    });
    (captured as null | ((list: { getEntries: () => Array<{ duration: number }> }) => void))?.({ getEntries: () => [{ duration: 80 }, { duration: 250 }, { duration: 90 }] });
    expect(collector!.snapshot()).toEqual({ total: 3, over200: 1 });
    collector!.flush();
    expect(JSON.parse((fetcher.mock.calls[0] as any)[1].body)).toEqual({
      health: { type: 'session', buckets: { total: '1to5', over200: '1plus' } },
    });
  });

  it('is a no-op without a token or without longtask support', () => {
    const { target } = fakeObserverEnv();
    expect(startSessionLongtaskCollector(null, { target: target as any })).toBeNull();
    class NoLongtask {
      static supportedEntryTypes = ['paint'];
      observe() {}
      disconnect() {}
    }
    expect(
      startSessionLongtaskCollector('tok-1', { observerCtor: NoLongtask as any, target: target as any }),
    ).toBeNull();
  });
});

describe('R41 WS-D — server validation + counting (api/_lib)', () => {
  it('accepts exactly the allowlisted shapes', () => {
    expect(validateHealthEvent({ type: 'take', buckets: { tier: '1080', fps: '60', drops: 'none', duration: 'under15' } })).toEqual({
      type: 'take',
      buckets: { tier: '1080', fps: '60', drops: 'none', duration: 'under15' },
    });
    expect(validateHealthEvent({ type: 'save', buckets: {} })).toEqual({ type: 'save', buckets: {} });
    expect(validateHealthEvent({ type: 'door', buckets: { door: 'poster' } })).toEqual({
      type: 'door',
      buckets: { door: 'poster' },
    });
  });

  it('rejects unknown types, bucket values, missing and extra buckets', () => {
    expect(validateHealthEvent({ type: 'crash', buckets: {} })).toBeNull();
    expect(validateHealthEvent({ type: 'take', buckets: { tier: '4000', fps: '60', drops: 'none', duration: 'under15' } })).toBeNull();
    expect(validateHealthEvent({ type: 'take', buckets: { tier: '1080', fps: '60', drops: 'none' } })).toBeNull();
    expect(
      validateHealthEvent({ type: 'take', buckets: { tier: '1080', fps: '60', drops: 'none', duration: 'under15', uid: 'x' } }),
    ).toBeNull();
    expect(validateHealthEvent({ type: 'door', buckets: { door: 'admin' } })).toBeNull();
    expect(validateHealthEvent({ type: 'save', buckets: { note: 'hi' } })).toBeNull();
    expect(validateHealthEvent(null)).toBeNull();
    expect(validateHealthEvent('take')).toBeNull();
  });

  it('an increment bumps exactly the event keys and nothing else', () => {
    const take = validateHealthEvent({ type: 'take', buckets: { tier: '1080', fps: '30', drops: 'low', duration: '15to60' } })!;
    expect(healthStorageKeysFor(take)).toEqual([
      'health_take_tier_1080',
      'health_take_fps_30',
      'health_take_drops_low',
      'health_take_duration_15to60',
    ]);
    expect(buildHealthIncrement({ health_take_tier_1080: 2, export: 5 }, take)).toEqual({
      health_take_tier_1080: 3,
      health_take_fps_30: 1,
      health_take_drops_low: 1,
      health_take_duration_15to60: 1,
    });
    const save = validateHealthEvent({ type: 'save', buckets: {} })!;
    expect(buildHealthIncrement({}, save)).toEqual({ health_save_success: 1 });
  });

  it('records health + failures into the SAME day doc and summarizes 14 days', async () => {
    installFetchFake();
    const now = new Date();
    await recordHealthEventServer({ type: 'door', buckets: { door: 'promo' } }, 'tok-1', now);
    await recordHealthEventServer(
      { type: 'take', buckets: { tier: '720', fps: '30', drops: 'high', duration: 'under15' } },
      'tok-1',
      now,
    );
    await recordFailureCount('export', 'tok-1', now);
    const summary = await fetchFailureCounts('admin-1', 'tok-admin');
    expect(summary.today.export).toBe(1); // the P-28 path is untouched
    expect(summary.health.today.counts.health_door_promo).toBe(1);
    expect(summary.health.today.counts.health_take_drops_high).toBe(1);
    expect(summary.health.last14Days.health_door_promo).toBe(1);
    await expect(recordHealthEventServer({ type: 'door', buckets: { door: 'nope' } } as any, 'tok-1')).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  it('the 14-day summary excludes older days and zero-fills known keys', () => {
    const now = new Date('2026-11-06T12:00:00Z');
    const summary = summarizeHealthCounts(
      [
        { day: '2026-11-06', health_door_camera: 2 },
        { day: '2026-10-25', health_door_camera: 3 }, // inside 14 days
        { day: '2026-10-20', health_door_camera: 9 }, // outside
      ],
      now,
    );
    expect(summary.last14Days.health_door_camera).toBe(5);
    expect(summary.today.counts.health_door_camera).toBe(2);
    expect(summary.today.counts.health_save_success).toBe(0);
    expect(summary.days.map((d) => d.day)).toEqual(['2026-11-06', '2026-10-25']);
  });
});
