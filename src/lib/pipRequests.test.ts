/**
 * R36 WS-1 — PiP request events: dispatch shape + the claim rule that
 * stops duplicate MediaImportPanel mounts answering the same request.
 */
import { describe, it, expect } from 'vitest';
import {
  PIP_CLAIM_WINDOW_MS,
  RECORD_PIP_EVENT,
  UPLOAD_PIP_EVENT,
  answerPipRequest,
  claimPipRequest,
  isPipRequestAnswered,
  markPipRequestRedispatched,
  releasePipRequestClaim,
  requestRecordPip,
  requestUploadPip,
} from './pipRequests';

describe('pipRequests dispatch', () => {
  it('requestRecordPip / requestUploadPip dispatch CustomEvents with the exact names on the given target', () => {
    const seen: Array<{ type: string }> = [];
    const target = {
      dispatchEvent: (event: unknown) => {
        seen.push(event as { type: string });
        return true;
      },
    };
    // A no-op scheduler keeps the P-42 retry timer out of this shape test.
    expect(requestRecordPip(target, { schedule: () => {} })).toBe(true);
    expect(requestUploadPip(target, { schedule: () => {} })).toBe(true);
    expect(seen.map((e) => e.type)).toEqual([RECORD_PIP_EVENT, UPLOAD_PIP_EVENT]);
    expect(RECORD_PIP_EVENT).toBe('rr:record-pip');
    expect(UPLOAD_PIP_EVENT).toBe('rr:upload-pip');
  });

  it('with no target and no window (server/test env) the request is a safe no-op returning false', () => {
    // vitest runs in node here: there is no global window to dispatch on.
    expect(typeof window).toBe('undefined');
    expect(requestRecordPip(null)).toBe(false);
  });
});

describe('R40 P-42 — claim hygiene: unanswered claims are released, the dispatcher retries once', () => {
  function fakeTarget() {
    const events: Array<{ type: string }> = [];
    return {
      events,
      dispatchEvent: (event: unknown) => {
        events.push(event as { type: string });
        return true;
      },
    };
  }
  function manualScheduler() {
    const timers: Array<() => void> = [];
    return {
      timers,
      schedule: (fn: () => void) => {
        timers.push(fn);
      },
      fireAll: () => {
        const pending = timers.splice(0);
        pending.forEach((fn) => fn());
      },
    };
  }

  it('claim → no answer → window passes → dispatcher retries once → second instance answers', () => {
    const target = fakeTarget();
    const clock = manualScheduler();
    expect(requestRecordPip(target, { schedule: clock.schedule, retryWindowMs: PIP_CLAIM_WINDOW_MS })).toBe(true);
    expect(target.events).toHaveLength(1);
    const instanceA = {};
    const instanceB = {};
    // Instance A claims but never answers (a mounted-but-doomed instance).
    expect(claimPipRequest(target.events[0], instanceA)).toBe(true);
    expect(isPipRequestAnswered(target.events[0])).toBe(false);
    // The window passes: exactly one retry, a FRESH event object.
    clock.fireAll();
    expect(target.events).toHaveLength(2);
    expect(target.events[1]).not.toBe(target.events[0]);
    // The second instance claims the retry and answers it.
    expect(claimPipRequest(target.events[1], instanceB)).toBe(true);
    expect(answerPipRequest(target.events[1], instanceB)).toBe(true);
    expect(isPipRequestAnswered(target.events[1])).toBe(true);
    // No further retries are scheduled by the retry dispatch itself.
    clock.fireAll();
    expect(target.events).toHaveLength(2);
  });

  it('an answered claim triggers no retry', () => {
    const target = fakeTarget();
    const clock = manualScheduler();
    requestUploadPip(target, { schedule: clock.schedule });
    const instance = {};
    expect(claimPipRequest(target.events[0], instance)).toBe(true);
    expect(answerPipRequest(target.events[0], instance)).toBe(true);
    clock.fireAll();
    expect(target.events).toHaveLength(1);
  });

  it('unmount releases: the claiming instance frees its unanswered claim and another instance can claim the same event', () => {
    const event = { type: RECORD_PIP_EVENT };
    const instanceA = {};
    const instanceB = {};
    expect(claimPipRequest(event, instanceA)).toBe(true);
    // A different instance cannot steal or release A's claim.
    expect(releasePipRequestClaim(event, instanceB)).toBe(false);
    expect(claimPipRequest(event, instanceB)).toBe(false);
    // A unmounts and releases — B can now claim and answer.
    expect(releasePipRequestClaim(event, instanceA)).toBe(true);
    expect(claimPipRequest(event, instanceB)).toBe(true);
    expect(answerPipRequest(event, instanceB)).toBe(true);
    // An answered claim can never be released (single-answer guarantee).
    expect(releasePipRequestClaim(event, instanceB)).toBe(false);
    expect(isPipRequestAnswered(event)).toBe(true);
  });

  it('only the recorded claimant may answer, and the redispatch guard fires once', () => {
    const event = { type: UPLOAD_PIP_EVENT };
    const instanceA = {};
    const instanceB = {};
    expect(claimPipRequest(event, instanceA)).toBe(true);
    expect(answerPipRequest(event, instanceB)).toBe(false);
    expect(markPipRequestRedispatched(event)).toBe(true);
    expect(markPipRequestRedispatched(event)).toBe(false);
  });
});

describe('pipRequests claim rule', () => {
  it('the first claimant of an event object wins; later claims of the SAME object fail', () => {
    const event = { type: RECORD_PIP_EVENT };
    expect(claimPipRequest(event)).toBe(true);
    expect(claimPipRequest(event)).toBe(false);
    expect(claimPipRequest(event)).toBe(false);
  });

  it('a fresh event object can be claimed again (the next request works)', () => {
    const first = { type: RECORD_PIP_EVENT };
    const second = { type: RECORD_PIP_EVENT };
    expect(claimPipRequest(first)).toBe(true);
    expect(claimPipRequest(second)).toBe(true);
  });

  it('record and upload claims are independent objects in practice (one dispatch each)', () => {
    const record = { type: RECORD_PIP_EVENT };
    const upload = { type: UPLOAD_PIP_EVENT };
    expect(claimPipRequest(record)).toBe(true);
    expect(claimPipRequest(upload)).toBe(true);
  });
});
