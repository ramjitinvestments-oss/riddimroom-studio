import { describe, expect, it } from 'vitest';
import {
  humanizeUploadError,
  UPLOAD_EMPTY_MESSAGE,
  UPLOAD_NETWORK_MESSAGE,
  UPLOAD_QUOTA_MESSAGE,
  UPLOAD_TOO_LARGE_MESSAGE,
  UPLOAD_UNAUTHORIZED_MESSAGE,
  UPLOAD_UNKNOWN_MESSAGE,
  UPLOAD_UNSUPPORTED_MESSAGE,
} from './uploadErrors';

describe('R40 P-14 — upload failures in plain words', () => {
  it('maps the storage quota code to the out-of-space sentence', () => {
    const err = { code: 'storage/quota-exceeded', message: 'User quota exceeded.' };
    expect(humanizeUploadError(err)).toBe(UPLOAD_QUOTA_MESSAGE);
    expect(UPLOAD_QUOTA_MESSAGE).toContain("You're out of storage space");
  });

  it('maps a too-large validation message to the smaller-file sentence', () => {
    expect(humanizeUploadError('File is 512.0 MB, which exceeds the 500 MB upload limit.')).toBe(
      UPLOAD_TOO_LARGE_MESSAGE,
    );
  });

  it('maps unauthorized errors to the sign-in sentence', () => {
    expect(humanizeUploadError({ code: 'storage/unauthorized', message: 'User is not authorized.' })).toBe(
      UPLOAD_UNAUTHORIZED_MESSAGE,
    );
  });

  it('maps network failures to the connection sentence', () => {
    expect(humanizeUploadError(new Error('Failed to fetch'))).toBe(UPLOAD_NETWORK_MESSAGE);
    expect(humanizeUploadError({ code: 'storage/retry-limit-exceeded' })).toBe(UPLOAD_NETWORK_MESSAGE);
  });

  it('maps unsupported and empty files to their own sentences', () => {
    expect(humanizeUploadError('Unsupported file type "text/plain". Please choose an image, video, or audio file.')).toBe(
      UPLOAD_UNSUPPORTED_MESSAGE,
    );
    expect(humanizeUploadError('This file is empty (0 bytes).')).toBe(UPLOAD_EMPTY_MESSAGE);
  });

  it('never returns the raw message or a service code', () => {
    const raw = 'storage/unknown: backend exploded (raw detail xyz)';
    const out = humanizeUploadError({ code: 'storage/unknown', message: raw });
    expect(out).toBe(UPLOAD_UNKNOWN_MESSAGE);
    expect(out).not.toContain('storage/');
    expect(out).not.toContain('xyz');
    expect(humanizeUploadError(null)).toBe(UPLOAD_UNKNOWN_MESSAGE);
    expect(humanizeUploadError(undefined)).toBe(UPLOAD_UNKNOWN_MESSAGE);
  });
});
