import { describe, it, expect } from 'vitest';
import { dedupeModelFailures, summarizeModelFailures } from './errors';

describe('summarizeModelFailures — provider-chain error attribution', () => {
  it('leads with the PRIMARY model failure and labels every model', () => {
    const summary = summarizeModelFailures([
      { model: 'gemini-3.8-flash', message: '503 UNAVAILABLE: high demand' },
      { model: 'gemini-2.5-flash', message: '404 NOT_FOUND: no longer available to new users' },
    ]);
    // The regression this guards: users used to be shown ONLY the
    // fallback (last) model's message as if it were the whole error.
    expect(summary).toContain('gemini-3.8-flash');
    expect(summary).toContain('503 UNAVAILABLE');
    expect(summary).toContain('gemini-2.5-flash');
    expect(summary).toContain('404 NOT_FOUND');
    expect(summary.indexOf('gemini-3.8-flash')).toBeLessThan(summary.indexOf('gemini-2.5-flash'));
  });

  it('returns a single model failure bare (no chain framing)', () => {
    expect(summarizeModelFailures([{ model: 'gemini-3.8-flash', message: 'quota exceeded' }])).toBe('quota exceeded');
  });

  it('handles no recorded failures without inventing a cause', () => {
    expect(summarizeModelFailures([])).toBe('Transcription failed on all models.');
  });
});

describe('dedupeModelFailures', () => {
  it("keeps the last attempt's message per model, in first-tried order", () => {
    expect(
      dedupeModelFailures([
        { model: 'gemini-3.8-flash', message: '503 first try' },
        { model: 'gemini-3.8-flash', message: '503 after retry' },
        { model: 'gemini-2.5-flash', message: '404' },
      ]),
    ).toEqual([
      { model: 'gemini-3.8-flash', message: '503 after retry' },
      { model: 'gemini-2.5-flash', message: '404' },
    ]);
  });
});
