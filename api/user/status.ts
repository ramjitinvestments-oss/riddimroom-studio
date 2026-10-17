import { FieldValue } from 'firebase-admin/firestore';
import {
  verifyRequest,
  getDb,
  getLicenseTier,
  isGlobalDisabled,
  toClientUser,
  type ApiRequest,
  type ApiResponse,
} from '../_lib.js';
import type { UserProfile } from '../../src/types/user.js';

// Session check + unified user document upsert. Mirrors server.ts
// GET /api/user/status, including the global kill-switch and the daily
// quota reset rule.
export default async function handler(req: ApiRequest, res: ApiResponse) {
  const decoded = await verifyRequest(req, res);
  if (!decoded) return;
  const uid = decoded.uid;
  const email = decoded.email || '';
  const todayStr = new Date().toISOString().split('T')[0];
  const db = getDb();

  try {
    // Kill-switch check before any profile work.
    const disabled = await isGlobalDisabled();
    const isAdmin = (await db.collection('admins').doc(uid).get()).exists;
    if (disabled && !isAdmin) {
      res.status(403).json({ success: false, error: 'RiddimRoom Studio is temporarily unavailable.' });
      return;
    }
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      const newUser: UserProfile = {
        uid,
        email,
        displayName: decoded.name || email.split('@')[0] || 'User',
        photoURL: decoded.picture || null,
        provider: decoded.firebase?.sign_in_provider || 'password',
        role: 'user',
        status: 'approved',
        createdAt: FieldValue.serverTimestamp(),
        lastLogin: FieldValue.serverTimestamp(),
        lastUpdated: FieldValue.serverTimestamp(),
        dailyCount: 0,
        lastTranscribeDate: todayStr,
        totalTranscribes: 0,
        captureCount: 0,
        photoCount: 0,
        videoCount: 0,
        subscription: 'free',
        plan: 'free',
      };
      await userRef.set(newUser);
      res.status(200).json({ success: true, user: toClientUser(newUser, 'free') });
      return;
    }

    const data = userDoc.data() as UserProfile;

    // Daily quota resets when lastTranscribeDate isn't today.
    const dailyCount = data.lastTranscribeDate === todayStr ? data.dailyCount || 0 : 0;

    const updates: Partial<UserProfile> & Record<string, unknown> = {
      lastLogin: FieldValue.serverTimestamp(),
      lastUpdated: FieldValue.serverTimestamp(),
    };
    if (dailyCount !== data.dailyCount) {
      updates.dailyCount = dailyCount;
      updates.lastTranscribeDate = todayStr;
    }
    await userRef.update(updates);

    if (data.status === 'suspended' || data.status === 'denied') {
      res.status(403).json({ success: false, error: 'Account access restricted' });
      return;
    }

    const licenseTier = await getLicenseTier(uid);
    res.status(200).json({ success: true, user: toClientUser({ ...data, dailyCount }, licenseTier) });
  } catch (err: any) {
    console.error('[user/status] Firestore operation failed:', err?.code || err?.message);
    res.status(500).json({ success: false, error: 'Failed to load user profile' });
  }
}
