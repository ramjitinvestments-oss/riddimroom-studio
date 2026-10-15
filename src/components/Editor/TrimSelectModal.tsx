import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { MAX_MEDIA_SECONDS } from '../../lib/media/constants';

/**
 * "Universal 30-second media standard" spec item 2 — the pre-import
 * trim/select workflow for an uploaded video/audio file longer than
 * `MAX_MEDIA_SECONDS`. Per the explicit requirement, this is NOT a reject
 * ("do NOT reject an over-length media file outright") and NOT a silent
 * full-length import ("do NOT silently import the entire file") — the user
 * previews the source, picks a start/end within the limit, and only that
 * selected window ever gets uploaded/placed on the timeline (via
 * `AppendMediaOptions.trimStart`/`trimEnd` in `lib/timeline/insert.ts`).
 *
 * Deliberately does not require the user to externally trim the file first
 * — this modal IS the trim step, entirely client-side, before any bytes are
 * uploaded to Storage.
 */

export interface TrimSelectResult {
  trimStart: number;
  trimEnd: number;
}

interface TrimSelectModalProps {
  file: File;
  kind: 'video' | 'audio';
  durationSeconds: number;
  onConfirm: (result: TrimSelectResult) => void;
  onCancel: () => void;
}

function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function TrimSelectModal({ file, kind, durationSeconds, onConfirm, onCancel }: TrimSelectModalProps) {
  const objectUrl = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(objectUrl), [objectUrl]);

  const safeDuration = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : MAX_MEDIA_SECONDS;
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(Math.min(safeDuration, MAX_MEDIA_SECONDS));
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);

  const selectedDuration = Math.max(0, end - start);
  const overLimit = selectedDuration > MAX_MEDIA_SECONDS + 0.05;
  const tooShort = selectedDuration < 0.2;

  const handleStartChange = (value: number) => {
    const s = Math.max(0, Math.min(value, safeDuration - 0.1));
    let e = end;
    if (e - s > MAX_MEDIA_SECONDS) e = Math.min(safeDuration, s + MAX_MEDIA_SECONDS);
    if (e <= s) e = Math.min(safeDuration, s + 0.5);
    setStart(s);
    setEnd(e);
    if (mediaRef.current) {
      try {
        mediaRef.current.currentTime = s;
      } catch {
        /* not seekable yet */
      }
    }
  };

  const handleEndChange = (value: number) => {
    const e = Math.max(0.1, Math.min(value, safeDuration));
    let s = start;
    if (e - s > MAX_MEDIA_SECONDS) s = Math.max(0, e - MAX_MEDIA_SECONDS);
    setEnd(e);
    setStart(s);
    if (mediaRef.current) {
      try {
        mediaRef.current.currentTime = Math.max(0, e - 0.3);
      } catch {
        /* not seekable yet */
      }
    }
  };

  const previewSelection = () => {
    const el = mediaRef.current;
    if (!el) return;
    try {
      el.currentTime = start;
    } catch {
      /* not seekable yet */
    }
    el.play().catch(() => {});
    const stopAt = () => {
      if (el.currentTime >= end) {
        el.pause();
        el.removeEventListener('timeupdate', stopAt);
      }
    };
    el.addEventListener('timeupdate', stopAt);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4">
      <div className="bg-[#111] border border-white/10 rounded-xl p-5 w-full max-w-md flex flex-col gap-4">
        <div>
          <h3 className="text-sm font-bold text-white uppercase tracking-wide">Select a clip (up to 10 min)</h3>
          <p className="text-xs text-white/40 mt-1">
            This {kind} is {formatClock(safeDuration)} long. RiddimRoom Studio clips are limited to {formatClock(MAX_MEDIA_SECONDS)} — scrub to
            choose the portion you want to use, then confirm.
          </p>
        </div>

        {kind === 'video' ? (
          <video
            ref={mediaRef as React.RefObject<HTMLVideoElement>}
            src={objectUrl}
            className="w-full rounded-lg bg-black max-h-64"
            playsInline
          />
        ) : (
          <audio ref={mediaRef as React.RefObject<HTMLAudioElement>} src={objectUrl} className="w-full" controls />
        )}

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-white/60">
            <span className="flex items-center justify-between">
              <span>Start</span>
              <span className="font-mono text-white/80">{formatClock(start)}</span>
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(0, safeDuration - 0.1)}
              step={0.1}
              value={start}
              onChange={(e) => handleStartChange(Number(e.target.value))}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-white/60">
            <span className="flex items-center justify-between">
              <span>End</span>
              <span className="font-mono text-white/80">{formatClock(end)}</span>
            </span>
            <input type="range" min={0} max={safeDuration} step={0.1} value={end} onChange={(e) => handleEndChange(Number(e.target.value))} />
          </label>
          <button onClick={previewSelection} className="self-start min-h-9 text-xs text-gold hover:text-gold-bright underline flex items-center gap-1">
            <Play size={12} /> Preview selection
          </button>
        </div>

        <div className="flex items-center justify-between text-xs">
          <span className={overLimit ? 'text-red-400 font-bold' : 'text-white/50'}>
            Selected: {formatClock(selectedDuration)} / {formatClock(MAX_MEDIA_SECONDS)}
          </span>
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={onCancel}
            className="min-h-11 px-3 text-xs font-bold uppercase tracking-wide bg-white/5 hover:bg-white/10 rounded-lg text-white/60"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm({ trimStart: start, trimEnd: end })}
            disabled={overLimit || tooShort}
            className="min-h-11 px-4 text-xs font-bold uppercase tracking-wide bg-gold hover:bg-gold-bright disabled:opacity-40 rounded-lg text-black"
          >
            Use This Clip
          </button>
        </div>
      </div>
    </div>
  );
}
