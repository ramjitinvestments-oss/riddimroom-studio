import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useProject } from '../../context/ProjectContext';
import { addCaptionItems } from '../../lib/timeline/insert';
import { messageForNonJsonTranscribeResponse, messageForTranscribeFetchFailure } from '../../lib/transcription/clientErrors';
import { getItemsByTrackType } from '../../lib/timeline/utils';
import { requestOpenPlan } from '../../lib/upgradeRequest';
import { recordFailure } from '../../lib/failureCounts';
import type { VideoTimelineItem, AudioTimelineItem } from '../../types/timeline';

/**
 * Phase 1 Step 10-11 (AI transcription + Caption engine). Calls the
 * server-side `/api/transcribe` route (never the Gemini API directly from
 * the client — the key stays server-only) for a chosen video/audio item,
 * then turns the returned word timings into real `caption` timeline items
 * via `addCaptionItems`, positioned to line up with that item's place on
 * the timeline.
 */
/**
 * The caption service is unavailable right now — shown when the PROVIDER's
 * own billing/quota is exhausted (R34, R33 audit §2 "provider billing
 * leak"). Gemini's "prepayment credits are depleted" is about the
 * service's account, not the user's — passing it through made it read as
 * if the USER's credits had run out.
 */
const CAPTION_SERVICE_UNAVAILABLE = 'The caption service is unavailable right now — please try again later.';

const PROVIDER_BILLING_PATTERNS = [
  /prepayment/i,
  /credits are depleted/i,
  /insufficient (funds|credits|balance)/i,
  /billing/i,
  /payment required/i,
];

function isProviderBillingMessage(msg: string): boolean {
  return PROVIDER_BILLING_PATTERNS.some((re) => re.test(msg));
}

/**
 * Provider errors sometimes arrive as a stringified JSON body (e.g. the
 * Gemini API's `{error:{code,message,status}}`). Pull the readable
 * message out so the panel shows the actual cause instead of a wall of
 * escaped JSON — EXCEPT provider-billing text, which is mapped to the
 * service-side message above (it is never the user's credits).
 */
function humanizeApiError(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  let msg = raw;
  try {
    const parsed = JSON.parse(raw);
    const parsedMsg = parsed?.error?.message;
    if (typeof parsedMsg === 'string' && parsedMsg) msg = parsedMsg;
  } catch {
    // not JSON — use the string as-is
  }
  if (isProviderBillingMessage(msg)) return CAPTION_SERVICE_UNAVAILABLE;
  return msg;
}

export function TranscribePanel({ uid }: { uid: string }) {
  const { idToken, userProfile, refreshUserProfile } = useAuth();
  const { project, mutate } = useProject();
  const [isTranscribing, setIsTranscribing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!project) return null;

  const transcribableItems: Array<{ item: VideoTimelineItem | AudioTimelineItem; label: string }> = [
    ...(getItemsByTrackType(project, 'video').filter((i) => i.type === 'video') as VideoTimelineItem[]),
    ...(getItemsByTrackType(project, 'audio').filter((i) => i.type === 'audio') as AudioTimelineItem[]),
  ].map((item) => ({ item, label: project.mediaAssets[item.mediaAssetId]?.fileName || item.id }));

  const quotaExhausted = !!userProfile && userProfile.dailyCount >= userProfile.maxFree;
  // R34 (UX-08): Promo's proactive pattern — the remaining count is shown
  // BEFORE the wall, from the profile the panel already holds (refreshed
  // after every transcription, so it stays current in-panel).
  const transcriptionsLeft = userProfile ? Math.max(0, userProfile.maxFree - userProfile.dailyCount) : null;
  const onLifetime = !!userProfile && (userProfile.licenseTier === 'lifetime' || userProfile.maxFree >= 10);

  const handleTranscribe = async (item: VideoTimelineItem | AudioTimelineItem) => {
    const asset = project.mediaAssets[item.mediaAssetId];
    if (!asset || !idToken) return;
    setIsTranscribing(item.id);
    setError(null);
    try {
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ storageUrl: asset.storageUrl, mimeType: asset.mimeType, durationSeconds: asset.durationSeconds }),
      });
      // If the body parses as JSON, surface the API's real error (an
      // earlier version masked EVERY non-200 — including quota and
      // provider errors — behind a "preview build" claim, which hid the
      // actual cause of a transcription outage for days). A non-JSON
      // response on production is not a "preview build" either: it's
      // what the serverless host returns when the function times out
      // (an HTML error page) — so name that failure class honestly and
      // tell the user to retry (see lib/transcription/clientErrors.ts).
      const isJson = (res.headers.get('content-type') || '').includes('application/json');
      if (!isJson) {
        setError(messageForNonJsonTranscribeResponse());
        recordFailure('transcribe', idToken);
        return;
      }
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(humanizeApiError(data.error) || 'Transcription failed. Check your connection and try again.');
        recordFailure('transcribe', idToken);
        return;
      }
      if (!data.words || data.words.length === 0) {
        setError('No speech detected in this media.');
      } else {
        const atTime = item.startTime - item.trimStart;
        mutate((p) => addCaptionItems(p, { words: data.words, atTime, captionStyleId: 'classic', source: 'ai' }));
      }
      await refreshUserProfile();
    } catch (err: any) {
      // Never surface a raw parser/network exception message to the
      // user — map it to its failure class (unreadable response vs.
      // unreachable service vs. the error's own readable message).
      setError(messageForTranscribeFetchFailure(err));
      recordFailure('transcribe', idToken);
    } finally {
      setIsTranscribing(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-bold uppercase tracking-wide text-white/50">AI transcription</h3>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {!quotaExhausted && transcriptionsLeft !== null && (
        <p className="text-xs text-white/60">
          {transcriptionsLeft} of {userProfile?.maxFree} transcriptions left today.
        </p>
      )}
      {quotaExhausted && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-amber-400">
            Daily quota reached ({userProfile?.dailyCount}/{userProfile?.maxFree}).{' '}
            {onLifetime ? 'Your count resets tomorrow.' : 'Lifetime raises it to 10 a day — $35 one-time.'}
          </p>
          {!onLifetime && (
            <button
              onClick={requestOpenPlan}
              className="min-h-11 px-3 py-2 text-xs font-bold uppercase tracking-wide bg-gold hover:bg-gold-bright rounded-lg text-black"
            >
              Upgrade to Lifetime
            </button>
          )}
        </div>
      )}
      {transcribableItems.length === 0 && <p className="text-xs text-white/60">Add a video or audio clip first.</p>}
      <ul className="flex flex-col gap-1">
        {transcribableItems.map(({ item, label }) => (
          <li key={item.id} className="flex items-center gap-2 bg-white/5 rounded px-2 py-1.5 text-xs">
            <span className="flex-1 truncate">{label}</span>
            <button
              onClick={() => handleTranscribe(item)}
              disabled={isTranscribing === item.id || quotaExhausted}
              className="px-2 py-1 text-[10px] font-bold uppercase bg-white/10 hover:bg-white/20 disabled:opacity-40 rounded text-white"
            >
              {isTranscribing === item.id ? 'Transcribing…' : 'Transcribe'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
