import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import rootHandler from '../../api/[action].ts';
import adminHandler from '../../api/admin/[action].ts';

const API_DIR = join(process.cwd(), 'api');

function functionFiles(dir = API_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return functionFiles(path);
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.startsWith('_')) return [];
      return [relative(API_DIR, path).replaceAll('\\', '/')];
    })
    .sort();
}

function mockResponse() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
    },
  };
}

async function dispatch(
  handler: (req: never, res: never) => Promise<void>,
  action: string,
  method: string,
) {
  const res = mockResponse();
  await handler(
    { method, headers: {}, query: { action } } as never,
    res as never,
  );
  return res;
}

describe('R40 deployment fix — serverless function consolidation', () => {
  it('keeps the Vercel function inventory at 11, with one spare Hobby slot', () => {
    expect(functionFiles()).toEqual([
      '[action].ts',
      'account/delete-request.ts',
      'admin/[action].ts',
      'checkout.ts',
      'failure-count.ts',
      'health.ts',
      'license.ts',
      'promo-analyze.ts',
      'transcribe.ts',
      'user/status.ts',
      'webhook/stripe.ts',
    ]);
  });

  it('routes every admin action to the handler that owns its method check', async () => {
    for (const [action, wrongMethod] of [
      ['users', 'POST'],
      ['set-access', 'GET'],
      ['failure-counts', 'POST'],
      ['deletion-requests', 'POST'],
    ] as const) {
      const res = await dispatch(adminHandler as never, action, wrongMethod);
      expect(res.statusCode).toBe(405);
      expect(res.body).toEqual({ success: false, error: 'Method not allowed.' });
    }
  });

  it('routes both site actions to their existing handlers', async () => {
    for (const action of ['site-scan', 'site-image']) {
      const res = await dispatch(rootHandler as never, action, 'GET');
      expect(res.statusCode).toBe(405);
      expect(res.body).toEqual({ success: false, error: 'Method not allowed.' });
    }
  });

  it('returns 404 for unknown actions on both dispatchers', async () => {
    for (const handler of [adminHandler, rootHandler]) {
      const res = await dispatch(handler as never, 'not-a-route', 'GET');
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ success: false, error: 'Not found.' });
    }
  });
});
