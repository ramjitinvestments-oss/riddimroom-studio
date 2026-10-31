import { describe, expect, it } from 'vitest';
import { freeCapWarningForProject } from './capWarning';
import { evaluateProjectExportGate } from './projectDurationGate';
import { createEmptyProject, addItem, addTrack, createTrack } from './timeline/utils';
import type { Project, VideoTimelineItem } from '../types/timeline';

/**
 * R40 P-32 — the landing-moment Free-cap warning decision: gate result
 * → warning. The measure is the R35 gate's own (R36 longest-video
 * duration); these tests pin that this helper agrees with the gate on
 * every shape, and only ever warns a Free user who is over the cap.
 */

function projectWithVideo(endSeconds: number): Project {
  let project = createEmptyProject({ ownerUid: 'test-uid' });
  const track = createTrack('video', 'Video', 0);
  project = addTrack(project, track);
  const item: VideoTimelineItem = {
    id: 'v1', type: 'video', trackId: track.id, startTime: 0, endTime: endSeconds,
    zIndex: 0, visible: true, mediaAssetId: 'a1',
    position: { x: 50, y: 50 }, scale: 1, rotation: 0, opacity: 1,
    trimStart: 0, trimEnd: endSeconds, speed: 1, reverse: false, volume: 1, muted: false,
  };
  return addItem(project, item);
}

describe('freeCapWarningForProject', () => {
  it('a Free project at 42s warns, naming the new length and the 30-second cap', () => {
    const warning = freeCapWarningForProject(projectWithVideo(42), 'free');
    expect(warning).toBe(
      "This project is now 0:42 — Free exports up to 30 seconds, so you'll need to trim it or use Lifetime to export.",
    );
  });

  it('a Free project within the cap does not warn', () => {
    expect(freeCapWarningForProject(projectWithVideo(20), 'free')).toBeNull();
    expect(freeCapWarningForProject(projectWithVideo(30), 'free')).toBeNull();
  });

  it('a Lifetime project never warns (its own cap is far above)', () => {
    expect(freeCapWarningForProject(projectWithVideo(42), 'lifetime')).toBeNull();
  });

  it('the decision agrees with the gate on every measured shape', () => {
    for (const seconds of [0, 10, 29.9, 30, 30.4, 42, 90]) {
      const project = projectWithVideo(seconds);
      const gate = evaluateProjectExportGate(project, 'free');
      const warning = freeCapWarningForProject(project, 'free');
      expect(warning !== null).toBe(gate.exceedsCap);
      if (warning) expect(warning).toContain('Free exports up to 30 seconds');
    }
  });

  it('an audio-only project measures 0 through the gate and does not warn', () => {
    const project = createEmptyProject({ ownerUid: 'test-uid' });
    expect(freeCapWarningForProject(project, 'free')).toBeNull();
  });
});
