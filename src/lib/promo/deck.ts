/**
 * The animation deck — how multi-photo promos avoid the
 * "same stamp ten times" look the owner called out. Treatments
 * are DEALT, not repeated: entrances rotate through direction
 * families (horizontal → impact → vertical → effect) and the
 * on-screen drift rotates with them, under two hard rules:
 *
 *  1. Never the same entrance twice in a row.
 *  2. Never the same drift twice in a row.
 *
 * The deal is deterministic — same count, same sequence, every
 * build — and every dealt treatment lands on a normal timeline
 * item, so the user can still change any photo's animation by
 * hand in the editor afterward.
 */
import type { AnimationPreset, MotionSettings } from '../../types/timeline';

const ENTRANCE_FAMILIES: AnimationPreset[][] = [
  ['slide-left', 'slide-right'],
  ['pop', 'zoom', 'bounce'],
  ['slide-up', 'fadeup', 'slide-down'],
  ['glitch', 'flip', 'spin', 'skew'],
];

/**
 * Drift cycle: four distinct types in rotation — the wrap from the
 * last back to the first is also a change (zoom-out → ken-burns),
 * so the no-repeat rule holds at every count. The ken-burns pan
 * direction itself rotates each time the cycle comes back around.
 */
const DRIFT_CYCLE: MotionSettings[] = [
  { type: 'ken-burns', direction: 'right' },
  { type: 'slow-zoom-in' },
  { type: 'punch-zoom' },
  { type: 'slow-zoom-out' },
];
const KB_DIRECTIONS: Array<MotionSettings['direction']> = ['right', 'up', 'left', 'down'];

export function dealEntrances(count: number): AnimationPreset[] {
  const out: AnimationPreset[] = [];
  for (let i = 0; i < count; i++) {
    const family = ENTRANCE_FAMILIES[i % ENTRANCE_FAMILIES.length];
    const member = family[Math.floor(i / ENTRANCE_FAMILIES.length) % family.length];
    out.push(member);
  }
  return out;
}

export function dealDrifts(count: number): MotionSettings[] {
  const out: MotionSettings[] = [];
  for (let i = 0; i < count; i++) {
    const base = DRIFT_CYCLE[i % DRIFT_CYCLE.length];
    if (base.type === 'ken-burns') {
      out.push({ type: 'ken-burns', direction: KB_DIRECTIONS[Math.floor(i / DRIFT_CYCLE.length) % KB_DIRECTIONS.length] });
    } else {
      out.push({ ...base });
    }
  }
  return out;
}

export interface DealtTreatment {
  entrance: AnimationPreset;
  drift: MotionSettings;
}

export function dealTreatments(count: number): DealtTreatment[] {
  const entrances = dealEntrances(count);
  const drifts = dealDrifts(count);
  return entrances.map((entrance, i) => ({ entrance, drift: drifts[i] }));
}
