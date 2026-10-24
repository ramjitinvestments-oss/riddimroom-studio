import { describe, it, expect } from 'vitest';
import {
  messageForNonJsonTranscribeResponse,
  messageForTranscribeFetchFailure,
  TRANSCRIBE_NO_RESPONSE_MESSAGE,
  TRANSCRIBE_UNREACHABLE_MESSAGE,
  TRANSCRIBE_UNREADABLE_RESPONSE_MESSAGE,
} from './clientErrors';

describe('messageForNonJsonTranscribeResponse', () => {
  it('names the timeout/server class and the retry remedy', () => {
    const msg = messageForNonJsonTranscribeResponse();
    expect(msg).toBe(TRANSCRIBE_NO_RESPONSE_MESSAGE);
    expect(msg.toLowerCase()).toContain('try again');
  });
});

describe('messageForTranscribeFetchFailure', () => {
  it('maps a body-parse SyntaxError to the unreadable-response message', () => {
    expect(messageForTranscribeFetchFailure(new SyntaxError("Unexpected token '<'"))).toBe(TRANSCRIBE_UNREADABLE_RESPONSE_MESSAGE);
  });

  it('maps a network TypeError to the unreachable message', () => {
    expect(messageForTranscribeFetchFailure(new TypeError('Failed to fetch'))).toBe(TRANSCRIBE_UNREACHABLE_MESSAGE);
  });

  it("passes through a readable error's own message, with a fallback", () => {
    expect(messageForTranscribeFetchFailure(new Error('boom'))).toBe('boom');
    expect(messageForTranscribeFetchFailure({})).toBe('Transcription request failed.');
    expect(messageForTranscribeFetchFailure(null)).toBe('Transcription request failed.');
  });
});

describe('no false "preview build" claim survives in any mapped message', () => {
  it('none of the user-facing strings mention a preview build', () => {
    const all = [
      messageForNonJsonTranscribeResponse(),
      messageForTranscribeFetchFailure(new SyntaxError('x')),
      messageForTranscribeFetchFailure(new TypeError('x')),
    ];
    for (const m of all) expect(m.toLowerCase()).not.toContain('preview');
  });
});
