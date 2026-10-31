import { describe, it, expect, vi } from 'vitest';
import { recordFailure, isFailureKind } from './failureCounts';
import {
  failureDayKey,
  buildFailureIncrement,
  summarizeFailureCounts,
  recordFailureCount,
  fetchFailureCounts,
} from '../../api/_lib';

// The Firestore REST fake pattern from adminAccess.test.ts: the API
// helpers reach Firestore only through global fetch, so stubbing fetch
// runs the real code paths against an in-memory store.
type Plain = Record<string, unknown>;
const store = new Map<string, Plain>();
let failWrites = false;

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
  failWrites = false;
  // The caller is an admin for the read tests.
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
      // Collection list for failureCounts.
      const docs = [...store.entries()]
        .filter(([k]) => k.startsWith('failureCounts/'))
        .map(([k, data]) => ({
          name: `projects/x/databases/(default)/documents/${k}`,
          fields: Object.fromEntries(Object.entries(data).map(([kk, v]) => [kk, encVal(v)])),
        }));
      return { ok: true, status: 200, json: async () => ({ documents: docs }), text: async () => '' };
    }
    if (method === 'PATCH') {
      if (failWrites) return { ok: false, status: 403, json: async () => ({}), text: async () => 'PERMISSION_DENIED' };
      const body = JSON.parse(init?.body || '{}') as { fields: Plain };
      const fields = Object.fromEntries(Object.entries(body.fields || {}).map(([k, v]) => [k, decVal(v)]));
      store.set(path, { ...(store.get(path) || {}), ...fields });
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }
    return { ok: false, status: 405, json: async () => ({}), text: async () => '' };
  });
}

describe('R40 P-28 — client recorder', () => {
  it('posts only the kind, with the caller token, and swallows every failure', async () => {
    const fetcher = vi.fn(async () => ({ ok: true }));
    recordFailure('export', 'tok-1', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe('/api/failure-count');
    expect(JSON.parse(init.body)).toEqual({ kind: 'export' });
    expect(init.headers.Authorization).toBe('Bearer tok-1');

    const broken = vi.fn(async () => { throw new Error('offline'); });
    expect(() => recordFailure('save', 'tok-1', broken)).not.toThrow();
    recordFailure('export', null, fetcher); // no token: no call at all
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('only the three kinds are valid', () => {
    expect(isFailureKind('export')).toBe(true);
    expect(isFailureKind('save')).toBe(true);
    expect(isFailureKind('transcribe')).toBe(true);
    expect(isFailureKind('crash')).toBe(false);
    expect(isFailureKind(undefined)).toBe(false);
  });
});

describe('R40 P-28 — server counting logic (api/_lib)', () => {
  it('day keys are UTC calendar days', () => {
    expect(failureDayKey(new Date('2026-10-30T23:30:00Z'))).toBe('2026-10-30');
    expect(failureDayKey(new Date('2026-11-01T00:15:00Z'))).toBe('2026-11-01');
  });

  it('an increment bumps exactly one kind and keeps the others', () => {
    expect(buildFailureIncrement({}, 'export')).toEqual({ export: 1, save: 0, transcribe: 0 });
    expect(buildFailureIncrement({ export: 2, save: 1 }, 'save')).toEqual({ export: 2, save: 2, transcribe: 0 });
    expect(buildFailureIncrement({ export: 'junk' }, 'transcribe')).toEqual({ export: 0, save: 0, transcribe: 1 });
  });

  it('the summary totals today and the last 7 days, newest day first', () => {
    const now = new Date('2026-10-30T12:00:00Z');
    const summary = summarizeFailureCounts(
      [
        { day: '2026-10-30', export: 2, save: 1, transcribe: 0 },
        { day: '2026-10-28', export: 1, save: 0, transcribe: 3 },
        { day: '2026-10-20', export: 9, save: 9, transcribe: 9 }, // outside the 7-day window
      ],
      now,
    );
    expect(summary.today).toEqual({ day: '2026-10-30', export: 2, save: 1, transcribe: 0, total: 3 });
    expect(summary.last7Days).toEqual({ export: 3, save: 1, transcribe: 3, total: 7 });
    expect(summary.days.map((d) => d.day)).toEqual(['2026-10-30', '2026-10-28']);
  });

  it('record + admin read run end to end against the store', async () => {
    installFetchFake();
    await recordFailureCount('export', 'tok-1');
    await recordFailureCount('export', 'tok-1');
    await recordFailureCount('save', 'tok-1');
    const summary = await fetchFailureCounts('admin-1', 'tok-admin');
    expect(summary.today.export).toBe(2);
    expect(summary.today.save).toBe(1);
    expect(summary.today.total).toBe(3);
    vi.unstubAllGlobals();
  });

  it('a non-admin read is refused before anything is listed', async () => {
    installFetchFake();
    await expect(fetchFailureCounts('uid-not-admin', 'tok-x')).rejects.toMatchObject({ code: 'NOT_ADMIN' });
    vi.unstubAllGlobals();
  });
});
