import { describe, it, expect } from 'vitest';
import { humanizeExportError, EXPORT_FINISHING_ERROR, EXPORT_GENERIC_ERROR, EXPORT_MEDIA_LOAD_ERROR } from './exportErrors';

describe('humanizeExportError', () => {
  it('(i) maps the storage/CORS validation string to the finishing string — raw text never passes through', () => {
    const raw = 'Export produced an empty file. This usually means the browser blocked canvas capture (see storage.cors.json requirements).';
    const out = humanizeExportError(new Error(raw));
    expect(out).toBe(EXPORT_FINISHING_ERROR);
    expect(out).not.toContain('storage.cors.json');
    expect(out).not.toContain('CORS');
  });

  it('(i) maps the suspiciously-small-file CORS string to the finishing string', () => {
    const raw = "Export produced a suspiciously small file (812 bytes for 12.0s). This usually means the Storage bucket's CORS configuration is blocking canvas capture — see storage.cors.json.";
    const out = humanizeExportError(new Error(raw));
    expect(out).toBe(EXPORT_FINISHING_ERROR);
    expect(out).not.toContain('storage.cors.json');
  });

  it('(i) maps the canvas-capture developer instruction to the finishing string', () => {
    const raw = 'Export could not capture the preview canvas — a clip loaded without CORS access. Storage CORS must allow this app for exports; check the connection and try again.';
    const out = humanizeExportError(new Error(raw));
    expect(out).toBe(EXPORT_FINISHING_ERROR);
    expect(out).not.toContain('Storage CORS must allow');
  });

  it('(i) maps a bare SecurityError (tainted canvas) to the finishing string', () => {
    const err = new Error('Failed to execute captureStream on HTMLCanvasElement');
    err.name = 'SecurityError';
    expect(humanizeExportError(err)).toBe(EXPORT_FINISHING_ERROR);
  });

  it('(ii) maps the ffmpeg exit-code string to the finishing string — exit code never passes through', () => {
    const out = humanizeExportError(new Error('MP4 conversion failed (ffmpeg exited with code 1).'));
    expect(out).toBe(EXPORT_FINISHING_ERROR);
    expect(out).not.toContain('ffmpeg');
    expect(out).not.toContain('code 1');
  });

  it('(ii) maps conversion errors by error name even with an opaque message', () => {
    const err = new Error('wasm internal state 0x2f');
    err.name = 'Mp4TranscodeError';
    expect(humanizeExportError(err)).toBe(EXPORT_FINISHING_ERROR);
    const loadErr = new Error('engine gone');
    loadErr.name = 'TranscoderLoadTimeoutError';
    expect(humanizeExportError(loadErr)).toBe(EXPORT_FINISHING_ERROR);
  });

  it('(iii) maps empty-file validation failures to the finishing string', () => {
    expect(humanizeExportError(new Error('MP4 conversion produced an empty file.'))).toBe(EXPORT_FINISHING_ERROR);
    expect(humanizeExportError(new Error('Cannot convert an empty recording to MP4.'))).toBe(EXPORT_FINISHING_ERROR);
    expect(humanizeExportError(new Error('Export produced an unexpected file type "".'))).toBe(EXPORT_FINISHING_ERROR);
    expect(humanizeExportError('Export failed validation.')).toBe(EXPORT_FINISHING_ERROR);
  });

  it('keeps the media-load failure as its own plain string', () => {
    const out = humanizeExportError(new Error('Media failed to load (clip one.mp4) — export cancelled. Check your connection or file access, then try again.'));
    expect(out).toBe(EXPORT_MEDIA_LOAD_ERROR);
  });

  it('(iv) maps unknown errors to the plain generic — never the raw message', () => {
    const raw = 'TypeError: Cannot read properties of undefined (reading "getContext") at renderLoop';
    const out = humanizeExportError(new Error(raw));
    expect(out).toBe(EXPORT_GENERIC_ERROR);
    expect(out).not.toContain('TypeError');
    expect(out).not.toContain('getContext');
  });

  it('(iv) maps non-Error inputs to the plain generic', () => {
    expect(humanizeExportError(null)).toBe(EXPORT_GENERIC_ERROR);
    expect(humanizeExportError(undefined)).toBe(EXPORT_GENERIC_ERROR);
    expect(humanizeExportError({ weird: true })).toBe(EXPORT_GENERIC_ERROR);
    expect(humanizeExportError('some raw string from deep inside')).toBe(EXPORT_GENERIC_ERROR);
  });

  it('is idempotent on its own strings', () => {
    expect(humanizeExportError(new Error(EXPORT_FINISHING_ERROR))).toBe(EXPORT_FINISHING_ERROR);
    expect(humanizeExportError(EXPORT_GENERIC_ERROR)).toBe(EXPORT_GENERIC_ERROR);
    expect(humanizeExportError(EXPORT_MEDIA_LOAD_ERROR)).toBe(EXPORT_MEDIA_LOAD_ERROR);
  });

  it('contains no blocklist tokens in any output string', () => {
    for (const s of [EXPORT_FINISHING_ERROR, EXPORT_GENERIC_ERROR, EXPORT_MEDIA_LOAD_ERROR]) {
      for (const token of ['OCR', 'verbatim', 'H.264', 'Mbps', 'element bands', 'HTTP ', '600 seconds', 'VP9', 'VP8', 'AV1', 'Kbps']) {
        expect(s).not.toContain(token);
      }
    }
  });
});
