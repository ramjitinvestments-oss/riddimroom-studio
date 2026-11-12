import { describe, it, expect } from 'vitest';
import { getTemplate, templatesByKind } from '../templates';

/**
 * R42 Phase D — the decided slot maps, pinned.
 *
 * Owner decisions (2026-11-11): D4a NOT STRICT — 1.5–3s is the
 * default band, with named Long-form exemptions that keep their long
 * slots (Podcast conversation, Testimonial story, Music Video
 * verse/chorus spans). D4b — totals are shorter and TRUE:
 * durationSeconds is exactly the slot sum for every full template,
 * and any description that states a duration states the true one.
 */

/** The decided maps: template id → slot durations in order. */
const DECIDED_SLOTS: Record<string, number[]> = {
  'viral-hook-story': [2, 3, 3, 3, 3, 2],
  'music-video': [3, 12, 12, 2.5, 2.5, 3],
  'product-ad-15': [2, 3, 3, 3, 2, 2],
  'commercial-30': [3, 3, 3, 3, 2, 3, 2, 2],
  'event-promo': [2, 3, 2.5, 3, 2.5, 2, 3, 2],
  'podcast-clip': [3, 15, 3, 3, 2],
  'youtube-intro': [2, 3, 3, 2, 3, 2],
  'before-after': [3, 2, 1.5, 3, 3, 2.5],
  testimonial: [3, 12, 3, 2, 3],
  'lyric-visualizer': [2, 3, 2, 3, 3, 2, 2, 3],
};

/** D4a exemptions: (template id, slot name) pairs allowed past 3s. */
const LONG_FORM_EXEMPTIONS = new Set([
  'music-video:Verse',
  'music-video:Chorus',
  'podcast-clip:Conversation',
  'testimonial:Story',
]);

describe('R42 Phase D — decided slot maps', () => {
  it('every full template carries exactly its decided slot durations', () => {
    for (const [id, durations] of Object.entries(DECIDED_SLOTS)) {
      const t = getTemplate(id)!;
      expect(t, id).toBeDefined();
      expect((t.slots ?? []).map((s) => s.durationSeconds), id).toEqual(durations);
    }
    // No full template exists outside the decided set.
    expect(templatesByKind('full').map((t) => t.id).sort()).toEqual(Object.keys(DECIDED_SLOTS).sort());
  });

  it('durationSeconds === Σ slots for every full template (D4b: stated totals are true)', () => {
    for (const t of templatesByKind('full')) {
      const sum = (t.slots ?? []).reduce((acc, s) => acc + s.durationSeconds, 0);
      expect(t.durationSeconds, t.id).toBeCloseTo(sum, 9);
    }
  });

  it('every non-exempt slot sits in the 1.5–3s band; exemptions are exactly the named long-form slots', () => {
    for (const t of templatesByKind('full')) {
      for (const slot of t.slots ?? []) {
        const key = `${t.id}:${slot.name}`;
        if (LONG_FORM_EXEMPTIONS.has(key)) {
          expect(slot.durationSeconds, key).toBeGreaterThan(3);
        } else {
          expect(slot.durationSeconds, key).toBeGreaterThanOrEqual(1.5);
          expect(slot.durationSeconds, key).toBeLessThanOrEqual(3);
        }
      }
    }
  });

  it("commercial-30 is renamed 'Commercial' (the id stays for saved data)", () => {
    expect(getTemplate('commercial-30')!.name).toBe('Commercial');
    expect(getTemplate('commercial-30')!.durationSeconds).toBe(21);
  });

  it('descriptions that state a duration state the true total', () => {
    for (const t of templatesByKind('full')) {
      const stated = t.description.match(/(\d+(?:\.\d+)?)-second/);
      if (stated) {
        expect(Number(stated[1]), `${t.id}: "${t.description}"`).toBe(t.durationSeconds);
      }
    }
  });
});
