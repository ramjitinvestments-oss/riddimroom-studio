import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildAccessToggleWrites,
  applyAccessToggle,
  fetchAdminUsers,
  accessStateFor,
  getLicenseTier,
  toClientUser,
  transcribeGateError,
  dailyTranscribeQuota,
  AccessToggleError,
  SERVER_TIMESTAMP,
} from '../../api/_lib';
import type { UserProfile } from '../../src/types/user';

/**
 * Phase 2 (Plan v5) toggle-access tests, extended for R28's three
 * access states ('pending' | 'basic' | 'premium').
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

function seedAdmin() {
  store.set(`admins/${ADMIN}`, { role: 'owner' });
}

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

function approvalLogs(): Plain[] {
  return [...store.entries()].filter(([p]) => p.startsWith('approvals/')).map(([, v]) => v);
}

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    uid: TARGET,
    email: 'fan@example.com',
    displayName: 'Fan One',
    photoURL: null,
    provider: 'google',
    role: 'user',
    status: 'approved',
    createdAt: null,
    lastLogin: null,
    lastUpdated: null,
    dailyCount: 0,
    lastTranscribeDate: null,
    totalTranscribes: 0,
    captureCount: 0,
    photoCount: 0,
    videoCount: 0,
    subscription: 'free',
    plan: 'free',
    marketingOptIn: false,
    ...overrides,
  };
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

describe('accessStateFor (canonical derivation)', () => {
  it('is pending unless approved, then premium for lifetime and basic otherwise', () => {
    expect(accessStateFor('pending', 'free')).toBe('pending');
    expect(accessStateFor('pending', 'lifetime')).toBe('pending');
    expect(accessStateFor('denied', 'lifetime')).toBe('pending');
    expect(accessStateFor('', 'lifetime')).toBe('pending');
    expect(accessStateFor('approved', 'free')).toBe('basic');
    expect(accessStateFor('approved', 'lifetime')).toBe('premium');
  });
});

describe('buildAccessToggleWrites (pure payloads)', () => {
  it('basic writes an active free license, approves the user and logs basic with source', () => {
    const w = buildAccessToggleWrites(TARGET, 'fan@example.com', 'basic', ADMIN);
    expect(w.licensePath).toBe(`licenses/${TARGET}`);
    expect(w.licenseFields).toEqual({
      tier: 'free',
      active: true,
      source: 'tester-basic',
      grantedBy: ADMIN,
      updatedAt: SERVER_TIMESTAMP,
    });
    expect(w.userPath).toBe(`users/${TARGET}`);
    expect(w.userFields).toEqual({ status: 'approved' });
    expect(w.logCollection).toBe('approvals');
    expect(w.logFields).toEqual({
      uid: TARGET,
      email: 'fan@example.com',
      action: 'basic',
      source: 'tester-basic',
      by: ADMIN,
      at: SERVER_TIMESTAMP,
    });
  });

  it('premium writes the lifetime license a Stripe webhook would write and logs premium with source', () => {
    const w = buildAccessToggleWrites(TARGET, 'fan@example.com', 'premium', ADMIN);
    expect(w.licensePath).toBe(`licenses/${TARGET}`);
    expect(w.licenseFields).toEqual({
      tier: 'lifetime',
      active: true,
      source: 'tester-premium',
      grantedBy: ADMIN,
      updatedAt: SERVER_TIMESTAMP,
    });
    expect(w.userPath).toBe(`users/${TARGET}`);
    expect(w.userFields).toEqual({ status: 'approved' });
    expect(w.logCollection).toBe('approvals');
    expect(w.logFields).toEqual({
      uid: TARGET,
      email: 'fan@example.com',
      action: 'premium',
      source: 'tester-premium',
      by: ADMIN,
      at: SERVER_TIMESTAMP,
    });
  });

  it('pending only deactivates the license (tier record survives), re-pends the user and logs revoked with no source', () => {
    const w = buildAccessToggleWrites(TARGET, 'fan@example.com', 'pending', ADMIN);
    expect(w.licenseFields).toEqual({
      active: false,
      source: 'manual-toggle',
      updatedAt: SERVER_TIMESTAMP,
    });
    expect('tier' in w.licenseFields).toBe(false);
    expect('grantedBy' in w.licenseFields).toBe(false);
    expect(w.userFields).toEqual({ status: 'pending' });
    expect(w.logFields).toEqual({
      uid: TARGET,
      email: 'fan@example.com',
      action: 'revoked',
      by: ADMIN,
      at: SERVER_TIMESTAMP,
    });
    expect('source' in w.logFields).toBe(false);
  });
});

describe('applyAccessToggle', () => {
  it('non-admin caller gets NOT_ADMIN and writes nothing', async () => {
    seedTargetUser();
    await expect(applyAccessToggle('random-uid', TARGET, 'premium', 'tok')).rejects.toMatchObject({
      code: 'NOT_ADMIN',
    });
    await expect(applyAccessToggle('random-uid', TARGET, 'premium', 'tok')).rejects.toBeInstanceOf(
      AccessToggleError,
    );
    expect(calls.filter((c) => c.method === 'PATCH' || c.method === 'POST')).toEqual([]);
    expect(store.has(`licenses/${TARGET}`)).toBe(false);
  });

  it('self-approval is impossible: a non-admin toggling their OWN uid gets NOT_ADMIN and writes nothing', async () => {
    seedTargetUser();
    // No admins/{TARGET} doc — the caller is the target and not an admin.
    await expect(applyAccessToggle(TARGET, TARGET, 'premium', 'tok')).rejects.toMatchObject({
      code: 'NOT_ADMIN',
    });
    expect(calls.filter((c) => c.method === 'PATCH' || c.method === 'POST')).toEqual([]);
    expect(store.has(`licenses/${TARGET}`)).toBe(false);
    expect(store.get(`users/${TARGET}`)?.status).toBe('pending');
  });

  it('pending → basic: free license granted active, status approved, summary is basic/free', async () => {
    seedAdmin();
    seedTargetUser();
    const summary = await applyAccessToggle(ADMIN, TARGET, 'basic', 'tok');

    const license = store.get(`licenses/${TARGET}`);
    expect(license?.tier).toBe('free');
    expect(license?.active).toBe(true);
    expect(license?.source).toBe('tester-basic');
    expect(license?.grantedBy).toBe(ADMIN);

    expect(store.get(`users/${TARGET}`)?.status).toBe('approved');

    expect(approvalLogs()).toHaveLength(1);
    expect(approvalLogs()[0]).toMatchObject({
      uid: TARGET,
      email: 'fan@example.com',
      action: 'basic',
      source: 'tester-basic',
      by: ADMIN,
    });

    expect(summary.status).toBe('approved');
    expect(summary.licenseTier).toBe('free');
    expect(summary.accessState).toBe('basic');
    expect(summary.email).toBe('fan@example.com');
  });

  it('basic → premium: only the tier flips — status stays approved, premium logged', async () => {
    seedAdmin();
    seedTargetUser();
    await applyAccessToggle(ADMIN, TARGET, 'basic', 'tok');

    const summary = await applyAccessToggle(ADMIN, TARGET, 'premium', 'tok');

    expect(store.get(`licenses/${TARGET}`)?.tier).toBe('lifetime');
    expect(store.get(`licenses/${TARGET}`)?.active).toBe(true);
    expect(store.get(`users/${TARGET}`)?.status).toBe('approved');
    expect(approvalLogs()).toHaveLength(2);
    expect(approvalLogs()[1]).toMatchObject({ action: 'premium', source: 'tester-premium' });
    expect(summary.status).toBe('approved');
    expect(summary.licenseTier).toBe('lifetime');
    expect(summary.accessState).toBe('premium');
  });

  it('premium → basic: tier back to free, status STAYS approved, summary is basic', async () => {
    seedAdmin();
    seedTargetUser();
    await applyAccessToggle(ADMIN, TARGET, 'premium', 'tok');

    const summary = await applyAccessToggle(ADMIN, TARGET, 'basic', 'tok');

    expect(store.get(`licenses/${TARGET}`)?.tier).toBe('free');
    expect(store.get(`licenses/${TARGET}`)?.active).toBe(true);
    expect(store.get(`users/${TARGET}`)?.status).toBe('approved');
    expect(approvalLogs()[1]).toMatchObject({ action: 'basic', source: 'tester-basic' });
    expect(summary.status).toBe('approved');
    expect(summary.licenseTier).toBe('free');
    expect(summary.accessState).toBe('basic');
  });

  it('premium → pending: license deactivated, status back to pending, revocation logged', async () => {
    seedAdmin();
    seedTargetUser({ status: 'approved' });
    store.set(`licenses/${TARGET}`, { tier: 'lifetime', active: true, source: 'tester-premium' });

    const summary = await applyAccessToggle(ADMIN, TARGET, 'pending', 'tok');

    expect(store.get(`licenses/${TARGET}`)?.active).toBe(false);
    expect(store.get(`licenses/${TARGET}`)?.tier).toBe('lifetime'); // record survives
    expect(store.get(`users/${TARGET}`)?.status).toBe('pending');
    expect(approvalLogs()).toHaveLength(1);
    expect(approvalLogs()[0]).toMatchObject({ action: 'revoked' });
    expect(summary.status).toBe('pending');
    expect(summary.licenseTier).toBe('free');
    expect(summary.accessState).toBe('pending');
  });

  it('basic → pending: license deactivated, status back to pending', async () => {
    seedAdmin();
    seedTargetUser({ status: 'approved' });
    store.set(`licenses/${TARGET}`, { tier: 'free', active: true, source: 'tester-basic' });

    const summary = await applyAccessToggle(ADMIN, TARGET, 'pending', 'tok');

    expect(store.get(`licenses/${TARGET}`)?.active).toBe(false);
    expect(store.get(`users/${TARGET}`)?.status).toBe('pending');
    expect(approvalLogs()).toHaveLength(1);
    expect(approvalLogs()[0]).toMatchObject({ action: 'revoked' });
    expect(summary.status).toBe('pending');
    expect(summary.accessState).toBe('pending');
  });

  it('pending → premium directly: approved + lifetime in one call', async () => {
    seedAdmin();
    seedTargetUser();
    const summary = await applyAccessToggle(ADMIN, TARGET, 'premium', 'tok');

    const license = store.get(`licenses/${TARGET}`);
    expect(license?.tier).toBe('lifetime');
    expect(license?.active).toBe(true);
    expect(license?.source).toBe('tester-premium');
    expect(license?.grantedBy).toBe(ADMIN);
    expect(store.get(`users/${TARGET}`)?.status).toBe('approved');
    expect(approvalLogs()).toHaveLength(1);
    expect(approvalLogs()[0]).toMatchObject({
      uid: TARGET,
      email: 'fan@example.com',
      action: 'premium',
      source: 'tester-premium',
      by: ADMIN,
    });
    expect(summary.status).toBe('approved');
    expect(summary.licenseTier).toBe('lifetime');
    expect(summary.accessState).toBe('premium');
  });

  it('unknown target gets USER_NOT_FOUND and no license write', async () => {
    seedAdmin();
    await expect(applyAccessToggle(ADMIN, 'ghost-uid', 'premium', 'tok')).rejects.toMatchObject({
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
    seedAdmin();
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

  it('grandfathering: a pre-R28 approved user with an active lifetime manual-toggle license reports premium', async () => {
    seedAdmin();
    seedTargetUser({ status: 'approved' });
    store.set(`licenses/${TARGET}`, { tier: 'lifetime', active: true, source: 'manual-toggle' });

    const users = await fetchAdminUsers(ADMIN, 'tok');
    expect(users).toHaveLength(1);
    expect(users[0].licenseTier).toBe('lifetime');
    expect(users[0].accessState).toBe('premium');
  });

  it('grandfathering: a seeded pending user reports pending', async () => {
    seedAdmin();
    seedTargetUser();

    const users = await fetchAdminUsers(ADMIN, 'tok');
    expect(users).toHaveLength(1);
    expect(users[0].status).toBe('pending');
    expect(users[0].accessState).toBe('pending');
  });

  it('grandfathering: an approved user with an active free license reports basic', async () => {
    seedAdmin();
    seedTargetUser({ status: 'approved' });
    store.set(`licenses/${TARGET}`, { tier: 'free', active: true, source: 'tester-basic' });

    const users = await fetchAdminUsers(ADMIN, 'tok');
    expect(users).toHaveLength(1);
    expect(users[0].licenseTier).toBe('free');
    expect(users[0].accessState).toBe('basic');
  });
});

describe('transcribe enforcement', () => {
  it('transcribeGateError: pending non-admin gets the plain-language message', () => {
    expect(transcribeGateError('pending', false)).toBe(
      "Your access isn't switched on yet — transcription is available once the owner approves your account.",
    );
  });

  it('transcribeGateError: other non-approved statuses are restricted', () => {
    expect(transcribeGateError('denied', false)).toBe('Account access restricted');
    expect(transcribeGateError('suspended', false)).toBe('Account access restricted');
    expect(transcribeGateError('', false)).toBe('Account access restricted');
  });

  it('transcribeGateError: approved non-admin passes', () => {
    expect(transcribeGateError('approved', false)).toBeNull();
  });

  it('transcribeGateError: an admin passes with any status', () => {
    expect(transcribeGateError('pending', true)).toBeNull();
    expect(transcribeGateError('denied', true)).toBeNull();
    expect(transcribeGateError('approved', true)).toBeNull();
    expect(transcribeGateError('', true)).toBeNull();
  });

  it('dailyTranscribeQuota: free is 2 and lifetime is 10', () => {
    expect(dailyTranscribeQuota('free')).toBe(2);
    expect(dailyTranscribeQuota('lifetime')).toBe(10);
  });

  it('an approved user with an active FREE license resolves tier free (quota 2) through the store', async () => {
    seedTargetUser({ status: 'approved' });
    store.set(`licenses/${TARGET}`, { tier: 'free', active: true, source: 'tester-basic' });
    const tier = await getLicenseTier(TARGET, 'tok');
    expect(tier).toBe('free');
    expect(dailyTranscribeQuota(tier)).toBe(2);
  });

  it('an approved user with a lifetime license resolves tier lifetime (quota 10) through the store', async () => {
    seedTargetUser({ status: 'approved' });
    store.set(`licenses/${TARGET}`, { tier: 'lifetime', active: true, source: 'tester-premium' });
    const tier = await getLicenseTier(TARGET, 'tok');
    expect(tier).toBe('lifetime');
    expect(dailyTranscribeQuota(tier)).toBe(10);
  });

  it('toClientUser (what /api/user/status reports): basic yields licenseTier free and maxFree 2', () => {
    const client = toClientUser(makeProfile(), 'free');
    expect(client.licenseTier).toBe('free');
    expect(client.maxFree).toBe(2);
  });

  it('toClientUser (what /api/user/status reports): premium yields licenseTier lifetime and maxFree 10', () => {
    const client = toClientUser(makeProfile(), 'lifetime');
    expect(client.licenseTier).toBe('lifetime');
    expect(client.maxFree).toBe(10);
  });
});
