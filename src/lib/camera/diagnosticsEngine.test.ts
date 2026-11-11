/**
 * FINAL FIX Part 2 — the diagnostics pack's engine record: the pack
 * names the engine that ran the check and carries the new engine's
 * frame ledger, the summary speaks it in plain words, and the
 * notes state honestly that a new-engine clip is that engine's RAW
 * output (grid-stamped at capture, never steadied).
 */

import { describe, expect, it } from 'vitest';
import {
  buildDiagnosticsEvidencePack,
  formatDiagnosticsSummary,
  type DiagnosticsEvidenceInput,
} from './diagnostics';

const baseInput: DiagnosticsEvidenceInput = {
  createdAt: '2026-11-09T23:30:00.000Z',
  userAgent: 'test-agent',
  facing: 'environment',
  qualityChoice: 'auto',
  fpsChoice: 30,
  durationSeconds: 60,
  asked: { shortSide: 2160, frameRate: 30, width: 3840, height: 2160 },
  granted: { width: 3840, height: 2160, frameRate: 30 },
  exactRetryAttempted: false,
  exactRetryUsed: false,
  mimeType: 'video/mp4',
  recorderVideoBitsPerSecond: 45_000_000,
  recorderAudioBitsPerSecond: 192_000,
  census: null,
  frameSeries: { timestampsMs: [], presentedFrames: [] },
  longtasks: { available: true, count: 0, over200Count: 0, longestMs: 0, entries: [] },
};

describe('diagnostics pack — engine record', () => {
  it('a pack with no engine input records the standard engine with a null ledger', () => {
    const pack = buildDiagnosticsEvidencePack({ ...baseInput });
    expect(pack.engine).toEqual({
      kind: 'mediarecorder',
      fellBack: false,
      framesReceived: null,
      framesEncoded: null,
      framesDroppedByQueue: null,
      framesFilled: null,
      audioIncluded: null,
    });
    // No engine line is spoken for the standard engine.
    expect(formatDiagnosticsSummary(pack).join('\n')).not.toContain('new engine');
  });

  it('a new-engine check carries the engine name and its own counts', () => {
    const pack = buildDiagnosticsEvidencePack({
      ...baseInput,
      engine: {
        kind: 'webcodecs',
        fellBack: false,
        framesReceived: 1804,
        framesEncoded: 1797,
        framesDroppedByQueue: 3,
        framesFilled: 12,
        audioIncluded: true,
      },
    });
    expect(pack.engine).toEqual({
      kind: 'webcodecs',
      fellBack: false,
      framesReceived: 1804,
      framesEncoded: 1797,
      framesDroppedByQueue: 3,
      framesFilled: 12,
      audioIncluded: true,
    });
    const summary = formatDiagnosticsSummary(pack).join('\n');
    expect(summary).toContain('Recorded with the new engine: 1797 frames, 3 dropped on purpose, 12 gaps filled');
    // The notes disclose the clip is the engine's RAW output.
    expect(pack.notes.join('\n')).toContain('raw output');
    expect(pack.notes.join('\n')).toContain('NOT been through the project steadying step');
  });

  it('a fallen-back check says the standard engine recorded it', () => {
    const pack = buildDiagnosticsEvidencePack({
      ...baseInput,
      engine: { kind: 'webcodecs', fellBack: true },
    });
    expect(pack.engine.kind).toBe('webcodecs');
    expect(pack.engine.fellBack).toBe(true);
    expect(formatDiagnosticsSummary(pack).join('\n')).toContain(
      'The new engine hit a problem — this check used the standard engine',
    );
    expect(pack.notes.join('\n')).toContain('standard engine recorded it');
  });

  it('a video-only new-engine check discloses the missing sound in pack and summary', () => {
    const pack = buildDiagnosticsEvidencePack({
      ...baseInput,
      engine: { kind: 'webcodecs', fellBack: false, framesEncoded: 1800, audioIncluded: false },
    });
    expect(pack.engine.audioIncluded).toBe(false);
    expect(formatDiagnosticsSummary(pack).join('\n')).toContain('The new engine recorded no sound on this check.');
    expect(pack.notes.join('\n')).toContain('recorded no sound');
  });
});
