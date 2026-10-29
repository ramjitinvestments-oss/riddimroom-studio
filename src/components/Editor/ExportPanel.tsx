import React, { useCallback, useRef, useState } from 'react';
import { useProject } from '../../context/ProjectContext';
import { useAuth } from '../../context/AuthContext';
import { validateRenderResult } from '../../lib/export/validate';
import { humanizeExportError } from '../../lib/export/exportErrors';
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
import { evaluateProjectExportGate } from '../../lib/projectDurationGate';
import { useLicenseTier } from '../../hooks/useLicenseTier';
import { buildProducerReport, type LoudnessReading } from '../../lib/export/producerReport';
import { ensureFontsLoaded, fontsUsedInProject } from '../../lib/fonts';
import { buildSocialPosts, type SocialPlatform } from '../../lib/export/socialPosts';
import { AlertTriangle, Check, Info, X } from 'lucide-react';

/**
 * Measures the finished file's audio level (best-effort): decode the
 * MP4's audio and compute RMS + peak in dBFS for the producer's report.
 * Returns null when the browser can't decode it — the report then
 * simply omits the measurement rather than guessing.
 */
async function measureLoudness(blob: Blob): Promise<LoudnessReading | null> {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    try {
      const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
      let peak = 0;
      let sumSq = 0;
      let count = 0;
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const data = buf.getChannelData(ch);
        for (let i = 0; i < data.length; i += 16) {
          const v = data[i];
          const a = Math.abs(v);
          if (a > peak) peak = a;
          sumSq += v * v;
          count++;
        }
      }
      if (count === 0 || peak === 0) return null;
      return { rmsDbfs: 20 * Math.log10(Math.sqrt(sumSq / count)), peakDbfs: 20 * Math.log10(peak) };
    } finally {
      void ctx.close().catch(() => undefined);
    }
  } catch {
    return null;
  }
}

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
  // v9 share pack: keep the finished blob so it can go straight into the
  // phone's share sheet (WhatsApp / TikTok / gallery) without a re-export.
  const [lastBlob, setLastBlob] = useState<Blob | null>(null);
  const [captionCopied, setCaptionCopied] = useState(false);
  // R34 (UX-16): post-tap confirmation for "Save MP4 to this device" —
  // names the file and where it went, and stays on screen until the next
  // export action (mirrors CaptionsExportPanel's "Downloaded {name}…").
  const [savedFileName, setSavedFileName] = useState<string | null>(null);
  const [loudness, setLoudness] = useState<LoudnessReading | null>(null);
  const [postPlatform, setPostPlatform] = useState<SocialPlatform>('tiktok');
  const [postCopied, setPostCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // R27 WS-M8 — the 3-question ease check: shown once, after the first
  // successful export in this session, only if it has never been
  // answered/dismissed on this device (localStorage, no network).
  const [hasExportedThisSession, setHasExportedThisSession] = useState(false);
  const [easeCheckDone, setEaseCheckDone] = useState<boolean>(() => {
    try { return localStorage.getItem('rr:ease-check-done') === '1'; } catch { return false; }
  });
  const [easeRating, setEaseRating] = useState<string | null>(null);
  const [easeConfusing, setEaseConfusing] = useState<string[]>([]);
  const [easeComment, setEaseComment] = useState('');
  const busy = status === 'rendering' || status === 'converting';
  // Effective tier (server profile when the API answered; admin-grant
  // fallback on builds without /api/*) — see hooks/useLicenseTier.
  const { tier } = useLicenseTier();
  const remaining = user ? exportsRemainingToday(user.uid, tier) : 0;
  const canExport = user ? canExportToday(user.uid, tier) : false;
  // R35: the tier duration gate (Free 30s / Lifetime 600s, main-track
  // measure) — evaluated on every render for the proactive line below
  // and again inside handleExport before any encoding work starts.
  const durationGate = project ? evaluateProjectExportGate(project, tier) : null;

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
    // R35: the duration gate runs FIRST — before fonts, quota checks
    // and any encoding work. A refused export is not an export: it
    // never reaches recordExport, so it consumes no daily quota.
    const gate = evaluateProjectExportGate(project, tier);
    if (gate.exceedsCap) {
      setError(gate.message);
      setStatus('error');
      return;
    }
    if (user && !canExportToday(user.uid, tier)) {
      setError(`Daily export limit reached (${tier === 'lifetime' ? 'lifetime' : 'free'} plan). Upgrade to Lifetime for more exports.`);
      setStatus('error');
      return;
    }
    // Premium faces must be resident before the first frame draws,
    // or text silently falls back to Arial in the exported file.
    await ensureFontsLoaded(fontsUsedInProject(project));
    setStatus('rendering');
    setError(null);
    setSavedFileName(null);
    setProgress(null);
    setConvertRatio(0);
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setDownloadUrl(null);
    setLastBlob(null);
    setCaptionCopied(false);
    setLoudness(null);
    setPostCopied(false);

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
        setError(humanizeExportError(validation.error));
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
          setError(humanizeExportError(convertErr));
          setStatus('error');
          return;
        }
      }

      setDownloadUrl(URL.createObjectURL(mp4Blob));
      setLastBlob(mp4Blob);
      setStatus('done');
      setHasExportedThisSession(true);
      void measureLoudness(mp4Blob).then(setLoudness);
      if (user) recordExport(user.uid);
    } catch (err: any) {
      if (err?.name === 'RenderAbortedError') {
        setStatus('idle');
      } else {
        setError(humanizeExportError(err));
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
  const exportFileName = `${project.name.replace(/[^a-z0-9-_]+/gi, '_') || 'export'}.mp4`;
  const canShareFiles = !!(
    lastBlob &&
    typeof navigator !== 'undefined' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [new File([lastBlob], exportFileName, { type: 'video/mp4' })] })
  );
  const handleShare = async () => {
    if (!lastBlob) return;
    try {
      await navigator.share({ files: [new File([lastBlob], exportFileName, { type: 'video/mp4' })], title: project.name });
    } catch {
      // The user closed the share sheet — nothing to report.
    }
  };
  const handleCopyCaption = async () => {
    const caption = `${project.name} — made with RiddimRoom Studio · riddimroom.com\n#RiddimRoom #Caribbean #Dancehall #Soca #Trini`;
    try {
      await navigator.clipboard.writeText(caption);
      setCaptionCopied(true);
    } catch {
      setCaptionCopied(false);
    }
  };

  const producerReport = status === 'done' && project ? buildProducerReport(project, loudness) : null;
  const socialPosts = status === 'done' && project ? buildSocialPosts(project) : [];
  const activePost = socialPosts.find((post) => post.platform === postPlatform) ?? socialPosts[0];
  const handleCopyPost = async () => {
    if (!activePost) return;
    try {
      await navigator.clipboard.writeText(activePost.text);
      setPostCopied(true);
    } catch {
      setPostCopied(false);
    }
  };
  const handleSharePost = async () => {
    if (!activePost) return;
    try {
      await navigator.share({ text: activePost.text });
    } catch {
      // user closed the sheet
    }
  };

  // R27 WS-M8 — ease-check handlers (device-local only, no network).
  const toggleConfusing = (label: string) => {
    setEaseConfusing((prev) => {
      if (label === 'Nothing') return prev.includes('Nothing') ? [] : ['Nothing'];
      const rest = prev.filter((x) => x !== 'Nothing');
      return rest.includes(label) ? rest.filter((x) => x !== label) : [...rest, label];
    });
  };
  const submitEaseCheck = () => {
    try {
      localStorage.setItem('rr:ease-check-answer', JSON.stringify({ ease: easeRating, confusing: easeConfusing, comment: easeComment }));
      localStorage.setItem('rr:ease-check-done', '1');
    } catch {
      // Storage unavailable (private mode etc.) — just hide the card.
    }
    setEaseCheckDone(true);
  };
  const dismissEaseCheck = () => {
    try {
      localStorage.setItem('rr:ease-check-done', '1');
    } catch {
      // Same as above — hiding locally is enough.
    }
    setEaseCheckDone(true);
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
        {user
          ? Number.isFinite(remaining)
            ? `${remaining} export${remaining === 1 ? '' : 's'} left today (${tier === 'lifetime' ? 'Lifetime' : 'Free'})`
            : 'Unlimited exports (Lifetime)'
          : 'Sign in to export.'}
        {project.watermarkEnabled !== false ? ' · Watermark on (free).' : ' · No watermark.'}
      </p>
      {durationGate && (tier === 'free' || durationGate.exceedsCap) && (
        <p className={`text-[11px] ${durationGate.exceedsCap ? 'font-bold text-amber-300' : 'text-white/40'}`}>
          {durationGate.indicator}
        </p>
      )}

      {/* v9: the three export pickers as dropdowns — one row each. */}
      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase tracking-wide text-white/40">Resolution</span>
        <select
          aria-label="Export resolution"
          value={resolution}
          disabled={busy}
          onChange={(e) => setResolution(e.target.value as ExportResolutionId)}
          className="w-full min-h-11 bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-base text-white focus:outline-none focus:border-gold/60"
        >
          {EXPORT_RESOLUTIONS.map((opt) => (
            <option key={opt.id} value={opt.id} disabled={isRedundantResolution(opt.id)}>
              {opt.id === 'native' ? `Original size — ${project.canvasWidth}×${project.canvasHeight}` : opt.label}
              {isRedundantResolution(opt.id) ? ' (same as original size)' : ''}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase tracking-wide text-white/40">Frame rate</span>
        <select
          aria-label="Export frame rate"
          value={effectiveFrameRate}
          disabled={busy}
          onChange={(e) => setFrameRateChoice(Number(e.target.value))}
          className="w-full min-h-11 bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-base text-white focus:outline-none focus:border-gold/60"
        >
          {EXPORT_FRAME_RATES.map((fps) => (
            <option key={fps} value={fps}>
              {fps} fps
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] font-bold uppercase tracking-wide text-white/40">Quality</span>
        <select
          aria-label="Export quality"
          value={qualityTier}
          disabled={busy}
          onChange={(e) => setQualityTier(e.target.value as ExportQualityTier)}
          className="w-full min-h-11 bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-base text-white focus:outline-none focus:border-gold/60"
        >
          {EXPORT_QUALITY_TIERS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label} — {opt.description}
            </option>
          ))}
        </select>
        <span className="text-[10px] text-white/30">
          {resolved.height === 1080 ? 'Full HD' : resolved.height === 720 ? 'HD' : 'Original size'} · {resolved.frameRate} frames per second · smooth for TikTok and Reels{' '}
          <span className="text-white/25">({resolved.width}×{resolved.height})</span>
        </span>
      </label>
      {!busy && (
        <button
          onClick={handleExport}
          disabled={busy || !canExport || !!durationGate?.exceedsCap}
          className="w-full min-h-11 px-3 py-2 text-xs font-bold uppercase tracking-wide bg-gold hover:bg-gold-bright rounded-lg text-black disabled:opacity-50"
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
        <div className="flex flex-col gap-1.5 rounded-xl border border-gold/30 bg-gold/5 p-2.5">
          <span className="text-[11px] font-bold uppercase tracking-wide text-gold">Share pack</span>
          {canShareFiles && (
            <button
              onClick={() => void handleShare()}
              className="min-h-11 px-3 rounded-lg bg-gold hover:bg-gold-bright text-black text-xs font-black uppercase tracking-wide"
            >
              Share video…
            </button>
          )}
          <a
            href={downloadUrl}
            download={exportFileName}
            onClick={() => setSavedFileName(exportFileName)}
            className="min-h-11 px-3 py-2 text-xs font-bold uppercase tracking-wide bg-white/10 hover:bg-white/20 rounded-lg text-white flex items-center justify-center"
          >
            Save MP4 to this device
          </a>
          {savedFileName && (
            <p className="text-xs font-bold text-emerald-400">Saved ✓ — {savedFileName} is in your Downloads.</p>
          )}
          <button
            onClick={() => void handleCopyCaption()}
            className="min-h-11 px-3 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-white text-xs font-bold"
          >
            {captionCopied ? 'Caption copied ✓' : 'Copy caption + hashtags'}
          </button>
          {!canShareFiles && (
            <p className="text-[10px] text-white/40">
              This browser can't share files directly — save the MP4, then post it from your gallery or files.
            </p>
          )}
        </div>
      )}

      {hasExportedThisSession && !easeCheckDone && (
        <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wide text-white/70">Quick check — 10 seconds</span>
            <button onClick={dismissEaseCheck} aria-label="Dismiss" className="min-h-11 min-w-11 flex items-center justify-center text-white/50 hover:text-white shrink-0">
              <X size={14} strokeWidth={3} />
            </button>
          </div>
          <p className="text-xs font-bold text-white/85">How easy was that?</p>
          <div className="flex gap-1.5">
            {(['Easy', 'OK', 'Hard'] as const).map((label) => (
              <button
                key={label}
                onClick={() => setEaseRating(label)}
                aria-pressed={easeRating === label}
                className={`flex-1 min-h-11 px-2 rounded-lg border text-xs font-bold transition ${
                  easeRating === label
                    ? 'border-gold ring-1 ring-gold/60 bg-gold/10 text-gold'
                    : 'border-white/10 bg-white/5 hover:bg-white/10 text-white/80'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-xs font-bold text-white/85">Was anything confusing?</p>
          <div className="flex flex-wrap gap-1.5">
            {(['Clips', 'Words', 'Music', 'Saving', 'Nothing'] as const).map((label) => (
              <label key={label} className="min-h-11 inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 text-xs font-bold text-white/80 cursor-pointer">
                <input type="checkbox" checked={easeConfusing.includes(label)} onChange={() => toggleConfusing(label)} />
                {label}
              </label>
            ))}
          </div>
          <label className="flex flex-col gap-1 text-xs font-bold text-white/85">
            Tell us in a line (optional)
            <input
              type="text"
              value={easeComment}
              onChange={(e) => setEaseComment(e.target.value)}
              placeholder="Anything else?"
              className="min-h-11 bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-base font-normal text-white focus:outline-none focus:border-gold/60"
            />
          </label>
          <button onClick={submitEaseCheck} className="w-full min-h-11 px-3 rounded-lg bg-gold hover:bg-gold-bright text-black text-xs font-black uppercase tracking-wide">
            Submit
          </button>
        </div>
      )}

      {status === 'done' && producerReport && (
        <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wide text-white/70">Producer's report</span>
            <span className="text-[11px] font-black text-gold">
              {producerReport.score}/100 · Grade {producerReport.grade}
            </span>
          </div>
          <p className="text-xs text-white/80 font-bold">{producerReport.headline}</p>
          <div className="flex flex-col gap-1.5">
            {producerReport.checks.map((check) => (
              <div key={check.id} className="flex gap-2 items-start">
                <span className="mt-0.5 shrink-0">
                  {check.status === 'pass' ? (
                    <Check size={13} strokeWidth={3} className="text-emerald-400" />
                  ) : check.status === 'warn' ? (
                    <AlertTriangle size={13} className="text-amber-300" />
                  ) : check.status === 'fail' ? (
                    <X size={13} strokeWidth={3} className="text-red-400" />
                  ) : (
                    <Info size={13} className="text-white/40" />
                  )}
                </span>
                <p className="text-[11px] leading-snug text-white/60">
                  <span className="font-bold text-white/85">{check.label}.</span> {check.detail}
                </p>
              </div>
            ))}
          </div>
          {producerReport.fixes.length > 0 && (
            <div className="border-t border-white/10 pt-2 flex flex-col gap-1">
              <span className="text-[10px] font-bold uppercase tracking-wide text-white/40">Fix first</span>
              {producerReport.fixes.map((fix, i) => (
                <p key={i} className="text-[11px] text-gold/90 leading-snug">
                  {i + 1}. {fix}
                </p>
              ))}
            </div>
          )}
          <p className="text-[10px] text-white/30 leading-snug">
            Measured from your project and the finished file — hook timing, captions, beat, closing ask, format.
            Posting window tip: Caribbean audiences scroll hardest in the evening and on weekends.
          </p>
        </div>
      )}

      {status === 'done' && activePost && (
        <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <span className="text-[11px] font-bold uppercase tracking-wide text-white/70">
            Your posts — ready to paste, 5 tags each
          </span>
          <select
            aria-label="Post platform"
            value={activePost.platform}
            onChange={(e) => {
              setPostPlatform(e.target.value as SocialPlatform);
              setPostCopied(false);
            }}
            className="w-full min-h-11 bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-base text-white focus:outline-none focus:border-gold/60"
          >
            {socialPosts.map((post) => (
              <option key={post.platform} value={post.platform}>
                {post.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-white/80 whitespace-pre-wrap leading-relaxed bg-black/30 rounded-lg p-2.5">{activePost.text}</p>
          <div className="flex gap-1.5">
            <button
              onClick={() => void handleCopyPost()}
              className="flex-1 min-h-11 px-3 rounded-lg bg-gold hover:bg-gold-bright text-black text-xs font-black uppercase tracking-wide"
            >
              {postCopied ? 'Copied ✓' : 'Copy post'}
            </button>
            {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
              <button
                onClick={() => void handleSharePost()}
                className="flex-1 min-h-11 px-3 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-white text-xs font-bold"
              >
                Share text…
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
