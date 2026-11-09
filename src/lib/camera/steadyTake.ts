/**
 * R41 Step 3 Rung B — CFR normalisation at import (the long-deferred
 * WS-4 Phase 3).
 *
 * MediaRecorder takes are variable-frame-rate files: on the owner's
 * S25 Ultra the measured defect is discrete whole-frame misses on an
 * otherwise exact cadence (~94.5–94.7% of frame intervals within
 * ±25% of the 33.33ms grid, effective ~28fps against a 30 grant —
 * see ANALYSIS-R41-Diagnostics-Evidence.md). No capture-side fix
 * retro-fixes a VFR file, so when a camera take is saved into a
 * project it is re-timed here onto a CONSTANT frame-rate grid at its
 * granted fps: missed beats are filled by holding the prior frame,
 * catch-up bursts are thinned, the grid is anchored at the first
 * frame's own timestamp (audio passes through untouched, so sync is
 * preserved), and the total duration is preserved — no speed change.
 *
 * Layers, deliberately separated:
 * - `assessFrameTiming` / `planCfrRetiming` are PURE functions over a
 *   timestamp series — the re-timing decision logic itself. They run
 *   identically in the app and offline (the offline proof over the
 *   owner's real clips exercises exactly these functions).
 * - `createCfrSampleRetimer` turns a plan into the per-sample mapping
 *   the encode pipeline applies (source frames arrive in presentation
 *   order; each is emitted 0..n times at its grid slots).
 * - `steadyCameraTake` is the browser pipeline: it probes the take's
 *   packet timestamps by DEMUXING ONLY (streamed, no decode), plans,
 *   then runs one Mediabunny Conversion whose video `process` hook is
 *   the retimer. Frames flow one at a time through WebCodecs; the
 *   muxed output streams to an OPFS temp file (disk, not RAM) when
 *   the platform offers one, else to Mediabunny's BufferTarget — the
 *   same in-memory assembly the shipped export engine already uses.
 *
 * NEVER LOSE A TAKE: any failure — no WebCodecs, an unreadable take,
 * a conversion the platform declines, an error mid-flight — resolves
 * with the ORIGINAL blob and an honest reason. This function never
 * throws.
 *
 * The diagnostics "Save the test clip" path does NOT pass through
 * here: it keeps delivering the raw recorded file, untouched, because
 * that file is the measurement instrument for capture truth.
 *
 * $0 rule: Mediabunny is already a dependency (export engine); no
 * new dependencies, no network.
 */

/* ------------------------------------------------------------------ */
/* Pure timing assessment + retiming plan                              */
/* ------------------------------------------------------------------ */

/** Share of in-tolerance intervals at/above which a take already counts as even — steadying it would only cost a re-encode. */
export const STEADY_EVEN_THRESHOLD_PERCENT = 99;

/** Tolerance band of the house frame-timing metric: ±25% of the target interval (the diagnostics packs' own band). */
export const CFR_TOLERANCE_FRACTION = 0.25;

export interface CfrTimingAssessment {
  /** Frames in the series. */
  frameCount: number;
  /** Intervals counted (positive deltas only — duplicate timestamps carry no timing information). */
  intervalCount: number;
  /** Median positive interval, ms (0 when unmeasurable). */
  medianIntervalMs: number;
  /** The target interval for the assessed rate, ms. */
  targetIntervalMs: number;
  /** Share of positive intervals within ±25% of the target interval, percent. */
  withinTolerancePercent: number;
  /** Longest positive interval, ms. */
  longestGapMs: number;
  /** (frames − 1) ÷ span, fps (0 when unmeasurable). */
  effectiveFps: number;
}

function cleanTimestamps(timestampsSec: readonly number[]): number[] {
  return timestampsSec
    .filter((t) => typeof t === 'number' && Number.isFinite(t))
    .slice()
    .sort((a, b) => a - b);
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Positive deltas of an ascending series. */
function positiveIntervalsSec(sorted: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i] - sorted[i - 1];
    if (d > 0) out.push(d);
  }
  return out;
}

/**
 * Measure a frame timestamp series against a target rate, with the
 * same metric the diagnostics packs publish (positive intervals,
 * ±25% band, median, longest gap).
 */
export function assessFrameTiming(timestampsSec: readonly number[], targetFps: number): CfrTimingAssessment {
  const sorted = cleanTimestamps(timestampsSec);
  const targetIntervalMs = targetFps > 0 && Number.isFinite(targetFps) ? 1000 / targetFps : 0;
  const intervals = positiveIntervalsSec(sorted);
  if (sorted.length < 2 || intervals.length === 0 || targetIntervalMs <= 0) {
    return {
      frameCount: sorted.length,
      intervalCount: intervals.length,
      medianIntervalMs: 0,
      targetIntervalMs,
      withinTolerancePercent: 0,
      longestGapMs: 0,
      effectiveFps: 0,
    };
  }
  const band = targetIntervalMs * CFR_TOLERANCE_FRACTION;
  const within = intervals.filter((d) => Math.abs(d * 1000 - targetIntervalMs) <= band).length;
  const spanSec = sorted[sorted.length - 1] - sorted[0];
  return {
    frameCount: sorted.length,
    intervalCount: intervals.length,
    medianIntervalMs: medianOf(intervals) * 1000,
    targetIntervalMs,
    withinTolerancePercent: (within / intervals.length) * 100,
    longestGapMs: Math.max(...intervals) * 1000,
    effectiveFps: spanSec > 0 ? (sorted.length - 1) / spanSec : 0,
  };
}

export interface CfrRetimingPlan {
  /** The constant rate of the output grid, fps. */
  targetFps: number;
  /** The grid's anchor: the first source frame's own timestamp (seconds), so A/V sync is preserved exactly. */
  startSec: number;
  /** 1 / targetFps. */
  frameDurationSec: number;
  /** Output frame count (grid slots). */
  frameCount: number;
  /** Per output slot: the source frame index shown there. */
  sourceIndexForSlot: number[];
  /** Per source frame: how many output slots show it (0 = thinned, 1 = kept, >1 = held). */
  holdsPerSource: number[];
  /** Per source frame: its first output slot (−1 when thinned). */
  firstSlotForSource: number[];
  /** Output slots beyond the first that re-show a source frame (the filled misses). */
  duplicatedSlots: number;
  /** Source frames shown at no slot (the thinned catch-up bursts). */
  thinnedSourceFrames: number;
  /** Output duration: frameCount ÷ targetFps, seconds. */
  durationSec: number;
  /** The input series' own assessment at the target rate. */
  assessment: CfrTimingAssessment;
}

/** Grid-assignment epsilon: a frame landing within 1ms after a slot belongs to that slot (float dust, not a timing judgement). */
const SLOT_EPSILON_SEC = 0.001;

/**
 * Plan the re-timing of one take's frame series onto a constant-rate
 * grid. Slot k shows the LATEST source frame stamped at or before
 * the slot's time — a miss becomes a held frame, a burst loses its
 * extra frames, and the ~0.2s head stall measured on the owner's
 * takes becomes a hold of the first frame (nothing is trimmed). The
 * output span matches the input span plus one median frame duration
 * (the last frame's own showing time), so duration is preserved.
 */
export function planCfrRetiming(timestampsSec: readonly number[], targetFps: number): CfrRetimingPlan {
  const sorted = cleanTimestamps(timestampsSec);
  const fps = typeof targetFps === 'number' && Number.isFinite(targetFps) && targetFps > 0 ? targetFps : 30;
  const frameDurationSec = 1 / fps;
  const assessment = assessFrameTiming(sorted, fps);
  if (sorted.length === 0) {
    return {
      targetFps: fps,
      startSec: 0,
      frameDurationSec,
      frameCount: 0,
      sourceIndexForSlot: [],
      holdsPerSource: [],
      firstSlotForSource: [],
      duplicatedSlots: 0,
      thinnedSourceFrames: 0,
      durationSec: 0,
      assessment,
    };
  }
  const startSec = sorted[0];
  const intervals = positiveIntervalsSec(sorted);
  const medianIntervalSec = intervals.length > 0 ? medianOf(intervals) : frameDurationSec;
  // The last frame shows for about one typical interval; clamp the
  // estimate so a pathological tail can't stretch the take.
  const lastFrameSec = Math.min(Math.max(medianIntervalSec, frameDurationSec * 0.25), 0.25);
  const endSec = sorted[sorted.length - 1] + lastFrameSec;
  const frameCount = Math.max(1, Math.round((endSec - startSec) * fps));

  const sourceIndexForSlot: number[] = new Array(frameCount);
  const holdsPerSource: number[] = new Array(sorted.length).fill(0);
  const firstSlotForSource: number[] = new Array(sorted.length).fill(-1);
  let source = 0;
  for (let slot = 0; slot < frameCount; slot++) {
    const slotTime = startSec + slot * frameDurationSec;
    while (source + 1 < sorted.length && sorted[source + 1] <= slotTime + SLOT_EPSILON_SEC) {
      source += 1;
    }
    sourceIndexForSlot[slot] = source;
    holdsPerSource[source] += 1;
    if (firstSlotForSource[source] === -1) firstSlotForSource[source] = slot;
  }
  let duplicatedSlots = 0;
  let thinnedSourceFrames = 0;
  for (const holds of holdsPerSource) {
    if (holds > 1) duplicatedSlots += holds - 1;
    if (holds === 0) thinnedSourceFrames += 1;
  }
  return {
    targetFps: fps,
    startSec,
    frameDurationSec,
    frameCount,
    sourceIndexForSlot,
    holdsPerSource,
    firstSlotForSource,
    duplicatedSlots,
    thinnedSourceFrames,
    durationSec: frameCount * frameDurationSec,
    assessment,
  };
}

/** True when the plan's input assessment says the take's timing needs steadying (below the even threshold). */
export function planNeedsSteadying(plan: CfrRetimingPlan): boolean {
  return plan.frameCount > 0 && plan.assessment.withinTolerancePercent < STEADY_EVEN_THRESHOLD_PERCENT;
}

/* ------------------------------------------------------------------ */
/* The per-sample retimer (the plan, applied inside the encode)        */
/* ------------------------------------------------------------------ */

/** The structural slice of a decoded video sample the retimer touches (Mediabunny's VideoSample satisfies it). */
export interface CfrRetimableSample {
  timestamp: number;
  duration: number;
  setTimestamp(nextSeconds: number): void;
  setDuration(nextSeconds: number): void;
  clone(): CfrRetimableSample;
}

/**
 * Build the stateful mapper the conversion's `process` hook runs:
 * samples arrive in presentation order (the same order the plan was
 * built from — the probe's packet timestamps, sorted), and each is
 * returned 0..n times: dropped (null) when the plan thins it, once
 * at its grid slot when kept, or repeated across its held slots.
 * Every returned sample is stamped exactly on the grid.
 */
export function createCfrSampleRetimer(
  plan: CfrRetimingPlan,
): (sample: CfrRetimableSample) => CfrRetimableSample[] | null {
  let nextSourceIndex = 0;
  return (sample) => {
    const sourceIndex = nextSourceIndex;
    nextSourceIndex += 1;
    if (sourceIndex >= plan.holdsPerSource.length) return null;
    const holds = plan.holdsPerSource[sourceIndex];
    if (holds <= 0) return null;
    const firstSlot = plan.firstSlotForSource[sourceIndex];
    const out: CfrRetimableSample[] = [];
    for (let s = 0; s < holds; s++) {
      const piece = s === 0 ? sample : sample.clone();
      piece.setTimestamp(plan.startSec + (firstSlot + s) * plan.frameDurationSec);
      piece.setDuration(plan.frameDurationSec);
      out.push(piece);
    }
    return out;
  };
}

/* ------------------------------------------------------------------ */
/* The browser pipeline                                                */
/* ------------------------------------------------------------------ */

type MediabunnyModule = typeof import('mediabunny');

/** A streaming output sink for the conversion: Mediabunny target + how to collect the finished file. */
export interface SteadyOutputSink {
  target: InstanceType<MediabunnyModule['StreamTarget']> | InstanceType<MediabunnyModule['BufferTarget']>;
  /** The finished output as a Blob (valid only after the conversion executed). */
  finish: () => Promise<Blob>;
  /** Best-effort removal of any backing temp file. */
  cleanup: () => Promise<void>;
}

export interface SteadyTakeDeps {
  /** WebCodecs presence (VideoEncoder + VideoDecoder) — the capability gate's first leg. */
  webCodecsPresent: () => boolean;
  /** Lazy library load (dynamic import in production; a fake in tests). */
  loadMediabunny: () => Promise<MediabunnyModule>;
  /**
   * Open a streaming output sink. The production default prefers an
   * OPFS temp file (disk-backed, swept at the next call) and falls
   * back to Mediabunny's BufferTarget. Null forces BufferTarget.
   */
  openSink: (mb: MediabunnyModule) => Promise<SteadyOutputSink | null>;
}

function defaultWebCodecsPresent(): boolean {
  const g = globalThis as { VideoEncoder?: unknown; VideoDecoder?: unknown };
  return typeof g.VideoEncoder === 'function' && typeof g.VideoDecoder === 'function';
}

const OPFS_TEMP_PREFIX = 'riddimroom-steady-';

/** Sweep temp files left by earlier steadying runs (their Files were consumed by the saves that made them). */
async function sweepStaleSteadyTempFiles(root: FileSystemDirectoryHandle): Promise<void> {
  try {
    const dir = root as unknown as {
      keys?: () => AsyncIterable<string>;
      removeEntry: (name: string) => Promise<void>;
    };
    if (!dir.keys) return;
    for await (const name of dir.keys()) {
      if (typeof name === 'string' && name.startsWith(OPFS_TEMP_PREFIX)) {
        await dir.removeEntry(name).catch(() => undefined);
      }
    }
  } catch {
    // Sweeping is housekeeping only — never a reason to fail a take.
  }
}

async function openOpfsSink(mb: MediabunnyModule): Promise<SteadyOutputSink | null> {
  try {
    const storage = (globalThis as { navigator?: Navigator }).navigator?.storage as
      | (StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> })
      | undefined;
    if (!storage?.getDirectory) return null;
    const root = await storage.getDirectory();
    await sweepStaleSteadyTempFiles(root);
    const name = `${OPFS_TEMP_PREFIX}${Date.now()}-${Math.floor(Math.random() * 1e9)}.tmp`;
    const handle = await root.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    return {
      target: new mb.StreamTarget(
        writable as unknown as WritableStream<import('mediabunny').StreamTargetChunk>,
      ),
      finish: async () => (await handle.getFile()) as Blob,
      cleanup: async () => {
        try {
          await root.removeEntry(name);
        } catch {
          // Already gone (or swept) — fine.
        }
      },
    };
  } catch {
    return null;
  }
}

function bufferSink(mb: MediabunnyModule, mimeType: string): SteadyOutputSink {
  const target = new mb.BufferTarget();
  return {
    target,
    finish: async () => {
      const buffer = target.buffer;
      if (!buffer) throw new Error('steadying produced no output');
      return new Blob([buffer], { type: mimeType });
    },
    cleanup: async () => undefined,
  };
}

const defaultDeps: SteadyTakeDeps = {
  webCodecsPresent: defaultWebCodecsPresent,
  loadMediabunny: () => import('mediabunny'),
  openSink: openOpfsSink,
};

export type SteadyTakeResult =
  | {
      status: 'steadied';
      /** The re-timed take (a new file; the recorded original is untouched wherever the caller holds it). */
      blob: Blob;
      plan: CfrRetimingPlan;
    }
  | {
      status: 'original';
      /** The take exactly as recorded — returned on every decline or failure, so a take is never lost. */
      blob: Blob;
      reason: 'unsupported' | 'unreadable' | 'already-even' | 'declined' | 'failed';
      /** The plan, when the take was probed far enough to build one. */
      plan?: CfrRetimingPlan;
    };

/** The target rate: the caller's granted fps when sane, else the rate the take's own median interval proves. */
function resolveTargetFps(requested: number | undefined, timestampsSec: readonly number[]): number {
  if (typeof requested === 'number' && Number.isFinite(requested) && requested >= 5 && requested <= 120) {
    return requested;
  }
  const sorted = cleanTimestamps(timestampsSec);
  const intervals = positiveIntervalsSec(sorted);
  const medianMs = medianOf(intervals) * 1000;
  if (medianMs > 0) {
    const derived = Math.round((1000 / medianMs) * 100) / 100;
    return Math.min(120, Math.max(5, derived));
  }
  return 30;
}

/**
 * Steady one recorded camera take to a constant frame rate at its
 * granted fps. Resolves with the re-timed blob, or with the ORIGINAL
 * blob and the reason whenever steadying is unavailable, declined or
 * fails — never throws, never loses the take.
 */
export async function steadyCameraTake(
  blob: Blob,
  options?: { targetFps?: number; onProgress?: (ratio: number) => void },
  deps: SteadyTakeDeps = defaultDeps,
): Promise<SteadyTakeResult> {
  const original = (reason: 'unsupported' | 'unreadable' | 'already-even' | 'declined' | 'failed', plan?: CfrRetimingPlan): SteadyTakeResult => ({
    status: 'original',
    blob,
    reason,
    ...(plan ? { plan } : {}),
  });
  try {
    if (!blob || blob.size === 0) return original('unreadable');
    if (!deps.webCodecsPresent()) return original('unsupported');
    const mb = await deps.loadMediabunny();

    /* Probe — demux only: the take's video packet timestamps + byte
       total, streamed packet by packet (no decode, no full buffer). */
    const probeInput = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
    const videoTrack = await probeInput.getPrimaryVideoTrack();
    if (!videoTrack) return original('unreadable');
    const timestamps: number[] = [];
    let videoBytes = 0;
    const packetSink = new mb.EncodedPacketSink(videoTrack);
    for await (const packet of packetSink.packets()) {
      timestamps.push(packet.timestamp);
      videoBytes += packet.data.byteLength;
    }
    if (timestamps.length < 2) return original('unreadable');

    const targetFps = resolveTargetFps(options?.targetFps, timestamps);
    const plan = planCfrRetiming(timestamps, targetFps);
    if (!planNeedsSteadying(plan)) return original('already-even', plan);

    const spanSec = timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
    const measuredVideoBitrate = spanSec > 0 ? Math.round((videoBytes * 8) / spanSec) : 0;
    const wantsWebm = (blob.type || '').toLowerCase().includes('webm');
    const inputCodec = (videoTrack as { codec?: string | null }).codec ?? null;

    /* One conversion attempt against one sink. A fresh Input per
       attempt — a failed conversion may leave its input in an
       unknown state, and the retry must start clean. */
    const runAttempt = async (sink: SteadyOutputSink): Promise<Blob> => {
      const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error('steadying probe lost the video track');
      const audioTrack = await input.getPrimaryAudioTrack();
      const output = new mb.Output({
        format: wantsWebm ? new mb.WebMOutputFormat() : new mb.Mp4OutputFormat(),
        target: sink.target,
      });
      const conversion = await mb.Conversion.init({
        input,
        output,
        video: {
          forceTranscode: true,
          ...(inputCodec ? { codec: inputCodec as import('mediabunny').VideoCodec } : {}),
          ...(measuredVideoBitrate > 0 ? { bitrate: measuredVideoBitrate } : {}),
          process: createCfrSampleRetimer(plan) as unknown as import('mediabunny').ConversionVideoOptions['process'],
        },
        audio: {},
        showWarnings: false,
      });
      if (!conversion.isValid) throw new Error('steadying conversion declined by the platform');
      if (!conversion.utilizedTracks.includes(track)) throw new Error('steadying conversion dropped the video track');
      // Never trade the take's sound for steadier pictures.
      if (audioTrack && conversion.discardedTracks.some((d) => d.track === audioTrack)) {
        throw new Error('steadying conversion dropped the audio track');
      }
      if (options?.onProgress) {
        conversion.onProgress = (ratio) => options.onProgress?.(ratio);
      }
      await conversion.execute();
      return sink.finish();
    };

    /* Attempt 1: the streaming sink (OPFS when offered). Attempt 2:
       the in-memory target — the assembly the export engine already
       ships. Any failure after that: the original take. The output
       blob is re-wrapped (no copy) so it always carries the media
       type — an OPFS temp File has none. */
    const outType = wantsWebm ? 'video/webm' : 'video/mp4';
    const typed = (out: Blob): Blob => (out.type === outType ? out : new Blob([out], { type: outType }));
    const sink = await deps.openSink(mb);
    if (sink) {
      try {
        const out = await runAttempt(sink);
        return { status: 'steadied', blob: typed(out), plan };
      } catch {
        await sink.cleanup().catch(() => undefined);
      }
    }
    try {
      const out = await runAttempt(bufferSink(mb, outType));
      return { status: 'steadied', blob: typed(out), plan };
    } catch {
      return original('failed', plan);
    }
  } catch {
    return original('failed');
  }
}
