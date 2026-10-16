import type { ApiRequest, ApiResponse } from './_lib';

export default function handler(_req: ApiRequest, res: ApiResponse) {
  res.status(200).json({ status: 'ok', service: 'riddimroom-studio', timestamp: new Date().toISOString() });
}
