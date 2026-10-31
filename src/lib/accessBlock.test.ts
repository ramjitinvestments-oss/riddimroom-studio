import { describe, expect, it } from 'vitest';
import { accessBlockForProfileOutcome, isRestrictedReason } from './accessBlock';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * R40 P-23 — the access-block reason taxonomy: derivation from each
 * profile-fetch failure class, and the retention contract (the reason
 * survives the automatic sign-out — pinned against the AuthContext
 * source, the same source-pin style the repo uses elsewhere).
 */

describe('accessBlockForProfileOutcome', () => {
  it('a suspended or denied profile is switched-off', () => {
    expect(accessBlockForProfileOutcome({ kind: 'ok', status: 'suspended' })).toBe('switched-off');
    expect(accessBlockForProfileOutcome({ kind: 'ok', status: 'denied' })).toBe('switched-off');
  });

  it('a pending profile is pending — not a block', () => {
    expect(accessBlockForProfileOutcome({ kind: 'ok', status: 'pending' })).toBe('pending');
  });

  it('an active profile is no block at all', () => {
    expect(accessBlockForProfileOutcome({ kind: 'ok', status: 'active' })).toBeNull();
    expect(accessBlockForProfileOutcome({ kind: 'ok', status: 'approved' })).toBeNull();
  });

  it('a 403 from the status endpoint is switched-off (the refusal is the account state)', () => {
    expect(accessBlockForProfileOutcome({ kind: 'http-error', httpStatus: 403 })).toBe('switched-off');
  });

  it('a 401 is unreachable — the token was rejected before any account state was read', () => {
    expect(accessBlockForProfileOutcome({ kind: 'http-error', httpStatus: 401 })).toBe('unreachable');
  });

  it('other HTTP failures (500, 404) are unreachable', () => {
    expect(accessBlockForProfileOutcome({ kind: 'http-error', httpStatus: 500 })).toBe('unreachable');
    expect(accessBlockForProfileOutcome({ kind: 'http-error', httpStatus: 404 })).toBe('unreachable');
  });

  it('a network failure is unreachable', () => {
    expect(accessBlockForProfileOutcome({ kind: 'network-error' })).toBe('unreachable');
  });

  it('only switched-off and unreachable are restricted-screen reasons', () => {
    expect(isRestrictedReason('switched-off')).toBe(true);
    expect(isRestrictedReason('unreachable')).toBe(true);
    expect(isRestrictedReason('pending')).toBe(false);
    expect(isRestrictedReason(null)).toBe(false);
  });
});

describe('reason retention across sign-out (source pins)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const authSource = readFileSync(join(here, '..', 'context', 'AuthContext.tsx'), 'utf8');
  const appSource = readFileSync(join(here, '..', 'App.tsx'), 'utf8');

  it('AuthContext keeps an accessBlockReason and derives the old boolean from it', () => {
    expect(authSource.includes('accessBlockReason')).toBe(true);
    expect(authSource.includes('accessBlockForProfileOutcome')).toBe(true);
  });

  it('the explicit signOut does not clear the reason (retention across the sign-out path)', () => {
    const signOutAt = authSource.indexOf('const signOut = useCallback');
    expect(signOutAt).toBeGreaterThan(-1);
    const signOutBody = authSource.slice(signOutAt, signOutAt + 900);
    expect(signOutBody.includes('setAccessBlockReason(null)')).toBe(false);
    expect(signOutBody.includes('setIsAccountDisabled(false)')).toBe(false);
  });

  it('the restricted screen names both true states', () => {
    expect(appSource.includes('Your account is switched off')).toBe(true);
    expect(appSource.includes('reach the server')).toBe(true);
    expect(appSource.includes('check your connection and try again')).toBe(true);
  });
});
