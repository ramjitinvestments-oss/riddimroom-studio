import {
  verifyRequest,
  fsGetDoc,
  fsPatchDoc,
  SERVER_TIMESTAMP,
  getLicenseTier,
  dailyTranscribeQuota,
  transcribeGateError,
  type ApiRequest,
  type ApiResponse,
} from './_lib.js';
import { getTranscriptionProvider, TranscriptionConfigurationError } from '../src/lib/transcription/index.js';
import { applyBrandGlossary } from '../src/lib/transcription/brandGlossary.js';
import type { UserProfile } from '../src/types/user.js';

// Transcription can wait on Gemini file processing; give the function the
// longest window that deploys on any Vercel plan. Typical short clips
// finish well inside this. (Express/server.ts has no such cap.)
export const config = { maxDuration: 60 };

// AI transcription + quota enforcement (read-modify-write as the calling
// user — see api/_lib.ts header). Mirrors server.ts POST /api/transcribe,
// including the media-ownership check.
export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'Method not allowed.' });
    return;
  }
  const decoded = await verifyRequest(req, res);
  if (!decoded) return;
  const uid = decoded.uid;
  const idToken = decoded.idToken;
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

  try {
    const userDoc = await fsGetDoc(`users/${uid}`, idToken);
    if (!userDoc.exists) {
      res.status(404).json({ success: false, error: 'User profile not found — call /api/user/status first.' });
      return;
    }
    const data = userDoc.data as unknown as UserProfile;
    // Phase 2 (Plan v5) access gate: transcription is a paid capability,
    // so it requires an approved account. Admins are never gated by
    // status (the owner can't lock himself out). Pending is the normal
    // pre-approval state for every new signup — say so plainly.
    const callerIsAdmin = (await fsGetDoc(`admins/${uid}`, idToken)).exists;
    const gateError = transcribeGateError(data.status, callerIsAdmin);
    if (gateError) {
      res.status(403).json({ success: false, error: gateError });
      return;
    }
    const dailyCount = data.lastTranscribeDate === todayStr ? data.dailyCount || 0 : 0;
    // v1: quota by license tier (free 2/day, lifetime 10/day).
    const licenseTier = await getLicenseTier(uid, idToken);
    const maxDaily = dailyTranscribeQuota(licenseTier);

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
          // Attribute honestly: the primary provider's failure leads and
          // the fallback's is labeled as the fallback's — never surface
          // the fallback's error alone as if it were the whole story.
          throw new Error(`Primary transcription provider failed: ${err?.message || err} Fallback (whisper) also failed: ${fallbackErr?.message || fallbackErr}`);
        }
      } else {
        throw err;
      }
    }

    // Brand-glossary correction layer — THE single convergence point: both
    // the Gemini chain and the Whisper fallback above assign `result`, so
    // every provider path passes through here exactly once, on fresh
    // provider output only, before the response is returned. The client
    // stores these words as the canonical captions (exports inherit the
    // fixes); user-edited captions never flow back through this handler, so
    // the layer cannot touch them. Spec:
    // rea-product-line/phase4l/captions/CORRECTION-SPEC.md (§a/§c/§e).
    const glossary = applyBrandGlossary(result.words);
    if (glossary.corrections.length > 0) {
      console.info('[transcribe] brand glossary corrections applied:', JSON.stringify(glossary.corrections));
    }
    if (glossary.shadowHits.length > 0) {
      // Shadow entries (G3) are log-only: they record what WOULD change
      // and change nothing — visible here for QC, never applied, never
      // sent to the client as corrections.
      console.warn('[transcribe] brand glossary SHADOW hits (log-only, NOT applied):', JSON.stringify(glossary.shadowHits));
    }
    result = { ...result, words: glossary.words };

    const newDailyCount = dailyCount + 1;
    await fsPatchDoc(
      `users/${uid}`,
      {
        dailyCount: newDailyCount,
        lastTranscribeDate: todayStr,
        totalTranscribes: (data.totalTranscribes || 0) + 1,
        lastUpdated: SERVER_TIMESTAMP,
      },
      idToken,
    );

    res.status(200).json({ success: true, words: result.words, provider: result.provider, corrections: glossary.corrections, dailyCount: newDailyCount, maxFree: maxDaily });
  } catch (err: any) {
    console.error('[transcribe] failed:', err?.message || err);
    res.status(500).json({ success: false, error: err?.message || 'Transcription failed.' });
  }
}
