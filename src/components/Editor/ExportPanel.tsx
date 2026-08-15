import React, { useCallback, useRef, useState } from 'react';
import { useProject } from '../../context/ProjectContext';
import { Canvas2DRenderer } from '../../lib/export/canvas2dRenderer';
import { validateRenderResult } from '../../lib/export/validate';
import type { RenderProgress } from '../../lib/export/renderer';

/**
 * Phase 1 Step 12 (Export engine). Drives the `Renderer` abstraction
 * (currently `Canvas2DRenderer`) end to end: action -> progress -> either
 * a downloadable, validated output or a surfaced error. Never reports
 * success without `validateRenderResult` passing.
 */
export function ExportPanel() {
  const { project } = useProject();
  const [status, setStatus] = useState<'idle' | 'rendering' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const handleExport = useCallback(async () => {
    if (!project) return;
    setStatus('rendering');
    setError(null);
    setProgress(null);
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
      setDownloadUrl(URL.createObjectURL(result.blob));
      setStatus('done');
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
  }, [project, downloadUrl]);

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  if (!project) return null;

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-bold uppercase tracking-wide text-white/50">Export</h3>
      {status !== 'rendering' && (
        <button
          onClick={handleExport}
          className="px-3 py-2 text-xs font-bold uppercase tracking-wide bg-emerald-600 hover:bg-emerald-500 rounded-lg text-white self-start"
        >
          Export video
        </button>
      )}
      {status === 'rendering' && (
        <div className="flex flex-col gap-2">
          <div className="w-full h-2 bg-white/10 rounded overflow-hidden">
            <div className="h-full bg-emerald-500 transition-all" style={{ width: `${Math.round((progress?.fraction ?? 0) * 100)}%` }} />
          </div>
          <p className="text-[10px] text-white/40">
            {progress ? `${progress.renderedSeconds.toFixed(1)}s / ${progress.totalSeconds.toFixed(1)}s` : 'Starting…'}
          </p>
          <button onClick={handleCancel} className="text-[10px] text-white/40 hover:text-white/70 underline self-start">
            Cancel
          </button>
        </div>
      )}
      {status === 'error' && error && <p className="text-xs text-red-400">{error}</p>}
      {status === 'done' && downloadUrl && (
        <a
          href={downloadUrl}
          download={`${project.name.replace(/[^a-z0-9-_]+/gi, '_') || 'export'}.webm`}
          className="px-3 py-2 text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 rounded-lg text-white self-start"
        >
          Download export
        </a>
      )}
    </div>
  );
}
