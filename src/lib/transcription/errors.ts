/**
 * Error-shaping helpers for the transcription provider chain.
 *
 * The Gemini provider tries model candidates in order (primary first).
 * When every candidate fails, the thrown error must attribute the
 * failure honestly: the PRIMARY model's failure leads, and each
 * model's own message is labeled with its name. (Previously the chain
 * threw whichever error came last, so users were shown the fallback
 * model's message — e.g. its "no longer available to new users" 404 —
 * as if it were the whole story, even when the primary had failed for
 * a different, more relevant reason.)
 */

export interface ModelAttemptFailure {
  model: string;
  message: string;
}

/**
 * Collapse raw per-attempt failures to one entry per model (the last
 * attempt's message wins — that's the state the model ended in),
 * preserving first-tried order, i.e. primary first.
 */
export function dedupeModelFailures(attempts: ModelAttemptFailure[]): ModelAttemptFailure[] {
  const order: string[] = [];
  const byModel = new Map<string, string>();
  for (const a of attempts) {
    if (!byModel.has(a.model)) order.push(a.model);
    byModel.set(a.model, a.message);
  }
  return order.map((model) => ({ model, message: byModel.get(model) as string }));
}

/** Human-readable combined summary, primary failure first. */
export function summarizeModelFailures(attempts: ModelAttemptFailure[]): string {
  const failures = dedupeModelFailures(attempts);
  if (failures.length === 0) return 'Transcription failed on all models.';
  if (failures.length === 1) return failures[0].message;
  const parts = failures.map((f) => `${f.model}: ${f.message}`);
  return `Transcription failed on all models — ${parts.join('; ')}`;
}
