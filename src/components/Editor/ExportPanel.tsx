import React, { useCallback, useRef, useState } from 'react';
import { useProject } from '../../context/ProjectContext';
import { useAuth } from '../../context/AuthContext';
import { Canvas2DRenderer } from '../../lib/export/canvas2dRenderer';
import { validateRenderResult } from '../../lib/export/validate';
import type { RenderProgress } from '../../lib/export/renderer';
import { transcodeWebmToMp4 } from '../../lib/export/mp4Transcoder';
import { canExportToday, exportsRemainingToday, recordExport } from '../../lib/licensing';

/**
 * Phase 1 Step 12 (Export engine), extended for genuine MP4 output. Drives
 * the `Renderer` abstraction (currently `Canvas2DRenderer`) end to end
 * exactly as before — action -> progress -> a validated WebM recording —
 * then feeds that finished, validated WebM blob into `transcodeWebmToMp4`
 * (ffmpeg.wasm) to produce a real MP4 container. The rendering stage itself
 * is untouched; only a conversion stage was added after it. Never reports
 * success without both `validateRenderResult` and the MP4 conversion
 * itself succeeding.
 */
export function ExportPanel() {
  const { project } = useProject();
  const { currentUser: user, userProfile } = useAuth();
  const [status, setStatus] = useState<'idle' | 'rendering' | 'converting' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const [convertRatio, setConvertRatio] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const busy = status === 'rendering' || status === 'converting';
  const tier = userProfile?.licenseTier ?? 'free';
  const remaining = user ? exportsRemainingToday(user.uid, tier) : 0;
  const canExport = user ? canExportToday(user.uid, tier) : false;

  const handleExport = useCallback(async () => {
    if (!project || busy) return; // guards against duplicate/overlapping exports
    if (user && !canExportToday(user.uid, tier)) {
      setError(`Daily export limit reached (${tier === 'lifetime' ? 'lifetime' : 'free'} plan). Upgrade to Lifetime for more exports.`);
      setStatus('error');
      return;
    }
    setStatus('rendering');
    setError(null);
    setProgress(null);
    setConvertRatio(0);
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setDownloadUrl(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const renderer = new Canvas2DRenderer();
      const result = await renderer.render(project, {
        signal: controller.signal,
        onProgress: setProgress,
      });
      const validation = validateRenderResult(result.blob, result.durationSeconds);
      if (!validation.valid) {
        setError(validation.error || 'Export failed validation.');
        setStatus('error');
        return;
      }

      setStatus('converting');
      let mp4Blob: Blob;
      try {
        mp4Blob = await transcodeWebmToMp4(result.blob, project.frameRate, ({ ratio }) => setConvertRatio(ratio));
      } catch (convertErr: any) {
        setError(convertErr?.message || 'Could not convert the export to MP4.');
        setStatus('error');
        return;
      }

      setDownloadUrl(URL.createObjectURL(mp4Blob));
      setStatus('done');
      if (user) recordExport(user.uid);
    } catch (err: any) {
      if (err?.name === 'RenderAbortedError') {
        setStatus('idle');
      } else {
        setError(err?.message || 'Export failed.');
        setStatus('error');
      }
    } finally {
      abortRef.current = null;
    }
  }, [project, downloadUrl, busy, user, tier]);

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  if (!project) return null;

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-bold uppercase tracking-wide text-white/50">Export</h3>
      <p className="text-[11px] text-white/40">
        {user ? `${remaining} export${remaining === 1 ? '' : 's'} left today (${tier === 'lifetime' ? 'Lifetime' : 'Free'})` : 'Sign in to export.'}
        {project.watermarkEnabled !== false ? ' · Watermark on (free).' : ' · No watermark.'}
      </p>
      {!busy && (
        <button
          onClick={handleExport}
          disabled={busy || !canExport}
          className="min-h-11 px-3 py-2 text-xs font-bold uppercase tracking-wide bg-emerald-600 hover:bg-emerald-500 rounded-lg text-white self-start disabled:opacity-50"
        >
          Export video (MP4)
        </button>
      )}
      {status === 'rendering' && (
        <div className="flex flex-col gap-2">
          <div className="w-full h-2 bg-white/10 rounded overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.round((progress?.fraction ?? 0) * 100)}%` }} />
          </div>
          <p className="text-[10px] text-white/40">
            {progress ? `Rendering… ${progress.renderedSeconds.toFixed(1)}s / ${progress.totalSeconds.toFixed(1)}s` : 'Starting…'}
          </p>
          <button onClick={handleCancel} className="min-h-11 text-[10px] text-white/40 hover:text-white/70 underline self-start">
            Cancel
          </button>
        </div>
      )}
      {status === 'converting' && (
        <div className="flex flex-col gap-2">
          <div className="w-full h-2 bg-white/10 rounded overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.round(convertRatio * 100)}%` }} />
          </div>
          <p className="text-[10px] text-white/40">Preparing MP4… {Math.round(convertRatio * 100)}%</p>
        </div>
      )}
      {status === 'error' && error && <p className="text-xs text-red-400">{error}</p>}
      {status === 'done' && downloadUrl && (
        <a
          href={downloadUrl}
          download={`${project.name.replace(/[^a-z0-9-_]+/gi, '_') || 'export'}.mp4`}
          className="min-h-11 px-3 py-2 text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 rounded-lg text-white self-start flex items-center"
        >
          Download MP4
        </a>
      )}
    </div>
  );
}
