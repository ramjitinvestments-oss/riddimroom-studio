/**
 * R41 WS-A — the camera diagnostics session ("Check camera
 * smoothness"): pure stats, the guided script, the longtask summary
 * and the evidence-pack builder.
 *
 * The session records ONE 60-second clip through the normal capture
 * path while this module's helpers collect the truth around it:
 * raw viewfinder frame timestamps (rVFC — see frameDrops), main-
 * thread long tasks during the take, the granted track settings,
 * the selected codec + recorder bitrates and the user agent. On
 * completion the owner gets a plain-words summary on screen, a
 * downloadable JSON report and the clip itself as a file.
 *
 * AUDIT F07 labelling rule, enforced in every string this module
 * builds: the rVFC frame stats are VIEWFINDER frames (frames the
 * preview element presented). They are never presented as file
 * frames — the recorded file's own frame timing is measured later
 * from the saved clip.
 *
 * Pure logic + injectable platform seams, unit-tested. $0: no deps.
 */

import { askedVsGrantedLine, resolutionLabelForShortSide } from './captureReceipt';
import type { FacingCensus } from './deviceProfile';
import type { RawFrameSeries } from './frameDrops';

/* ------------------------------------------------------------------ */
/* The guided script                                                   */
/* ------------------------------------------------------------------ */

export interface DiagnosticsPhase {
  id: 'still' | 'pan' | 'walk';
  /** Short phase name for the indicator. */
  label: string;
  /** The on-screen instruction for this phase. */
  prompt: string;
  seconds: number;
}

/** The fixed 60-second script: hold still 10s, slow pan 20s, walk 30s. */
export const DIAGNOSTICS_PHASES: readonly DiagnosticsPhase[] = [
  { id: 'still', label: 'Hold still', prompt: 'Hold the phone still and point it at the room', seconds: 10 },
  { id: 'pan', label: 'Slow pan', prompt: 'Pan slowly across the room, one slow sweep', seconds: 20 },
  { id: 'walk', label: 'Walk', prompt: 'Walk slowly around the room with the phone up', seconds: 30 },
];

export const DIAGNOSTICS_TOTAL_SECONDS = DIAGNOSTICS_PHASES.reduce((sum, p) => sum + p.seconds, 0);

/** The phase in force at `elapsedSeconds` into the script (the last phase once the script is done). */
export function diagnosticsPhaseAt(elapsedSeconds: number): { phase: DiagnosticsPhase; index: number; secondsLeftInPhase: number } {
  const elapsed = typeof elapsedSeconds === 'number' && Number.isFinite(elapsedSeconds) && elapsedSeconds > 0 ? elapsedSeconds : 0;
  let acc = 0;
  for (let i = 0; i < DIAGNOSTICS_PHASES.length; i += 1) {
    const phase = DIAGNOSTICS_PHASES[i];
    if (elapsed < acc + phase.seconds) {
      return { phase, index: i, secondsLeftInPhase: Math.ceil(acc + phase.seconds - elapsed) };
    }
    acc += phase.seconds;
  }
  const last = DIAGNOSTICS_PHASES[DIAGNOSTICS_PHASES.length - 1];
  return { phase: last, index: DIAGNOSTICS_PHASES.length - 1, secondsLeftInPhase: 0 };
}

/* ------------------------------------------------------------------ */
/* Frame-interval stats (VIEWFINDER frames)                            */
/* ------------------------------------------------------------------ */

/**
 * Tolerance for "on time": an interval counts as within tolerance
 * when it lands within ±25% of the target interval. At 60fps the
 * target gap is ~16.7ms, so 12.5–20.8ms counts; a duplicated frame
 * (~33ms) or a dropped-frame gap (~50ms+) does not. The summary
 * states this tolerance in plain words wherever the % is shown.
 */
export const FRAME_INTERVAL_TOLERANCE_FRACTION = 0.25;

export interface FrameIntervalStats {
  /** Frames in the series. */
  frameCount: number;
  /** Intervals measured (frameCount − 1). */
  intervalCount: number;
  /** Median interval between presented frames, ms (1 decimal). */
  medianIntervalMs: number;
  /** The target interval for the take's frame rate, ms (1 decimal). */
  targetIntervalMs: number;
  /** Share of intervals within tolerance of the target, 0–100 (1 decimal). */
  withinTolerancePercent: number;
  /** The longest single gap between presented frames, ms (1 decimal). */
  longestGapMs: number;
  /** The tolerance used, as a fraction of the target interval. */
  toleranceFraction: number;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Interval stats for one raw timestamp series at a target frame
 * rate. Null when no honest stats exist: fewer than two usable
 * timestamps, non-increasing timestamps, or an unusable target.
 */
export function computeFrameIntervalStats(
  timestampsMs: readonly number[],
  targetFps: number,
  toleranceFraction: number = FRAME_INTERVAL_TOLERANCE_FRACTION,
): FrameIntervalStats | null {
  if (typeof targetFps !== 'number' || !Number.isFinite(targetFps) || targetFps <= 0) return null;
  const usable = (timestampsMs ?? []).filter((t) => typeof t === 'number' && Number.isFinite(t));
  if (usable.length < 2) return null;
  const intervals: number[] = [];
  for (let i = 1; i < usable.length; i += 1) {
    const delta = usable[i] - usable[i - 1];
    if (delta > 0) intervals.push(delta);
  }
  if (intervals.length === 0) return null;
  const targetIntervalMs = 1000 / targetFps;
  const tolerance = targetIntervalMs * toleranceFraction;
  const sorted = [...intervals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const within = intervals.filter((d) => Math.abs(d - targetIntervalMs) <= tolerance).length;
  return {
    frameCount: usable.length,
    intervalCount: intervals.length,
    medianIntervalMs: round1(median),
    targetIntervalMs: round1(targetIntervalMs),
    withinTolerancePercent: round1((within / intervals.length) * 100),
    longestGapMs: round1(Math.max(...intervals)),
    toleranceFraction,
  };
}

/* ------------------------------------------------------------------ */
/* Long tasks                                                          */
/* ------------------------------------------------------------------ */

export interface LongtaskEntryLike {
  startTime: number;
  duration: number;
}

export interface LongtaskSummary {
  /** False when the browser exposed no longtask entries at all (unsupported or none observed via the API). */
  available: boolean;
  count: number;
  /** How many entries ran over 200ms — the R41 pass-bar threshold. */
  over200Count: number;
  longestMs: number;
  entries: LongtaskEntryLike[];
}

/** Summarise raw longtask entries (durations in ms). Unusable entries are dropped, never repaired. */
export function summarizeLongtasks(entries: readonly LongtaskEntryLike[] | null | undefined, available: boolean): LongtaskSummary {
  const clean = (entries ?? [])
    .filter((e) => e && typeof e.duration === 'number' && Number.isFinite(e.duration) && e.duration >= 0)
    .map((e) => ({
      startTime: typeof e.startTime === 'number' && Number.isFinite(e.startTime) ? Math.round(e.startTime) : 0,
      duration: Math.round(e.duration),
    }));
  return {
    available: !!available,
    count: clean.length,
    over200Count: clean.filter((e) => e.duration > 200).length,
    longestMs: clean.length > 0 ? Math.max(...clean.map((e) => e.duration)) : 0,
    entries: clean,
  };
}

/** The structural slice of `PerformanceObserver` the collector needs. */
export interface PerformanceObserverLike {
  observe: (opts: { entryTypes: string[] }) => void;
  disconnect: () => void;
}

export interface LongtaskCollector {
  /** True when observation actually started (API + entry type supported). */
  readonly available: boolean;
  start: () => void;
  /** Stop observing and return the summary. `available` is false when unsupported — recorded as such, never faked. */
  stop: () => LongtaskSummary;
}

/**
 * Collect `longtask` entries during one take only. The observer
 * factory + supported-entry-types list are injected (the component
 * passes the platform's); anything unsupported yields a collector
 * whose summary says "not available".
 */
export function createLongtaskCollector(deps: {
  createObserver?: ((callback: (list: { getEntries: () => unknown[] }) => void) => PerformanceObserverLike | null) | null;
  supportedEntryTypes?: readonly string[] | null;
}): LongtaskCollector {
  const entries: LongtaskEntryLike[] = [];
  let observer: PerformanceObserverLike | null = null;
  let live = false;
  const supported = !!deps.createObserver && !!deps.supportedEntryTypes && deps.supportedEntryTypes.includes('longtask');
  return {
    get available() {
      return live;
    },
    start() {
      if (live || !supported) return;
      try {
        observer = deps.createObserver!((list) => {
          try {
            for (const entry of list.getEntries() as LongtaskEntryLike[]) {
              if (entry && typeof entry.duration === 'number') {
                entries.push({ startTime: entry.startTime, duration: entry.duration });
              }
            }
          } catch {
            // A malformed entry batch costs those entries only.
          }
        });
        if (!observer) {
          live = false;
          return;
        }
        observer.observe({ entryTypes: ['longtask'] });
        live = true;
      } catch {
        observer = null;
        live = false;
      }
    },
    stop() {
      if (observer) {
        try {
          observer.disconnect();
        } catch {
          // Best-effort detach only.
        }
        observer = null;
      }
      const wasLive = live;
      live = false;
      return summarizeLongtasks(entries, wasLive);
    },
  };
}

/* ------------------------------------------------------------------ */
/* The evidence pack                                                   */
/* ------------------------------------------------------------------ */

export interface DiagnosticsEvidenceInput {
  createdAt: string;
  userAgent: string;
  facing: 'user' | 'environment';
  qualityChoice: string;
  fpsChoice: number;
  durationSeconds: number;
  asked: { shortSide: number; frameRate: number; width: number; height: number } | null;
  granted: { width: number; height: number; frameRate: number } | null;
  exactRetryAttempted: boolean;
  exactRetryUsed: boolean;
  mimeType: string;
  recorderVideoBitsPerSecond: number;
  recorderAudioBitsPerSecond: number;
  census: FacingCensus | null;
  frameSeries: RawFrameSeries;
  longtasks: LongtaskSummary;
}

export interface DiagnosticsEvidencePack {
  kind: 'riddimroom-camera-diagnostics';
  version: 1;
  createdAt: string;
  userAgent: string;
  facing: 'user' | 'environment';
  qualityChoice: string;
  fpsChoice: number;
  scriptSeconds: number;
  durationSeconds: number;
  asked: DiagnosticsEvidenceInput['asked'];
  granted: { width: number; height: number; frameRate: number; shortSide: number } | null;
  exactRetryAttempted: boolean;
  exactRetryUsed: boolean;
  recorder: { mimeType: string; videoBitsPerSecond: number; audioBitsPerSecond: number };
  census: FacingCensus | null;
  /** VIEWFINDER frames (preview element, via rVFC) — NOT the recorded file's frames. */
  viewfinderFrames: {
    source: 'viewfinder-preview-requestVideoFrameCallback';
    timestampsMs: number[];
    presentedFrames: number[];
    stats: FrameIntervalStats | null;
  };
  longtasks: LongtaskSummary;
  notes: string[];
}

/** Assemble the downloadable evidence pack from one finished diagnostics take. */
export function buildDiagnosticsEvidencePack(input: DiagnosticsEvidenceInput): DiagnosticsEvidencePack {
  const grantedShort =
    input.granted && input.granted.width > 0 && input.granted.height > 0
      ? Math.min(input.granted.width, input.granted.height)
      : 0;
  const targetFps =
    input.granted && input.granted.frameRate > 0 ? Math.round(input.granted.frameRate) : input.fpsChoice;
  const stats = computeFrameIntervalStats(input.frameSeries?.timestampsMs ?? [], targetFps);
  return {
    kind: 'riddimroom-camera-diagnostics',
    version: 1,
    createdAt: input.createdAt,
    userAgent: input.userAgent,
    facing: input.facing,
    qualityChoice: input.qualityChoice,
    fpsChoice: input.fpsChoice,
    scriptSeconds: DIAGNOSTICS_TOTAL_SECONDS,
    durationSeconds: Math.round((input.durationSeconds ?? 0) * 10) / 10,
    asked: input.asked,
    granted: input.granted
      ? { width: input.granted.width, height: input.granted.height, frameRate: input.granted.frameRate, shortSide: grantedShort }
      : null,
    exactRetryAttempted: !!input.exactRetryAttempted,
    exactRetryUsed: !!input.exactRetryUsed,
    recorder: {
      mimeType: input.mimeType ?? '',
      videoBitsPerSecond: input.recorderVideoBitsPerSecond ?? 0,
      audioBitsPerSecond: input.recorderAudioBitsPerSecond ?? 0,
    },
    census: input.census ?? null,
    viewfinderFrames: {
      source: 'viewfinder-preview-requestVideoFrameCallback',
      timestampsMs: [...(input.frameSeries?.timestampsMs ?? [])],
      presentedFrames: [...(input.frameSeries?.presentedFrames ?? [])],
      stats,
    },
    longtasks: input.longtasks,
    notes: [
      'Frame stats are VIEWFINDER frames: frames the preview element presented (requestVideoFrameCallback). They are not the recorded file frames — the file is measured separately from the saved clip.',
      'Long tasks are main-thread tasks observed during the take only.',
      'Nothing in this report was uploaded anywhere; it exists only where the owner saves it.',
    ],
  };
}

/** The JSON text of the downloadable report. */
export function diagnosticsReportJson(pack: DiagnosticsEvidencePack): string {
  return JSON.stringify(pack, null, 2);
}

/**
 * The on-screen plain-words summary lines for a finished pack.
 * Frame numbers are labelled as viewfinder frames in the lines
 * themselves (AUDIT F07) and the tolerance is stated wherever the
 * on-time share appears.
 */
export function formatDiagnosticsSummary(pack: DiagnosticsEvidencePack): string[] {
  const lines: string[] = [];
  const askedLine = askedVsGrantedLine(
    pack.asked ? { shortSide: pack.asked.shortSide, frameRate: pack.asked.frameRate } : null,
    pack.granted ? { shortSide: pack.granted.shortSide, frameRate: pack.granted.frameRate } : null,
  );
  if (askedLine) lines.push(askedLine);
  else if (pack.granted) {
    const label = resolutionLabelForShortSide(pack.granted.shortSide);
    if (label) lines.push(`Phone gave: ${label} · ${Math.round(pack.granted.frameRate)}`);
  }
  const stats = pack.viewfinderFrames.stats;
  if (stats) {
    lines.push(`Typical gap between viewfinder frames: ${stats.medianIntervalMs} ms (target ${stats.targetIntervalMs} ms)`);
    lines.push(
      `Viewfinder frames on time: ${stats.withinTolerancePercent}% (within ${Math.round(stats.toleranceFraction * 100)}% of the target gap)`,
    );
    lines.push(`Longest viewfinder gap: ${stats.longestGapMs} ms`);
  } else {
    lines.push('Viewfinder frame timing was not available in this browser');
  }
  if (pack.longtasks.available) {
    lines.push(
      `Pauses during the take: ${pack.longtasks.count} long task${pack.longtasks.count === 1 ? '' : 's'}, ${pack.longtasks.over200Count} over 200 ms`,
    );
  } else {
    lines.push('Long-task measurement: not available in this browser');
  }
  lines.push('These frame numbers come from the viewfinder preview, not the recorded file.');
  return lines;
}
