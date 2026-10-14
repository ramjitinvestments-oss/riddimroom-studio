import React, { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useProject } from '../../context/ProjectContext';
import { addCaptionItems } from '../../lib/timeline/insert';
import { getItemsByTrackType } from '../../lib/timeline/utils';
import type { VideoTimelineItem, AudioTimelineItem } from '../../types/timeline';

/**
 * Phase 1 Step 10-11 (AI transcription + Caption engine). Calls the
 * server-side `/api/transcribe` route (never the Gemini API directly from
 * the client — the key stays server-only) for a chosen video/audio item,
 * then turns the returned word timings into real `caption` timeline items
 * via `addCaptionItems`, positioned to line up with that item's place on
 * the timeline.
 */
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
      // Static preview builds have no /api routes at all — the response is
      // an HTML 404 page, and res.json() on it throws a raw SyntaxError
      // ("Unexpected token '<'…") that reads like a crash to the user.
      // Check status + content-type first and give a human answer instead.
      const isJson = (res.headers.get('content-type') || '').includes('application/json');
      if (!res.ok || !isJson) {
        setError("Transcription isn't available on this preview build yet.");
        return;
      }
      const data = await res.json();
      if (!data.success) {
        setError(data.error || `Transcription failed (HTTP ${res.status}).`);
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
      // Never surface a raw parser/network exception message to the user.
      setError(err instanceof SyntaxError ? "Transcription isn't available on this preview build yet." : err?.message || 'Transcription request failed.');
    } finally {
      setIsTranscribing(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-bold uppercase tracking-wide text-white/50">AI transcription</h3>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {quotaExhausted && (
        <p className="text-xs text-amber-400">
          Daily quota reached ({userProfile?.dailyCount}/{userProfile?.maxFree}). Try again tomorrow.
        </p>
      )}
      {transcribableItems.length === 0 && <p className="text-xs text-white/30">Add a video or audio clip first.</p>}
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
