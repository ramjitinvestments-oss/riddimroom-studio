/**
 * R40 P-37 — campaign render pre-check.
 *
 * Before ANY campaign piece renders, every built piece's project is
 * run through the existing tier duration gate
 * (`evaluateProjectExportGate`). Pieces that will refuse are known
 * up front: the campaign note can say so before a single render
 * starts, the refused pieces are marked without rendering them, and
 * — exactly as the gate's own contract promises — a refusal consumes
 * no daily export quota. Only the passable pieces reach the renderer.
 */
import { evaluateProjectExportGate } from '../projectDurationGate';
import type { LicenseTier } from '../licensing';
import type { Project } from '../../types/timeline';

export interface CampaignGatePrecheck {
  /** Per built piece (same order as the input): true = will refuse. */
  refused: boolean[];
  /** The gate's plain refusal message per refused piece (else null). */
  messages: Array<string | null>;
  refusedCount: number;
  /** The up-front campaign note sentence, or null when nothing refuses. */
  note: string | null;
}

export function campaignGatePrecheck(projects: Project[], tier: LicenseTier): CampaignGatePrecheck {
  const refused: boolean[] = [];
  const messages: Array<string | null> = [];
  for (const project of projects) {
    const gate = evaluateProjectExportGate(project, tier);
    refused.push(gate.exceedsCap);
    messages.push(gate.exceedsCap ? gate.message : null);
  }
  const refusedCount = refused.filter(Boolean).length;
  const planName = tier === 'free' ? 'Free' : 'Lifetime';
  return {
    refused,
    messages,
    refusedCount,
    note:
      refusedCount > 0
        ? `${refusedCount} of these are over the ${planName} limit and won't render.`
        : null,
  };
}
