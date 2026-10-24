import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildAccessToggleWrites,
  applyAccessToggle,
  fetchAdminUsers,
  AccessToggleError,
  SERVER_TIMESTAMP,
} from '../../api/_lib';

/**
 * Phase 2 (Plan v5) toggle-access tests.
 *
 * The repo's existing API tests (test-*.mjs at the root) are live
 * integration scripts against an emulator; nothing in the codebase mocks
 * the Firestore layer. These tests take the purest route the codebase
 * supports: the toggle logic lives in api/_lib.ts and reaches Firestore
 * only through global fetch, so fetch is stubbed with an in-memory
 * Firestore REST fake and the REAL _lib code paths (admin gate, write
 * payloads, tier resolution) run against it — no network, no emulator.
 */

type Plain = Record<string, unknown>;

const store = new Map<string, Plain>();
let calls: Array<{ method: string; path: string; body?: Plain }> = [];
let autoId = 0;

function encVal(v: unknown): unknown {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return { integerValue: String(v) };
  return { stringValue: String(v) };
}
function decVal(v: any): unknown {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  return null;
}
function encFields(fields: Plain): Plain {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, encVal(v)]));
}
function decFields(fields: Plain): Plain {
  return Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, decVal(v)]));
}

function docPathFromUrl(url: string): string {
  const clean = url.split('?')[0];
  const marker = '/documents/';
  return clean.slice(clean.indexOf(marker) + marker.length);
}

const fetchStub = async (input: unknown, init?: { method?: string; body?: string }) => {
  const url = String(input);
  const method = (init?.method || 'GET').toUpperCase();
  const path = docPathFromUrl(url);
  const body = init?.body ? (JSON.parse(init.body) as { fields?: Plain }) : undefined;
  calls.push({ method, path, body: body?.fields ? decFields(body.fields) : undefined });

  if (method === 'GET' && path.includes('/')) {
    // Single-document GET.
    const data = store.get(path);
    if (!data) return new Response('', { status: 404 });
    return new Response(JSON.stringify({ fields: encFields(data) }), { status: 200 });
  }
  if (method === 'GET') {
    // Collection list GET.
    const docs = [...store.entries()]
      .filter(([p]) => p.startsWith(`${path}/`))
      .map(([p, data]) => ({
        name: `projects/x/databases/(default)/documents/${p}`,
        fields: encFields(data),
      }));
    return new Response(JSON.stringify({ documents: docs }), { status: 200 });
  }
  if (method === 'PATCH') {
    const merged = { ...(store.get(path) || {}), ...decFields(body?.fields || {}) };
    store.set(path, merged);
    return new Response('{}', { status: 200 });
  }
  if (method === 'POST') {
    const id = `auto-${++autoId}`;
    store.set(`${path}/${id}`, decFields(body?.fields || {}));
    return new Response(
      JSON.stringify({ name: `projects/x/databases/(default)/documents/${path}/${id}` }),
      { status: 200 },
    );
  }
  return new Response('', { status: 405 });
};

const ADMIN = 'admin-uid';
const TARGET = 'fan-uid';

function seedTargetUser(overrides: Plain = {}) {
  store.set(`users/${TARGET}`, {
    uid: TARGET,
    email: 'fan@example.com',
    displayName: 'Fan One',
    photoURL: null,
    status: 'pending',
    plan: 'free',
    subscription: 'free',
    createdAt: '2026-10-20T12:00:00.000Z',
    marketingOptIn: true,
    ...overrides,
  });
}

beforeEach(() => {
  store.clear();
  calls = [];
  autoId = 0;
  vi.stubGlobal('fetch', fetchStub);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildAccessToggleWrites (pure payloads)', () => {
  it('approve writes the lifetime license a Stripe webhook would write', () => {
    const w = buildAccessToggleWrites(TARGET, 'fan@example.com', true, ADMIN);
    expect(w.licensePath).toBe(`licenses/${TARGET}`);
    expect(w.licenseFields).toEqual({
      tier: 'lifetime',
      active: true,
      source: 'manual-toggle',
      grantedBy: ADMIN,
      updatedAt: SERVER_TIMESTAMP,
    });
    expect(w.userPath).toBe(`users/${TARGET}`);
    expect(w.userFields).toEqual({ status: 'approved' });
    expect(w.logCollection).toBe('approvals');
    expect(w.logFields).toEqual({
      uid: TARGET,
      email: 'fan@example.com',
      action: 'approved',
      by: ADMIN,
      at: SERVER_TIMESTAMP,
    });
  });

  it('revoke only deactivates the license (tier record survives) and re-pends the user', () => {
    const w = buildAccessToggleWrites(TARGET, 'fan@example.com', false, ADMIN);
    expect(w.licenseFields.active).toBe(false);
    expect('tier' in w.licenseFields).toBe(false);
    expect('grantedBy' in w.licenseFields).toBe(false);
    expect(w.userFields).toEqual({ status: 'pending' });
    expect(w.logFields.action).toBe('revoked');
  });
});

describe('applyAccessToggle', () => {
  it('non-admin caller gets NOT_ADMIN and writes nothing', async () => {
    seedTargetUser();
    await expect(applyAccessToggle('random-uid', TARGET, true, 'tok')).rejects.toMatchObject({
      code: 'NOT_ADMIN',
    });
    await expect(applyAccessToggle('random-uid', TARGET, true, 'tok')).rejects.toBeInstanceOf(
      AccessToggleError,
    );
    expect(calls.filter((c) => c.method === 'PATCH' || c.method === 'POST')).toEqual([]);
    expect(store.has(`licenses/${TARGET}`)).toBe(false);
  });

  it('admin approve: license granted, status approved, approval logged', async () => {
    store.set(`admins/${ADMIN}`, { role: 'owner' });
    seedTargetUser();
    const summary = await applyAccessToggle(ADMIN, TARGET, true, 'tok');

    const license = store.get(`licenses/${TARGET}`);
    expect(license?.tier).toBe('lifetime');
    expect(license?.active).toBe(true);
    expect(license?.source).toBe('manual-toggle');
    expect(license?.grantedBy).toBe(ADMIN);

    expect(store.get(`users/${TARGET}`)?.status).toBe('approved');

    const logs = [...store.entries()].filter(([p]) => p.startsWith('approvals/'));
    expect(logs).toHaveLength(1);
    expect(logs[0][1]).toMatchObject({
      uid: TARGET,
      email: 'fan@example.com',
      action: 'approved',
      by: ADMIN,
    });

    expect(summary.status).toBe('approved');
    expect(summary.licenseTier).toBe('lifetime');
    expect(summary.email).toBe('fan@example.com');
  });

  it('admin revoke: license deactivated, status back to pending, revocation logged', async () => {
    store.set(`admins/${ADMIN}`, { role: 'owner' });
    seedTargetUser({ status: 'approved' });
    store.set(`licenses/${TARGET}`, { tier: 'lifetime', active: true, source: 'manual-toggle' });

    const summary = await applyAccessToggle(ADMIN, TARGET, false, 'tok');

    expect(store.get(`licenses/${TARGET}`)?.active).toBe(false);
    expect(store.get(`licenses/${TARGET}`)?.tier).toBe('lifetime'); // record survives
    expect(store.get(`users/${TARGET}`)?.status).toBe('pending');
    const logs = [...store.entries()].filter(([p]) => p.startsWith('approvals/'));
    expect(logs).toHaveLength(1);
    expect(logs[0][1]).toMatchObject({ action: 'revoked' });
    expect(summary.status).toBe('pending');
    expect(summary.licenseTier).toBe('free');
  });

  it('unknown target gets USER_NOT_FOUND and no license write', async () => {
    store.set(`admins/${ADMIN}`, { role: 'owner' });
    await expect(applyAccessToggle(ADMIN, 'ghost-uid', true, 'tok')).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
    });
    expect(store.has('licenses/ghost-uid')).toBe(false);
  });
});

describe('fetchAdminUsers', () => {
  it('non-admin caller gets NOT_ADMIN', async () => {
    seedTargetUser();
    await expect(fetchAdminUsers('random-uid', 'tok')).rejects.toMatchObject({
      code: 'NOT_ADMIN',
    });
  });

  it('admin gets every signup newest-first with tiers resolved from licenses', async () => {
    store.set(`admins/${ADMIN}`, { role: 'owner' });
    seedTargetUser();
    store.set('users/older-uid', {
      uid: 'older-uid',
      email: 'old@example.com',
      displayName: 'Old Timer',
      photoURL: null,
      status: 'approved',
      plan: 'free',
      subscription: 'free',
      createdAt: '2026-10-01T12:00:00.000Z',
      marketingOptIn: false,
    });
    store.set(`licenses/${TARGET}`, { tier: 'lifetime', active: true });
    store.set('licenses/older-uid', { tier: 'lifetime', active: false });

    const users = await fetchAdminUsers(ADMIN, 'tok');
    expect(users.map((u) => u.uid)).toEqual([TARGET, 'older-uid']);
    expect(users[0].licenseTier).toBe('lifetime');
    expect(users[0].marketingOptIn).toBe(true);
    expect(users[0].createdAt).toBe('2026-10-20T12:00:00.000Z');
    expect(users[1].licenseTier).toBe('free'); // deactivated license is not a tier
  });
});
