/**
 * R22 — build-time text layout enforcement for promo projects.
 *
 * Recipe builders author text positions per recipe; long verbatim
 * texts (a business's real service names from a website scan) can
 * be far wider than the bank lines those positions were tuned on.
 * This pass runs on every built promo project (single builds and
 * campaign pieces alike, in PromoPage's build path) and guarantees
 * the spatial law before the project ever reaches the renderer:
 *
 *   No two text items whose time windows overlap may occupy
 *   overlapping boxes — resolved by nudging the smaller item to
 *   free vertical space, then shrinking it, then (last resort)
 *   serializing its window after the other item ends.
 *
 * The renderer keeps its own occupancy guard (lib/render/
 * textGuard.ts) as the last line of defense; this pass exists so
 * built projects are clean by construction, not by rescue.
 */
import type { Project, TextTimelineItem } from '../../types/timeline';
import { boxesOverlap, estimateTextBox, type TextBox } from '../render/textGuard';

function itemBox(project: Project, item: TextTimelineItem): TextBox {
  const fontPx = item.fontSize * (item.scale || 1);
  return estimateTextBox(
    item.text,
    fontPx,
    (item.position.x / 100) * project.canvasWidth,
    (item.position.y / 100) * project.canvasHeight,
  );
}

function windowsOverlap(a: TextTimelineItem, b: TextTimelineItem): boolean {
  return a.startTime < b.endTime && b.startTime < a.endTime;
}

export interface TextCollision {
  aId: string;
  bId: string;
  atSeconds: number;
}

/**
 * The audit: sample the project's text items and report every
 * spatial collision between time-overlapping items. Used by the
 * R22 test gate (0 collisions across the recipe matrix) and kept
 * exported so future recipes get the same check for free.
 */
export function auditTextLayout(project: Project, stepSeconds = 0.1): TextCollision[] {
  const texts = project.items.filter((i): i is TextTimelineItem => i.type === 'text' && i.visible);
  const boxes = new Map(texts.map((t) => [t.id, itemBox(project, t)]));
  const out: TextCollision[] = [];
  const end = Math.max(0, ...texts.map((t) => t.endTime));
  for (let t = 0; t <= end; t += stepSeconds) {
    const active = texts.filter((i) => i.startTime <= t && t < i.endTime);
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        if (boxesOverlap(boxes.get(active[i].id)!, boxes.get(active[j].id)!, 6)) {
          out.push({ aId: active[i].id, bId: active[j].id, atSeconds: Math.round(t * 10) / 10 });
        }
      }
    }
  }
  return out;
}

/**
 * Enforce the spatial law on a built project. Items are never
 * deleted and their words never change — only position, size, or
 * (last resort) start time of the smaller item in a colliding pair.
 */
export function enforceTextLayout(project: Project): Project {
  const texts = project.items.filter((i): i is TextTimelineItem => i.type === 'text' && i.visible);
  if (texts.length < 2) return project;
  const work = new Map<string, TextTimelineItem>(texts.map((t) => [t.id, { ...t, position: { ...t.position } }]));
  const sorted = [...work.values()].sort((a, b) => a.startTime - b.startTime);

  const collidesWithAny = (candidate: TextTimelineItem, selfId: string): boolean => {
    const box = itemBox(project, candidate);
    for (const other of work.values()) {
      if (other.id === selfId || !windowsOverlap(candidate, other)) continue;
      if (boxesOverlap(box, itemBox(project, other), 6)) return true;
    }
    return false;
  };

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (!windowsOverlap(a, b)) continue;
      const boxA = itemBox(project, a);
      const boxB = itemBox(project, b);
      if (!boxesOverlap(boxA, boxB, 6)) continue;
      // The smaller item moves (headlines keep their place).
      const mover = boxA.w * boxA.h <= boxB.w * boxB.h ? { ...b } : { ...a };
      const other = mover.id === a.id ? a : b;
      void other;
      const depthPx = Math.min(boxA.y + boxA.h, boxB.y + boxB.h) - Math.max(boxA.y, boxB.y) + 12;
      const depthPct = (depthPx / project.canvasHeight) * 100;
      let placed = false;
      for (const dir of [1, -1, 2, -2, 3, -3]) {
        const candidate: TextTimelineItem = {
          ...mover,
          position: { ...mover.position, y: mover.position.y + dir * depthPct * (Math.abs(dir) > 1 ? 0.7 : 1) },
        };
        if (candidate.position.y < 5 || candidate.position.y > 95) continue;
        if (!collidesWithAny(candidate, mover.id)) {
          work.set(mover.id, candidate);
          Object.assign(mover, candidate);
          placed = true;
          break;
        }
      }
      if (!placed) {
        // Shrink steps.
        for (const factor of [0.88, 0.78, 0.68, 0.6]) {
          const candidate: TextTimelineItem = { ...mover, fontSize: Math.round(mover.fontSize * factor) };
          if (!collidesWithAny(candidate, mover.id)) {
            work.set(mover.id, candidate);
            Object.assign(mover, candidate);
            placed = true;
            break;
          }
        }
      }
      if (!placed) {
        // Last resort: serialize — the mover starts when the other ends.
        const otherItem = work.get(mover.id === a.id ? b.id : a.id)!;
        const duration = mover.endTime - mover.startTime;
        const start = otherItem.endTime + 0.05;
        const candidate: TextTimelineItem = { ...mover, startTime: start, endTime: start + duration };
        work.set(mover.id, candidate);
        Object.assign(mover, candidate);
      }
      // Keep the sorted working copies in sync with the map.
      sorted[i] = work.get(sorted[i].id)!;
      sorted[j] = work.get(sorted[j].id)!;
    }
  }

  return {
    ...project,
    items: project.items.map((item) => (item.type === 'text' && work.has(item.id) ? work.get(item.id)! : item)),
  };
}
