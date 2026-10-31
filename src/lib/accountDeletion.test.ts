import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestAccountDeletion } from './accountDeletion';

/**
 * R40 P-27 — account deletion: the client call's shape (authenticated
 * POST, empty body — the server takes uid/email from the token), its
 * fire-and-forget calm, and the honest completion path pinned in the
 * surfaces that describe it.
 */

describe('requestAccountDeletion', () => {
  it('POSTs to the delete-request endpoint with the caller’s token and an empty body', async () => {
    const fetcher = vi.fn(async () => ({ ok: true }));
    requestAccountDeletion('token-123', fetcher);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toBe('/api/account/delete-request');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-123');
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it('without a token it sends nothing', async () => {
    const fetcher = vi.fn(async () => ({ ok: true }));
    requestAccountDeletion(null, fetcher);
    requestAccountDeletion(undefined, fetcher);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('a failed send is silent — it never throws into the caller’s flow', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('network down');
    });
    expect(() => requestAccountDeletion('token-123', fetcher)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe('the honest completion path (source pins)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const dashboard = readFileSync(join(here, '..', 'components', 'Dashboard.tsx'), 'utf8');
  const admin = readFileSync(join(here, '..', 'components', 'AdminPanel.tsx'), 'utf8');

  it('the Dashboard dialog explains what deletion removes and that the owner completes it', () => {
    const flat = dashboard.replace(/\s+/g, ' ');
    expect(dashboard.includes('Delete my account')).toBe(true);
    expect(flat.includes('your account, your projects, and the files you uploaded')).toBe(true);
    expect(flat.includes('The owner completes it by hand')).toBe(true);
    expect(dashboard.includes('or email us now')).toBe(true);
  });

  it('the Admin readout states the completion path honestly — the app does not delete Auth users', () => {
    expect(admin.includes('Account deletion requests')).toBe(true);
    expect(admin.includes('Firebase console')).toBe(true);
    expect(admin.includes('does not delete the account itself')).toBe(true);
  });
});
