import { describe, it, expect } from 'vitest';
import { STUDIO_TEMPLATES, getTemplate, templatesByKind, type StudioTemplate } from '../templates';
import { applyFullTemplate } from './apply';
import { pairSafeTransition } from './pairMotion';
import { TRANSITION_PRESETS } from '../transitions';
import { createDefaultProject } from '../projects/persistence';
import { addTextItem, appendDualCaptureToTimeline, appendMediaToTimeline } from '../timeline/insert';
import type { MediaAsset, Project, TimelineItem } from '../../types/timeline';

const TUNED_IDS = ['viral-hook-story', 'music-video', 'event-promo', 'product-ad-15'];

function videoAsset(id: string, durationSeconds = 30): MediaAsset {
  return {
    id,
    kind: 'video',
    storageUrl: `https://example.com/${id}.mp4`,
    fileName: `${id}.mp4`,
    sizeBytes: 1_000_000,
    mimeType: 'video/mp4',
    durationSeconds,
    width: 1080,
    height: 1920,
    createdAt: 0,
  };
}

function projectWithClips(count: number): Project {
  let project = createDefaultProject('uid-1');
  for (let i = 0; i < count; i++) {
    project = appendMediaToTimeline(project, videoAsset(`asset-clip-${i}`));
  }
  return project;
}

function animOf(item: TimelineItem): { entrance?: string; exit?: string } | undefined {
  return (item as { animation?: { entrance?: string; exit?: string } }).animation;
}

/** The fixture's slotted media, in packed (startTime) order. */
function slottedInOrder(project: Project, fixtureIds: Set<string>): TimelineItem[] {
  return project.items
    .filter((i) => fixtureIds.has(i.id) && (i.type === 'video' || i.type === 'image'))
    .slice()
    .sort((a, b) => a.startTime - b.startTime);
}

describe('R37 Phase 2 — per-slot transitions', () => {
  it('untuned full templates are byte-identical to the old single-transition stamping', () => {
    const untuned = templatesByKind('full').filter((t) => !TUNED_IDS.includes(t.id));
    expect(untuned).toHaveLength(6);
    for (const template of untuned) {
      let fixture = projectWithClips(3);
      fixture = addTextItem(fixture, { text: 'My own title', atTime: 1, durationSeconds: 3 });
      const fixtureIds = new Set(fixture.items.map((i) => i.id));
      const { project: next } = applyFullTemplate(fixture, template);
      // Every item the fixture carried in (clips + the user's text)
      // is stamped entrance = exit = the template's one transition,
      // exactly as before per-slot transitions existed. (Placeholder
      // texts the apply ADDS carry no animation — also as before.)
      for (const item of next.items) {
        if (!fixtureIds.has(item.id)) continue;
        if (item.type !== 'video' && item.type !== 'image' && item.type !== 'text') continue;
        expect(animOf(item)?.entrance, `${template.id} ${item.id} entrance`).toBe(template.transition);
        expect(animOf(item)?.exit, `${template.id} ${item.id} exit`).toBe(template.transition);
      }
    }
  });

  it('pair items wrap the stamped transition pair-safely on BOTH sides', () => {
    let fixture = createDefaultProject('uid-1');
    fixture = appendDualCaptureToTimeline(fixture, videoAsset('asset-main', 12), videoAsset('asset-front', 12), {
      startDeltaMs: 0,
    });
    const template = getTemplate('youtube-intro')!; // transition light-leak — not fade-class
    expect(pairSafeTransition(template.transition)).toBe('fade');
    const { project: next } = applyFullTemplate(fixture, template);
    const pairItems = next.items.filter((i) => i.type === 'video');
    expect(pairItems).toHaveLength(2);
    for (const item of pairItems) {
      expect(animOf(item)?.entrance).toBe(pairSafeTransition(template.transition));
      expect(animOf(item)?.exit).toBe(pairSafeTransition(template.transition));
    }
  });

  it('viral-hook-story sequences entrances across slots and exits into the next slot', () => {
    const fixture = projectWithClips(5);
    const fixtureIds = new Set(fixture.items.map((i) => i.id));
    const template = getTemplate('viral-hook-story')!;
    const { project: next } = applyFullTemplate(fixture, template);
    const slotted = slottedInOrder(next, fixtureIds);
    expect(slotted).toHaveLength(5);
    expect(slotted.map((i) => animOf(i)?.entrance)).toEqual([
      'snap-zoom',
      'pop',
      'whip-pan',
      'cross-zoom',
      'dip-to-gold',
    ]);
    // Each exit is the NEXT slot's entrance; the last item exits on
    // the template default ('cross-zoom').
    expect(slotted.map((i) => animOf(i)?.exit)).toEqual([
      'pop',
      'whip-pan',
      'cross-zoom',
      'dip-to-gold',
      'cross-zoom',
    ]);
  });

  it('music-video sequences entrances across slots and exits into the next slot', () => {
    const fixture = projectWithClips(5);
    const fixtureIds = new Set(fixture.items.map((i) => i.id));
    const template = getTemplate('music-video')!;
    const { project: next } = applyFullTemplate(fixture, template);
    const slotted = slottedInOrder(next, fixtureIds);
    expect(slotted).toHaveLength(5);
    expect(slotted.map((i) => animOf(i)?.entrance)).toEqual([
      'smoke',
      'film-dissolve',
      'film-burn',
      'luma-fade',
      'dip-to-black',
    ]);
    expect(slotted.map((i) => animOf(i)?.exit)).toEqual([
      'film-dissolve',
      'film-burn',
      'luma-fade',
      'dip-to-black',
      'film-burn',
    ]);
  });

  it('fallback: a lone slot transition affects only its item entrance, its predecessor exit', () => {
    const base = getTemplate('commercial-30')!; // default 'luma-fade', 4 slots, none tuned
    const cloned: StudioTemplate = {
      ...base,
      slots: (base.slots ?? []).map((slot, i) => (i === 1 ? { ...slot, transition: 'zoom' } : { ...slot })),
    };
    const fixture = projectWithClips(3);
    const fixtureIds = new Set(fixture.items.map((i) => i.id));
    const { project: next } = applyFullTemplate(fixture, cloned);
    const slotted = slottedInOrder(next, fixtureIds);
    expect(slotted).toHaveLength(3);
    // Item 2 enters on the slot's own transition; its neighbours keep the default.
    expect(animOf(slotted[1])?.entrance).toBe('zoom');
    expect(animOf(slotted[0])?.entrance).toBe(base.transition);
    expect(animOf(slotted[2])?.entrance).toBe(base.transition);
    // Item 1 exits INTO item 2's slot transition.
    expect(animOf(slotted[0])?.exit).toBe('zoom');
    // The last slotted item exits on the template default.
    expect(animOf(slotted[2])?.exit).toBe(base.transition);
  });

  it('catalog validity: every slot transition exists in TRANSITION_PRESETS', () => {
    const presetIds = new Set(TRANSITION_PRESETS.map((p) => p.id as string));
    for (const template of STUDIO_TEMPLATES) {
      for (const slot of template.slots ?? []) {
        if (slot.transition !== undefined) {
          expect(presetIds.has(slot.transition), `${template.id} slot ${slot.name}`).toBe(true);
        }
      }
    }
    // The tuned proof set actually carries slot transitions.
    for (const id of TUNED_IDS) {
      const template = getTemplate(id)!;
      expect((template.slots ?? []).every((s) => typeof s.transition === 'string'), id).toBe(true);
    }
  });

  it('does not mutate the input project', () => {
    const fixture = projectWithClips(5);
    const snapshot = JSON.stringify(fixture);
    applyFullTemplate(fixture, getTemplate('viral-hook-story')!);
    expect(JSON.stringify(fixture)).toBe(snapshot);
  });
});
