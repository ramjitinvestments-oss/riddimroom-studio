import type { ApiRequest, ApiResponse } from '../_lib.js';
import deletionRequestsHandler from './_deletion-requests.js';
import failureCountsHandler from './_failure-counts.js';
import setAccessHandler from './_set-access.js';
import usersHandler from './_users.js';

// One Vercel function for the whole /api/admin/* surface. The public
// paths are unchanged: this dispatcher only selects the pre-existing
// handler for the final path segment, so methods, auth checks, status
// codes and response bodies stay exactly as they were when each action
// lived in its own route file.
interface RoutedRequest extends ApiRequest {
  query?: Record<string, string | string[] | undefined>;
  url?: string;
}

function actionFrom(req: RoutedRequest): string | undefined {
  const queried = req.query?.action;
  if (typeof queried === 'string' && queried) return queried;
  if (Array.isArray(queried) && queried[0]) return queried[0];
  if (req.url) {
    try {
      const parts = new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean);
      return parts[parts.length - 1];
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export default async function handler(req: RoutedRequest, res: ApiResponse) {
  switch (actionFrom(req)) {
    case 'users':
      return usersHandler(req, res);
    case 'set-access':
      return setAccessHandler(req, res);
    case 'failure-counts':
      return failureCountsHandler(req, res);
    case 'deletion-requests':
      return deletionRequestsHandler(req, res);
    default:
      res.status(404).json({ success: false, error: 'Not found.' });
  }
}
