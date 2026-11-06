import { describe, it, expect } from 'vitest';
import {
  DIAGNOSTICS_PHASES,
  DIAGNOSTICS_TOTAL_SECONDS,
  FRAME_INTERVAL_TOLERANCE_FRACTION,
  buildDiagnosticsEvidencePack,
  computeFrameIntervalStats,
  createLongtaskCollector,
  diagnosticsPhaseAt,
  diagnosticsReportJson,
  formatDiagnosticsSummary,
  summarizeLongtasks,
  type DiagnosticsEvidenceInput,
} from './diagnostics';

/** A steady series at `fps` for `seconds`, starting at 500ms. */
function steadySeries(fps: number, seconds: number): number[] {
  const out: number[] = [];
  const interval = 1000 / fps;
  for (let t = 500; t <= 500 + seconds * 1000; t += interval) out.push(Math.round(t * 100) / 100);
  return out;
}

describe('the guided script', () => {
  it('is 10s still + 20s slow pan + 30s walk = 60s total', () => {
    expect(DIAGNOSTICS_PHASES.map((p) => [p.id, p.seconds])).toEqual([
      ['still', 10],
      ['pan', 20],
      ['walk', 30],
    ]);
    expect(DIAGNOSTICS_TOTAL_SECONDS).toBe(60);
  });

  it('phaseAt walks the boundaries', () => {
    expect(diagnosticsPhaseAt(0).phase.id).toBe('still');
    expect(diagnosticsPhaseAt(9).secondsLeftInPhase).toBe(1);
    expect(diagnosticsPhaseAt(10).phase.id).toBe('pan');
    expect(diagnosticsPhaseAt(29).phase.id).toBe('pan');
    expect(diagnosticsPhaseAt(30).phase.id).toBe('walk');
    expect(diagnosticsPhaseAt(59).secondsLeftInPhase).toBe(1);
    expect(diagnosticsPhaseAt(60).phase.id).toBe('walk');
    expect(diagnosticsPhaseAt(-5).phase.id).toBe('still');
  });
});

describe('computeFrameIntervalStats — synthetic series', () => {
  it('a steady 60fps series: median at target, 100% within tolerance, no long gap', () => {
    const stats = computeFrameIntervalStats(steadySeries(60, 5), 60);
    expect(stats).not.toBeNull();
    expect(stats!.targetIntervalMs).toBe(16.7);
    expect(stats!.medianIntervalMs).toBeCloseTo(16.7, 0);
    expect(stats!.withinTolerancePercent).toBe(100);
    expect(stats!.longestGapMs).toBeLessThan(17);
    expect(stats!.toleranceFraction).toBe(FRAME_INTERVAL_TOLERANCE_FRACTION);
    expect(FRAME_INTERVAL_TOLERANCE_FRACTION).toBe(0.25);
  });

  it('a series with a dropped-frame gap: longest gap named, on-time share drops', () => {
    // Steady 30fps for 1s, then a 300ms hole, then steady again.
    const base = steadySeries(30, 1);
    const last = base[base.length - 1];
    const after = [last + 300 + 33.3, last + 300 + 66.7, last + 300 + 100];
    const series = [...base, ...after];
    const stats = computeFrameIntervalStats(series, 30)!;
    expect(stats.longestGapMs).toBeGreaterThan(290);
    expect(stats.withinTolerancePercent).toBeLessThan(100);
    expect(stats.medianIntervalMs).toBeCloseTo(33.3, 0);
  });

  it('duplicated frames (double-length intervals) fall OUTSIDE tolerance', () => {
    // Every second frame duplicated at 60fps target: intervals alternate 16.7 / 33.3.
    const series: number[] = [0];
    for (let i = 0; i < 30; i += 1) {
      series.push(series[series.length - 1] + (i % 2 === 0 ? 16.7 : 33.3));
    }
    const stats = computeFrameIntervalStats(series, 60)!;
    expect(stats.withinTolerancePercent).toBeLessThan(60);
  });

  it('returns null rather than inventing stats for unusable input', () => {
    expect(computeFrameIntervalStats([], 60)).toBeNull();
    expect(computeFrameIntervalStats([100], 60)).toBeNull();
    expect(computeFrameIntervalStats([100, 100], 60)).toBeNull();
    expect(computeFrameIntervalStats(steadySeries(60, 1), 0)).toBeNull();
    expect(computeFrameIntervalStats(steadySeries(60, 1), Number.NaN)).toBeNull();
  });
});

describe('longtasks', () => {
  it('summarises count, over-200 count and longest; drops unusable entries', () => {
    const summary = summarizeLongtasks(
      [
        { startTime: 10, duration: 80 },
        { startTime: 100, duration: 250 },
        { startTime: 400, duration: 50 },
        { startTime: 500, duration: Number.NaN },
      ],
      true,
    );
    expect(summary.available).toBe(true);
    expect(summary.count).toBe(3);
    expect(summary.over200Count).toBe(1);
    expect(summary.longestMs).toBe(250);
  });

  it('an unsupported observer collects nothing and reports not available', () => {
    const collector = createLongtaskCollector({ createObserver: null, supportedEntryTypes: null });
    collector.start();
    expect(collector.available).toBe(false);
    const summary = collector.stop();
    expect(summary.available).toBe(false);
    expect(summary.count).toBe(0);
  });

  it('a fake observer delivers entries only while started', () => {
    let cb: ((list: { getEntries: () => unknown[] }) => void) | null = null;
    const collector = createLongtaskCollector({
      createObserver: (callback) => {
        cb = callback;
        return { observe: () => {}, disconnect: () => {} };
      },
      supportedEntryTypes: ['longtask', 'paint'],
    });
    collector.start();
    expect(collector.available).toBe(true);
    cb!({ getEntries: () => [{ startTime: 5, duration: 320 }, { startTime: 9, duration: 40 }] });
    const summary = collector.stop();
    expect(summary.available).toBe(true);
    expect(summary.count).toBe(2);
    expect(summary.over200Count).toBe(1);
  });
});

describe('the evidence pack', () => {
  const input: DiagnosticsEvidenceInput = {
    createdAt: '2026-11-06T12:00:00.000Z',
    userAgent: 'Mozilla/5.0 (Linux; Android 15) TestPhone',
    facing: 'environment',
    qualityChoice: 'auto',
    fpsChoice: 60,
    durationSeconds: 60,
    asked: { shortSide: 2160, frameRate: 60, width: 2160, height: 3840 },
    granted: { width: 1080, height: 1920, frameRate: 60 },
    exactRetryAttempted: true,
    exactRetryUsed: false,
    mimeType: 'video/mp4',
    recorderVideoBitsPerSecond: 18_000_000,
    recorderAudioBitsPerSecond: 192_000,
    census: null,
    frameSeries: { timestampsMs: steadySeries(60, 3), presentedFrames: steadySeries(60, 3).map((_, i) => i + 1) },
    longtasks: summarizeLongtasks([{ startTime: 1, duration: 90 }], true),
  };

  it('carries every evidence field and labels the frame source as the viewfinder', () => {
    const pack = buildDiagnosticsEvidencePack(input);
    expect(pack.kind).toBe('riddimroom-camera-diagnostics');
    expect(pack.userAgent).toContain('TestPhone');
    expect(pack.asked).toEqual(input.asked);
    expect(pack.granted).toEqual({ width: 1080, height: 1920, frameRate: 60, shortSide: 1080 });
    expect(pack.exactRetryAttempted).toBe(true);
    expect(pack.recorder).toEqual({ mimeType: 'video/mp4', videoBitsPerSecond: 18_000_000, audioBitsPerSecond: 192_000 });
    expect(pack.viewfinderFrames.source).toBe('viewfinder-preview-requestVideoFrameCallback');
    expect(pack.viewfinderFrames.timestampsMs.length).toBeGreaterThan(100);
    expect(pack.viewfinderFrames.stats?.withinTolerancePercent).toBe(100);
    expect(pack.longtasks.count).toBe(1);
    expect(pack.notes.join(' ')).toContain('VIEWFINDER');
    // The JSON download round-trips.
    expect(JSON.parse(diagnosticsReportJson(pack)).kind).toBe('riddimroom-camera-diagnostics');
  });

  it('the plain summary states asked-vs-granted, the tolerance, and the viewfinder label', () => {
    const lines = formatDiagnosticsSummary(buildDiagnosticsEvidencePack(input));
    const joined = lines.join('\n');
    expect(lines[0]).toBe("Asked: 4K · 60 — Phone gave: 1080p · 60 — that's this browser's limit on this camera");
    expect(joined).toContain('within 25% of the target gap');
    expect(joined).toContain('These frame numbers come from the viewfinder preview, not the recorded file.');
    expect(joined).toContain('1 long task, 0 over 200 ms');
  });

  it('an unavailable longtask measurement is stated, never faked', () => {
    const pack = buildDiagnosticsEvidencePack({ ...input, longtasks: summarizeLongtasks([], false) });
    expect(formatDiagnosticsSummary(pack).join('\n')).toContain('Long-task measurement: not available in this browser');
  });
});
