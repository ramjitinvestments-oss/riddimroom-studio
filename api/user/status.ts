import {
  verifyRequest,
  fsGetDoc,
  fsPatchDoc,
  SERVER_TIMESTAMP,
  getLicenseTier,
  isGlobalDisabled,
  toClientUser,
  type ApiRequest,
  type ApiResponse,
} from '../_lib.js';
import type { UserProfile } from '../../src/types/user.js';

// Session check + unified user document upsert. Mirrors server.ts
// GET /api/user/status, including the global kill-switch and the daily
// quota reset rule. Data access is Firestore REST as the calling user
// (see api/_lib.ts header for the model).
export default async function handler(req: ApiRequest, res: ApiResponse) {
  const decoded = await verifyRequest(req, res);
  if (!decoded) return;
  const uid = decoded.uid;
  const email = decoded.email || '';
  const idToken = decoded.idToken;
  const todayStr = new Date().toISOString().split('T')[0];

  try {
    // Kill-switch check before any profile work.
    const disabled = await isGlobalDisabled(idToken);
    const isAdmin = (await fsGetDoc(`admins/${uid}`, idToken)).exists;
    if (disabled && !isAdmin) {
      res.status(403).json({ success: false, error: 'RiddimRoom Studio is temporarily unavailable.' });
      return;
    }
    const userDoc = await fsGetDoc(`users/${uid}`, idToken);

    if (!userDoc.exists) {
      const newUser: UserProfile = {
        uid,
        email,
        displayName: decoded.name || email.split('@')[0] || 'User',
        photoURL: decoded.picture || null,
        provider: decoded.provider || 'password',
        role: 'user',
        status: 'approved',
        createdAt: SERVER_TIMESTAMP,
        lastLogin: SERVER_TIMESTAMP,
        lastUpdated: SERVER_TIMESTAMP,
        dailyCount: 0,
        lastTranscribeDate: todayStr,
        totalTranscribes: 0,
        captureCount: 0,
        photoCount: 0,
        videoCount: 0,
        subscription: 'free',
        plan: 'free',
      };
      await fsPatchDoc(`users/${uid}`, { ...newUser }, idToken);
      res.status(200).json({ success: true, user: toClientUser(newUser, 'free') });
      return;
    }

    const data = userDoc.data as unknown as UserProfile;

    // Daily quota resets when lastTranscribeDate isn't today.
    const dailyCount = data.lastTranscribeDate === todayStr ? data.dailyCount || 0 : 0;

    const updates: Record<string, unknown> = {
      lastLogin: SERVER_TIMESTAMP,
      lastUpdated: SERVER_TIMESTAMP,
    };
    if (dailyCount !== data.dailyCount) {
      updates.dailyCount = dailyCount;
      updates.lastTranscribeDate = todayStr;
    }
    await fsPatchDoc(`users/${uid}`, updates, idToken);

    if (data.status === 'suspended' || data.status === 'denied') {
      res.status(403).json({ success: false, error: 'Account access restricted' });
      return;
    }

    const licenseTier = await getLicenseTier(uid, idToken);
    res.status(200).json({ success: true, user: toClientUser({ ...data, dailyCount }, licenseTier) });
  } catch (err: any) {
    console.error('[user/status] Firestore operation failed:', err?.message || err);
    res.status(500).json({ success: false, error: 'Failed to load user profile' });
  }
}
