/**
 * R40 P-32 — the Free-cap warning at the moment a project goes over.
 *
 * The R35 gate already refuses honestly at export, and the editor
 * header already carries a standing indicator line. What was missing:
 * the moment an import lands or a camera take is added and the project
 * FIRST crosses the Free 30-second cap, nothing said so — the export
 * screen delivered the first bad news. This helper makes that decision
 * in one place: EditorShell calls it once per landing action (import
 * completion, single/dual/two-step camera take, Record PiP, overlay,
 * pair — every path that adds media through its handlers), with the
 * project AS THE LANDING LEAVES IT, and shows the returned note once.
 *
 * The measure is the gate's own — `evaluateProjectExportGate` (the
 * R36 longest-video duration). Nothing here forks it.
 */

import { evaluateProjectExportGate } from './projectDurationGate';
import { formatTimecode } from './timeline/utils';
import type { LicenseTier } from './licensing';
import type { Project } from '../types/timeline';

function formatClock(seconds: number): string {
  const timecode = formatTimecode(seconds);
  return timecode.endsWith('.0') ? timecode.slice(0, -2) : timecode;
}

/**
 * The one plain warning note for a landing that leaves a Free project
 * over the Free cap, or null when there is nothing to warn about
 * (Lifetime tier, or the project is within the cap). Pure: the caller
 * fires it once per landing action, never per render.
 */
export function freeCapWarningForProject(project: Project, tier: LicenseTier): string | null {
  if (tier !== 'free') return null;
  const gate = evaluateProjectExportGate(project, tier);
  if (!gate.exceedsCap) return null;
  return `This project is now ${formatClock(gate.durationSeconds)} — Free exports up to ${gate.maxProjectSeconds} seconds, so you'll need to trim it or use Lifetime to export.`;
}
