/**
 * R41 WS-D — first-party ANALYTICS health panel, client side.
 *
 * Extends R40 P-28 (failure counts) into a permanent health panel:
 * counts and coarse buckets ONLY — how camera takes turned out, how
 * many exports and saves SUCCEEDED, how janky sessions felt (longtask
 * buckets), and which doors people open. Never any words, clips,
 * project contents, device identifiers or per-user trails: every send
 * is one aggregate event that lands in the same per-day document as
 * the failure counts (see api/_lib.ts recordHealthEvent).
 *
 * Fire-and-forget exactly like recordFailure: silent on failure,
 * never awaited by the user's flow, a no-op without an id token.
 */

import { shortSideClassFor, type CaptureShortSideClass } from './camera/deviceProfile';
import { DROPPED_FRAMES_WARNING_FRACTION, type FrameDropEstimate } from './camera/frameDrops';
import type { CaptureReceipt } from './camera/captureReceipt';

export type HealthEventType = 'take' | 'export' | 'save' | 'session' | 'door';

export type TakeTierBucket = CaptureShortSideClass;
export type FpsBucket = '60' | '30' | 'other' | 'unknown';
export type DropBucket = 'none' | 'low' | 'high' | 'unknown';
export type TakeDurationBucket = 'under15' | '15to60' | 'over60';
export type ExportDurationBucket = 'under10' | '10to60' | 'over60';
export type SessionTotalBucket = '0' | '1to5' | '6plus';
export type SessionOver200Bucket = '0' | '1plus';
export type DoorName = 'promo' | 'editor' | 'poster' | 'camera';

export interface HealthEvent {
  type: HealthEventType;
  buckets: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* Pure bucket derivation                                              */
/* ------------------------------------------------------------------ */

/** Granted tier bucket for an achieved short side (the shared size classes). */
export function takeTierBucket(shortSide: number): TakeTierBucket {
  return shortSideClassFor(shortSide);
}

/** Granted fps bucket: near-60 → '60', near-30 → '30', any other real rate → 'other'. */
export function fpsBucket(fps: number | null | undefined): FpsBucket {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) return 'unknown';
  if (Math.abs(fps - 60) <= 2) return '60';
  if (Math.abs(fps - 30) <= 2) return '30';
  return 'other';
}

/**
 * Drop bucket from a dropped-frame fraction. 'none' aligns with the
 * review warning's relative arm (≤ DROPPED_FRAMES_WARNING_FRACTION);
 * 'low' is ≤10%; 'high' is above that; unmeasured → 'unknown'.
 */
export function dropBucketForFraction(fraction: number | null | undefined): DropBucket {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0) return 'unknown';
  if (fraction <= DROPPED_FRAMES_WARNING_FRACTION) return 'none';
  if (fraction <= 0.1) return 'low';
  return 'high';
}

/** Drop bucket from a frame-drop estimate (null / unusable → 'unknown', never invented). */
export function dropBucketForEstimate(estimate: FrameDropEstimate | null | undefined): DropBucket {
  if (!estimate || typeof estimate.expectedFrames !== 'number' || !(estimate.expectedFrames > 0)) {
    return 'unknown';
  }
  return dropBucketForFraction(estimate.droppedFramesEstimate / estimate.expectedFrames);
}

export function takeDurationBucket(durationSeconds: number): TakeDurationBucket {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < 15) {
    return 'under15';
  }
  return durationSeconds <= 60 ? '15to60' : 'over60';
}

export function exportDurationBucket(durationSeconds: number): ExportDurationBucket {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < 10) {
    return 'under10';
  }
  return durationSeconds <= 60 ? '10to60' : 'over60';
}

export function sessionTotalBucket(totalLongtasks: number): SessionTotalBucket {
  if (typeof totalLongtasks !== 'number' || !Number.isFinite(totalLongtasks) || totalLongtasks <= 0) return '0';
  return totalLongtasks <= 5 ? '1to5' : '6plus';
}

export function sessionOver200Bucket(over200Count: number): SessionOver200Bucket {
  return typeof over200Count === 'number' && Number.isFinite(over200Count) && over200Count > 0 ? '1plus' : '0';
}

export interface TakeHealthInput {
  shortSide: number;
  fps: number | null | undefined;
  frameDropEstimate: FrameDropEstimate | null | undefined;
  durationSeconds: number;
}

/** The full take-health bucket set for one finished take. */
export function buildTakeBuckets(input: TakeHealthInput): Record<string, string> {
  return {
    tier: takeTierBucket(input.shortSide),
    fps: fpsBucket(input.fps),
    drops: dropBucketForEstimate(input.frameDropEstimate),
    duration: takeDurationBucket(input.durationSeconds),
  };
}

/** Take buckets from a capture receipt (the camera's honest record of a take). */
export function takeBucketsFromReceipt(
  receipt: Pick<
    CaptureReceipt,
    'actualWidth' | 'actualHeight' | 'actualFps' | 'durationSeconds' | 'droppedFramesEstimate' | 'expectedFramesEstimate'
  >,
): Record<string, string> {
  const shortSide =
    receipt.actualWidth > 0 && receipt.actualHeight > 0
      ? Math.min(receipt.actualWidth, receipt.actualHeight)
      : 0;
  const estimate: FrameDropEstimate | null =
    typeof receipt.droppedFramesEstimate === 'number' && typeof receipt.expectedFramesEstimate === 'number'
      ? {
          presentedFrames: Math.max(0, receipt.expectedFramesEstimate - receipt.droppedFramesEstimate),
          expectedFrames: receipt.expectedFramesEstimate,
          droppedFramesEstimate: receipt.droppedFramesEstimate,
        }
      : null;
  return buildTakeBuckets({
    shortSide,
    fps: receipt.actualFps,
    frameDropEstimate: estimate,
    durationSeconds: receipt.durationSeconds,
  });
}

export function buildSessionBuckets(totalLongtasks: number, over200Count: number): Record<string, string> {
  return { total: sessionTotalBucket(totalLongtasks), over200: sessionOver200Bucket(over200Count) };
}

/* ------------------------------------------------------------------ */
/* Sending (fire-and-forget, exactly like recordFailure)               */
/* ------------------------------------------------------------------ */

type Fetcher = (url: string, init: Record<string, unknown>) => Promise<unknown>;

export function recordHealthEvent(
  event: HealthEvent,
  idToken: string | null | undefined,
  fetcher?: Fetcher,
): void {
  if (!idToken || !event || typeof event.type !== 'string') return;
  const send: Fetcher = fetcher ?? ((url, init) => fetch(url, init as RequestInit));
  try {
    void Promise.resolve(
      send('/api/failure-count', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ health: { type: event.type, buckets: event.buckets ?? {} } }),
      }),
    ).catch(() => undefined);
  } catch {
    // Counting must never disturb the flow it measures.
  }
}

export function recordTakeHealth(input: TakeHealthInput, idToken: string | null | undefined, fetcher?: Fetcher): void {
  recordHealthEvent({ type: 'take', buckets: buildTakeBuckets(input) }, idToken, fetcher);
}

export function recordTakeHealthFromReceipt(
  receipt: Pick<
    CaptureReceipt,
    'actualWidth' | 'actualHeight' | 'actualFps' | 'durationSeconds' | 'droppedFramesEstimate' | 'expectedFramesEstimate'
  >,
  idToken: string | null | undefined,
  fetcher?: Fetcher,
): void {
  recordHealthEvent({ type: 'take', buckets: takeBucketsFromReceipt(receipt) }, idToken, fetcher);
}

export function recordExportSuccess(durationSeconds: number, idToken: string | null | undefined, fetcher?: Fetcher): void {
  recordHealthEvent({ type: 'export', buckets: { duration: exportDurationBucket(durationSeconds) } }, idToken, fetcher);
}

export function recordSaveSuccess(idToken: string | null | undefined, fetcher?: Fetcher): void {
  recordHealthEvent({ type: 'save', buckets: {} }, idToken, fetcher);
}

export function recordDoorOpen(door: DoorName, idToken: string | null | undefined, fetcher?: Fetcher): void {
  recordHealthEvent({ type: 'door', buckets: { door } }, idToken, fetcher);
}

/* ------------------------------------------------------------------ */
/* Session longtask collector                                          */
/* ------------------------------------------------------------------ */

interface LongtaskObserverEntry {
  duration: number;
}
interface LongtaskObserverLike {
  observe: (opts: { type: string }) => void;
  disconnect: () => void;
}
type LongtaskObserverCtor = new (
  callback: (list: { getEntries: () => LongtaskObserverEntry[] }) => void,
) => LongtaskObserverLike;

interface FlushTargetLike {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

export interface LongtaskCollector {
  /** Stop observing and detach listeners WITHOUT reporting. */
  disconnect: () => void;
  /** Report the one aggregate session event (idempotent) and stop. */
  flush: () => void;
  snapshot: () => { total: number; over200: number };
}

/**
 * Lightweight longtask collector: one PerformanceObserver, two
 * counters, nothing else. Reports ONE aggregate session event at
 * most — on pagehide (or when the tab first hides) — then disconnects.
 * No-op (returns null) where longtask is unsupported (e.g. Safari):
 * an unmeasured session is never reported as a smooth one.
 */
export function startSessionLongtaskCollector(
  idToken: string | null | undefined,
  opts?: { fetcher?: Fetcher; observerCtor?: LongtaskObserverCtor; target?: FlushTargetLike | null },
): LongtaskCollector | null {
  if (!idToken) return null;
  const Ctor: LongtaskObserverCtor | undefined =
    opts?.observerCtor ??
    (typeof PerformanceObserver !== 'undefined'
      ? (PerformanceObserver as unknown as LongtaskObserverCtor)
      : undefined);
  if (!Ctor) return null;
  try {
    const supported = (Ctor as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes;
    if (Array.isArray(supported) && !supported.includes('longtask')) return null;
  } catch {
    return null;
  }

  let total = 0;
  let over200 = 0;
  let reported = false;
  let stopped = false;
  let observer: LongtaskObserverLike | null = null;
  const target: FlushTargetLike | null =
    opts?.target ??
    (typeof window !== 'undefined'
      ? (window as unknown as FlushTargetLike)
      : null);

  const onHide = () => {
    if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'hidden') {
      return;
    }
    collector.flush();
  };
  const detach = () => {
    if (stopped) return;
    stopped = true;
    try {
      observer?.disconnect();
    } catch {
      /* best effort */
    }
    if (target) {
      try {
        target.removeEventListener('pagehide', onHide);
        target.removeEventListener('visibilitychange', onHide);
      } catch {
        /* best effort */
      }
    }
  };
  const collector: LongtaskCollector = {
    disconnect: detach,
    flush: () => {
      if (reported) return;
      reported = true;
      recordHealthEvent(
        { type: 'session', buckets: buildSessionBuckets(total, over200) },
        idToken,
        opts?.fetcher,
      );
      detach();
    },
    snapshot: () => ({ total, over200 }),
  };

  try {
    observer = new Ctor((list) => {
      for (const entry of list.getEntries()) {
        total += 1;
        if (typeof entry.duration === 'number' && entry.duration > 200) over200 += 1;
      }
    });
    observer.observe({ type: 'longtask' });
  } catch {
    return null;
  }
  if (target) {
    try {
      target.addEventListener('pagehide', onHide);
      target.addEventListener('visibilitychange', onHide);
    } catch {
      /* flush stays available programmatically */
    }
  }
  return collector;
}

/* ------------------------------------------------------------------ */
/* Admin readout shape (mirrors api/_lib.ts summarizeHealthCounts)     */
/* ------------------------------------------------------------------ */

export interface HealthDayCounts {
  day: string;
  counts: Record<string, number>;
}

export interface HealthCountsSummary {
  today: HealthDayCounts;
  last14Days: Record<string, number>;
  days: HealthDayCounts[];
}

/** Storage key for one bucket counter in the day document. */
export function healthStorageKey(type: HealthEventType, bucketName: string, bucketValue: string): string {
  if (type === 'door') return `health_door_${bucketValue}`;
  if (type === 'save') return 'health_save_success';
  return `health_${type}_${bucketName}_${bucketValue}`;
}

/** Admin display groups: plain words, counts only. */
export const HEALTH_ADMIN_GROUPS: Array<{
  title: string;
  rows: Array<{ key: string; label: string }>;
}> = [
  {
    title: 'Camera takes',
    rows: [
      { key: 'health_take_tier_2160', label: 'Takes at 2160 tier' },
      { key: 'health_take_tier_1440', label: 'Takes at 1440 tier' },
      { key: 'health_take_tier_1080', label: 'Takes at 1080 tier' },
      { key: 'health_take_tier_720', label: 'Takes at 720 tier' },
      { key: 'health_take_tier_low', label: 'Takes at low tier' },
      { key: 'health_take_tier_unknown', label: 'Takes at unknown tier' },
      { key: 'health_take_fps_60', label: 'Takes granted 60fps' },
      { key: 'health_take_fps_30', label: 'Takes granted 30fps' },
      { key: 'health_take_fps_other', label: 'Takes granted another frame rate' },
      { key: 'health_take_fps_unknown', label: 'Takes with unknown frame rate' },
      { key: 'health_take_drops_none', label: 'Takes with almost no dropped frames' },
      { key: 'health_take_drops_low', label: 'Takes with a few dropped frames' },
      { key: 'health_take_drops_high', label: 'Takes with many dropped frames' },
      { key: 'health_take_drops_unknown', label: 'Takes with unmeasured dropped frames' },
      { key: 'health_take_duration_under15', label: 'Takes under 15 seconds' },
      { key: 'health_take_duration_15to60', label: 'Takes 15 to 60 seconds' },
      { key: 'health_take_duration_over60', label: 'Takes over 60 seconds' },
    ],
  },
  {
    title: 'Exports and saves that worked',
    rows: [
      { key: 'health_export_duration_under10', label: 'Exports under 10 seconds that worked' },
      { key: 'health_export_duration_10to60', label: 'Exports 10 to 60 seconds that worked' },
      { key: 'health_export_duration_over60', label: 'Exports over 60 seconds that worked' },
      { key: 'health_save_success', label: 'Saves that worked' },
    ],
  },
  {
    title: 'How sessions felt',
    rows: [
      { key: 'health_session_total_0', label: 'Sessions with no long pauses' },
      { key: 'health_session_total_1to5', label: 'Sessions with 1 to 5 long pauses' },
      { key: 'health_session_total_6plus', label: 'Sessions with 6 or more long pauses' },
      { key: 'health_session_over200_0', label: 'Sessions with no pause over 200ms' },
      { key: 'health_session_over200_1plus', label: 'Sessions with a pause over 200ms' },
    ],
  },
  {
    title: 'Doors opened',
    rows: [
      { key: 'health_door_promo', label: 'Promo opened' },
      { key: 'health_door_editor', label: 'Editor opened' },
      { key: 'health_door_poster', label: 'Poster opened' },
      { key: 'health_door_camera', label: 'Camera opened' },
    ],
  },
];
