import React, { useCallback, useRef, useState } from 'react';
import { useProject } from '../../context/ProjectContext';
import { useAuth } from '../../context/AuthContext';
import { validateRenderResult } from '../../lib/export/validate';
import type { RenderProgress } from '../../lib/export/renderer';
import { transcodeWebmToMp4 } from '../../lib/export/mp4Transcoder';
import { createExportRenderer, getConfiguredExportEngine } from '../../lib/export/mediabunnyExporter';
import {
  EXPORT_FRAME_RATES,
  EXPORT_QUALITY_TIERS,
  EXPORT_RESOLUTIONS,
  resolveExportDimensions,
  resolveExportSettings,
  type ExportQualityTier,
  type ExportResolutionId,
} from '../../lib/export/quality';
import { canExportToday, exportsRemainingToday, recordExport } from '../../lib/licensing';
import { useLicenseTier } from '../../hooks/useLicenseTier';

/**
 * Phase 1 Step 12 (Export engine), extended for genuine MP4 output. Drives
 * the `Renderer` abstraction end to end — action -> progress -> a
 * validated recording — then, on the default 'ffmpeg' engine, feeds that
 * finished, validated WebM blob into `transcodeWebmToMp4` (ffmpeg.wasm)
 * to produce a real MP4 container. The rendering stage itself is
 * untouched; only a conversion stage was added after it. Never reports
 * success without both `validateRenderResult` and the MP4 conversion
 * itself succeeding.
 *
 * Pre-live build 2: the renderer comes from `createExportRenderer()`.
 * The default build still selects 'ffmpeg' (Canvas2DRenderer + the
 * transcode stage above, byte-for-byte the old flow). A build with
 * VITE_EXPORT_ENGINE=mediabunny selects the Mediabunny/WebCodecs
 * engine, whose `render()` returns the finished MP4 directly — the
 * transcode stage is skipped for it (there is no WebM to convert), and
 * its capability failures surface through this panel's existing error
 * path. Engine selection never falls back at runtime: a selected
 * engine that cannot run fails the export honestly.
 */
export function ExportPanel() {
  const { project } = useProject();
  const { currentUser: user } = useAuth();
  const [status, setStatus] = useState<'idle' | 'rendering' | 'converting' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const [convertRatio, setConvertRatio] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const busy = status === 'rendering' || status === 'converting';
  // Effective tier (server profile when the API answered; admin-grant
  // fallback on builds without /api/*) — see hooks/useLicenseTier.
  const { tier } = useLicenseTier();
  const remaining = user ? exportsRemainingToday(user.uid, tier) : 0;
  const canExport = user ? canExportToday(user.uid, tier) : false;

  // Export quality picker (Phase 2.1). Defaults reproduce the pre-picker
  // behavior exactly: native project resolution, the project's own frame
  // rate (`frameRateChoice === null` until the user picks one), and the
  // High tier (whose CRF/audio bitrate are the transcoder's original
  // hardcoded values — see lib/export/quality.ts).
  const [resolution, setResolution] = useState<ExportResolutionId>('native');
  const [frameRateChoice, setFrameRateChoice] = useState<number | null>(null);
  const [qualityTier, setQualityTier] = useState<ExportQualityTier>('high');

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

    // Resolve the picker into concrete encoder settings once, up front —
    // the SAME resolved values drive both stages (recording + MP4
    // transcode) so the two can never disagree about size/fps/quality.
    const output = resolveExportSettings(project.canvasWidth, project.canvasHeight, {
      resolution,
      frameRate: frameRateChoice ?? project.frameRate,
      quality: qualityTier,
    });

    try {
      const engine = getConfiguredExportEngine();
      const renderer = createExportRenderer(engine);
      const result = await renderer.render(project, {
        signal: controller.signal,
        onProgress: setProgress,
        output,
      });
      const validation = validateRenderResult(result.blob, result.durationSeconds);
      if (!validation.valid) {
        setError(validation.error || 'Export failed validation.');
        setStatus('error');
        return;
      }

      let mp4Blob: Blob;
      if (engine === 'mediabunny') {
        // The Mediabunny engine's render() output IS the finished MP4 —
        // no conversion stage exists for it.
        mp4Blob = result.blob;
      } else {
        setStatus('converting');
        try {
          mp4Blob = await transcodeWebmToMp4(result.blob, output.frameRate, ({ ratio }) => setConvertRatio(ratio), {
            crf: output.crf,
            audioBitrateKbps: output.audioBitsPerSecond / 1000,
          });
        } catch (convertErr: any) {
          setError(convertErr?.message || 'Could not convert the export to MP4.');
          setStatus('error');
          return;
        }
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
  }, [project, downloadUrl, busy, user, tier, resolution, frameRateChoice, qualityTier]);

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  if (!project) return null;

  const effectiveFrameRate = frameRateChoice ?? project.frameRate;
  const resolved = resolveExportSettings(project.canvasWidth, project.canvasHeight, {
    resolution,
    frameRate: effectiveFrameRate,
    quality: qualityTier,
  });
  // A resolution option that resolves to the native size anyway would be
  // a duplicate of "Native" (exports never upscale) — disable it honestly
  // instead of offering a choice that changes nothing.
  const isRedundantResolution = (id: ExportResolutionId): boolean => {
    if (id === 'native') return false;
    const dims = resolveExportDimensions(project.canvasWidth, project.canvasHeight, id);
    return dims.width === project.canvasWidth && dims.height === project.canvasHeight;
  };
  const chipClass = (isActive: boolean) =>
    `min-h-11 px-2 rounded-lg border text-xs font-bold transition ${
      isActive
        ? 'border-gold ring-1 ring-gold/60 bg-gold/10 text-gold'
        : 'border-white/10 bg-white/5 hover:bg-white/10 text-white/80 disabled:opacity-30 disabled:hover:bg-white/5'
    }`;

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-bold uppercase tracking-wide text-white/50">Export</h3>
      <p className="text-[11px] text-white/40">
        {user ? `${remaining} export${remaining === 1 ? '' : 's'} left today (${tier === 'lifetime' ? 'Lifetime' : 'Free'})` : 'Sign in to export.'}
        {project.watermarkEnabled !== false ? ' · Watermark on (free).' : ' · No watermark.'}
      </p>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase tracking-wide text-white/40">Resolution</span>
        <div className="flex gap-1.5">
          {EXPORT_RESOLUTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => setResolution(opt.id)}
              disabled={busy || isRedundantResolution(opt.id)}
              aria-pressed={resolution === opt.id}
              title={isRedundantResolution(opt.id) ? 'Same as this project\'s native size — exports never upscale' : undefined}
              className={`${chipClass(resolution === opt.id)} flex-1`}
            >
              {opt.id === 'native' ? `Native ${project.canvasWidth}×${project.canvasHeight}` : opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase tracking-wide text-white/40">Frame rate</span>
        <div className="flex gap-1.5">
          {EXPORT_FRAME_RATES.map((fps) => (
            <button
              key={fps}
              onClick={() => setFrameRateChoice(fps)}
              disabled={busy}
              aria-pressed={effectiveFrameRate === fps}
              className={`${chipClass(effectiveFrameRate === fps)} flex-1`}
            >
              {fps} fps
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase tracking-wide text-white/40">Quality</span>
        <div className="flex gap-1.5">
          {EXPORT_QUALITY_TIERS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => setQualityTier(opt.id)}
              disabled={busy}
              aria-pressed={qualityTier === opt.id}
              title={opt.description}
              className={`${chipClass(qualityTier === opt.id)} flex-1`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-white/30">
          Output: {resolved.width}×{resolved.height} · {resolved.frameRate} fps · ~{(resolved.videoBitsPerSecond / 1_000_000).toFixed(1)} Mbps video
          {' · '}{EXPORT_QUALITY_TIERS.find((t) => t.id === qualityTier)?.description}
        </p>
      </div>
      {!busy && (
        <button
          onClick={handleExport}
          disabled={busy || !canExport}
          className="min-h-11 px-3 py-2 text-xs font-bold uppercase tracking-wide bg-gold hover:bg-gold-bright rounded-lg text-black self-start disabled:opacity-50"
        >
          Export video (MP4)
        </button>
      )}
      {status === 'rendering' && (
        <div className="flex flex-col gap-2">
          <div className="w-full h-2 bg-white/10 rounded overflow-hidden">
            <div className="h-full bg-gold transition-all" style={{ width: `${Math.round((progress?.fraction ?? 0) * 100)}%` }} />
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
            <div className="h-full bg-gold transition-all" style={{ width: `${Math.round(convertRatio * 100)}%` }} />
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
