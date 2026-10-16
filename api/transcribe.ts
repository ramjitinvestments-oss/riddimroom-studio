import { FieldValue } from 'firebase-admin/firestore';
import {
  verifyRequest,
  getDb,
  getLicenseTier,
  DEFAULT_DAILY_QUOTA,
  LIFETIME_DAILY_QUOTA,
  type ApiRequest,
  type ApiResponse,
} from './_lib';
import { getTranscriptionProvider, TranscriptionConfigurationError } from '../src/lib/transcription';
import type { UserProfile } from '../src/types/user';

// Transcription can wait on Gemini file processing; give the function the
// longest window that deploys on any Vercel plan. Typical short clips
// finish well inside this. (Express/server.ts has no such cap.)
export const config = { maxDuration: 60 };

// AI transcription + server-side quota enforcement. Mirrors server.ts
// POST /api/transcribe, including the media-ownership check.
export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }
  const decoded = await verifyRequest(req, res);
  if (!decoded) return;
  const uid = decoded.uid;
  const body = (req.body || {}) as { storageUrl?: unknown; mimeType?: unknown; durationSeconds?: unknown };
  const { storageUrl, mimeType, durationSeconds } = body;

  if (typeof storageUrl !== 'string' || !storageUrl) {
    res.status(400).json({ success: false, error: 'storageUrl is required.' });
    return;
  }
  if (typeof mimeType !== 'string' || !mimeType) {
    res.status(400).json({ success: false, error: 'mimeType is required.' });
    return;
  }
  const ownedPrefix = `users%2F${uid}%2Fmedia%2F`;
  if (!storageUrl.includes(ownedPrefix)) {
    res.status(403).json({ success: false, error: 'This media does not belong to the authenticated user.' });
    return;
  }

  const todayStr = new Date().toISOString().split('T')[0];
  const db = getDb();

  try {
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) {
      res.status(404).json({ success: false, error: 'User profile not found — call /api/user/status first.' });
      return;
    }
    const data = userDoc.data() as UserProfile;
    const dailyCount = data.lastTranscribeDate === todayStr ? data.dailyCount || 0 : 0;
    // v1: quota by license tier (free 2/day, lifetime 10/day).
    const licenseTier = await getLicenseTier(uid);
    const maxDaily = licenseTier === 'lifetime' ? LIFETIME_DAILY_QUOTA : DEFAULT_DAILY_QUOTA;

    if (dailyCount >= maxDaily) {
      res.status(429).json({
        success: false,
        error: `Daily transcription quota (${maxDaily}) reached. Try again tomorrow.`,
        dailyCount,
        maxFree: maxDaily,
      });
      return;
    }

    const transcriptionRequest = { mediaUrl: storageUrl, mimeType, durationSeconds: durationSeconds as number | undefined };
    let result;
    try {
      result = await getTranscriptionProvider('gemini').transcribe(transcriptionRequest);
    } catch (err: any) {
      if (err instanceof TranscriptionConfigurationError) {
        // Explicit fallback attempt — only on a configuration error, not on
        // every Gemini failure (mirrors server.ts).
        try {
          result = await getTranscriptionProvider('whisper').transcribe(transcriptionRequest);
        } catch (fallbackErr: any) {
          if (fallbackErr instanceof TranscriptionConfigurationError) {
            res.status(503).json({
              success: false,
              error: 'Transcription is not configured on this server (no GEMINI_API_KEY and no WHISPER_API_URL). This is a configuration issue, not a code failure.',
            });
            return;
          }
          throw fallbackErr;
        }
      } else {
        throw err;
      }
    }

    const newDailyCount = dailyCount + 1;
    await userRef.update({
      dailyCount: newDailyCount,
      lastTranscribeDate: todayStr,
      totalTranscribes: FieldValue.increment(1),
      lastUpdated: FieldValue.serverTimestamp(),
    });

    res.status(200).json({ success: true, words: result.words, provider: result.provider, dailyCount: newDailyCount, maxFree: maxDaily });
  } catch (err: any) {
    console.error('[transcribe] failed:', err?.message || err);
    res.status(500).json({ success: false, error: err?.message || 'Transcription failed.' });
  }
}
