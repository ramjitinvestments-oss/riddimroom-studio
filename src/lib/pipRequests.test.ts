/**
 * R36 WS-1 — PiP request events: dispatch shape + the claim rule that
 * stops duplicate MediaImportPanel mounts answering the same request.
 */
import { describe, it, expect } from 'vitest';
import {
  RECORD_PIP_EVENT,
  UPLOAD_PIP_EVENT,
  claimPipRequest,
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
    expect(requestRecordPip(target)).toBe(true);
    expect(requestUploadPip(target)).toBe(true);
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
