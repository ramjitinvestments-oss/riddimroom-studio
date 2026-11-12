/**
 * R44 SF-7 — magnetic main track tests.
 *
 * Pins the three laws from magnetic.ts:
 *  1. Plain projects: drag reorders + packs; delete closes the gap.
 *  2. Contracted projects (appliedTemplate set): magnetism NEVER acts —
 *     moves are the legacy clamp, deletes are plain removals, and the
 *     slot map / drift machinery is untouched.
 *  3. Designed overlaps stand magnetism down (transitions preserved).
 */
import { describe, expect, it } from 'vitest';
import { createDefaultProject } from '../projects/persistence';
import { addItem, generateTimelineId, getItemDuration, moveItem } from './utils';
import { magnetismApplies, mainTrackSequence, moveItemMagnetic, packMainTrack, removeItemClosingGap } from './magnetic';
import { templateDrift } from '../templates/contract';
import type { Project, VideoTimelineItem } from '../../types/timeline';

function videoItem(project: Project, start: number, duration: number, extra: Partial<VideoTimelineItem> = {}): VideoTimelineItem {
  const track = project.tracks.find((t) => t.type === 'video')!;
  return {
    id: generateTimelineId('item'),
    type: 'video',
    trackId: track.id,
    assetId: 'asset-1',
    name: 'clip',
    startTime: start,
    endTime: start + duration,
    trimStart: 0,
    trimEnd: duration,
    ...extra,
  } as VideoTimelineItem;
}

function threeClipProject(): { project: Project; ids: string[] } {
  let project = createDefaultProject('owner-1');
  const ids: string[] = [];
  // A 0–4, B 4–7, C 9–14 (a 2s gap before C).
  for (const [start, dur] of [[0, 4], [4, 3], [9, 5]] as const) {
    const item = videoItem(project, start, dur);
    ids.push(item.id);
    project = addItem(project, item);
  }
  return { project, ids };
}

function starts(project: Project): Array<[string, number, number]> {
  return mainTrackSequence(project, project.tracks.find((t) => t.type === 'video')!.id).map(
    (i) => [i.id, i.startTime, i.endTime] as [string, number, number],
  );
}

describe('SF-7 magnetic main track — plain projects', () => {
  it('dragging the first clip past the second reorders and packs the sequence', () => {
    const { project, ids } = threeClipProject();
    const next = moveItemMagnetic(project, ids[0], 6);
    // Order B, A, C packed from 0: B 0–3, A 3–7, C 7–12.
    expect(starts(next)).toEqual([
      [ids[1], 0, 3],
      [ids[0], 3, 7],
      [ids[2], 7, 12],
    ]);
  });

  it('a small drag within the same slot keeps the order and just closes gaps', () => {
    const { project, ids } = threeClipProject();
    const next = moveItemMagnetic(project, ids[1], 4.4);
    expect(starts(next)).toEqual([
      [ids[0], 0, 4],
      [ids[1], 4, 7],
      [ids[2], 7, 12],
    ]);
  });

  it('dragging left past a neighbour reorders the other way', () => {
    const { project, ids } = threeClipProject();
    const next = moveItemMagnetic(project, ids[2], 0.5);
    expect(starts(next)).toEqual([
      [ids[2], 0, 5],
      [ids[0], 5, 9],
      [ids[1], 9, 12],
    ]);
  });

  it('deleting the middle clip closes the gap', () => {
    const { project, ids } = threeClipProject();
    const next = removeItemClosingGap(project, ids[1]);
    expect(starts(next)).toEqual([
      [ids[0], 0, 4],
      [ids[2], 4, 9],
    ]);
  });

  it('packMainTrack closes gaps without reordering', () => {
    const { project, ids } = threeClipProject();
    const trackId = project.tracks.find((t) => t.type === 'video')!.id;
    const next = packMainTrack(project, trackId);
    expect(starts(next)).toEqual([
      [ids[0], 0, 4],
      [ids[1], 4, 7],
      [ids[2], 7, 12],
    ]);
  });

  it('durations are never changed by magnetism', () => {
    const { project, ids } = threeClipProject();
    const before = new Map(project.items.map((i) => [i.id, getItemDuration(i)]));
    const next = moveItemMagnetic(project, ids[0], 30);
    for (const item of next.items) expect(getItemDuration(item)).toBe(before.get(item.id));
  });

  it('non-main items (PiP) are moved with the legacy clamp and never packed', () => {
    const { project } = threeClipProject();
    const pip = videoItem(project, 1, 2, { pip: { isPip: true } as VideoTimelineItem['pip'] });
    const withPip = addItem(project, pip);
    const next = moveItemMagnetic(withPip, pip.id, 5);
    // Exactly the legacy clamp: the PiP parks against B's end (7), not at 5.
    expect(next.items.find((i) => i.id === pip.id)?.startTime).toBe(7);
    // The main sequence keeps its gap before C — the PiP move packed nothing.
    expect(starts(next)[2][1]).toBe(9);
  });
});

describe('SF-7 × R42 template contract — the slot map stays authoritative', () => {
  function contracted(): { project: Project; ids: string[] } {
    const { project, ids } = threeClipProject();
    const slotByItemId: Record<string, number> = { [ids[0]]: 0, [ids[1]]: 1, [ids[2]]: 2 };
    return {
      project: { ...project, appliedTemplate: { templateId: 'viral-hook-story', slotByItemId, appliedAt: 1_700_000_000_000 } },
      ids,
    };
  }

  it('magnetism does not apply to a contracted project', () => {
    const { project } = contracted();
    const trackId = project.tracks.find((t) => t.type === 'video')!.id;
    expect(magnetismApplies(project, trackId)).toBe(false);
  });

  it('a contracted drag is EXACTLY the legacy clamped move — no reorder, no pack', () => {
    const { project, ids } = contracted();
    const viaMagnetic = moveItemMagnetic(project, ids[0], 6);
    const viaLegacy = moveItem(project, ids[0], 6);
    expect(viaMagnetic.items).toEqual(viaLegacy.items);
    // Legacy clamp chains: A parks against B (7), then against C's start (9 − 4 = 5).
    expect(viaMagnetic.items.find((i) => i.id === ids[0])?.startTime).toBe(5);
    // C keeps its contracted slot position — the gap before it survives.
    expect(viaMagnetic.items.find((i) => i.id === ids[2])?.startTime).toBe(9);
  });

  it('a contracted delete removes plainly and drift (not magnetism) reports the hole', () => {
    const { project, ids } = contracted();
    const next = removeItemClosingGap(project, ids[1]);
    // C was NOT pulled forward — the slot map still points at it and drift sees the change.
    expect(next.items.find((i) => i.id === ids[2])?.startTime).toBe(9);
    expect(next.appliedTemplate?.slotByItemId[ids[2]]).toBe(2);
    expect(templateDrift(next).drifted).toBe(true);
  });

  it('packMainTrack is a no-op under contract', () => {
    const { project } = contracted();
    const trackId = project.tracks.find((t) => t.type === 'video')!.id;
    expect(packMainTrack(project, trackId)).toBe(project);
  });
});

describe('SF-7 transitions — designed overlaps stand magnetism down', () => {
  it('an overlapped sequence keeps legacy clamp semantics', () => {
    let project = createDefaultProject('owner-1');
    const a = videoItem(project, 0, 5);
    const b = videoItem(project, 4, 4); // 1s overlap with A — a designed transition
    project = addItem(addItem(project, a), b);
    const trackId = project.tracks.find((t) => t.type === 'video')!.id;
    expect(magnetismApplies(project, trackId)).toBe(false);
    const next = moveItemMagnetic(project, a.id, 6);
    expect(next.items).toEqual(moveItem(project, a.id, 6).items);
  });
});
