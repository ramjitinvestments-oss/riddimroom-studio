/**
 * R34 (R33 audit §2 error-string audit + Quick win 8): the export-failure
 * family gets ONE plain user string.
 *
 * Before this module, a minutes-long render could die with developer
 * instructions addressed to end users — "see storage.cors.json",
 * "ffmpeg exited with code {n}", "Storage CORS must allow this app…".
 * Those details still matter for diagnosis, so the throw sites keep them
 * in console.error/console.warn; what the user SEES is mapped here.
 *
 * `humanizeExportError` is pure and total: every input — Error, string,
 * or anything else — comes back as one of the plain strings below, never
 * the raw message. ExportPanel routes every displayed export error
 * through it so nothing raw can surface.
 */

/** The one string for storage/CORS/canvas-capture, conversion, and empty-file failures. */
export const EXPORT_FINISHING_ERROR =
  'Export failed while finishing the file. Your project is saved — try again; if it keeps failing, try a shorter clip or lower quality.';

/** The generic for anything unrecognised — same family, never the raw message. */
export const EXPORT_GENERIC_ERROR = 'Export failed. Your project is saved — please try again.';

/**
 * A clip that couldn't be loaded at all is a different, earlier failure
 * (and the audit's model copy) — kept distinct from the finishing family.
 */
export const EXPORT_MEDIA_LOAD_ERROR =
  'Media failed to load — export cancelled. Check your connection or file access, then try again.';

const CONVERSION_ERROR_NAMES = new Set(['Mp4TranscodeError', 'TranscoderLoadTimeoutError', 'MediabunnyExportError']);

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return '';
}

function nameOf(err: unknown): string {
  if (err instanceof Error) return err.name;
  return '';
}

export function humanizeExportError(err: unknown): string {
  const message = messageOf(err);
  const name = nameOf(err);

  // Already one of ours (e.g. a source module threw the mapped string).
  if (message === EXPORT_FINISHING_ERROR || message === EXPORT_GENERIC_ERROR || message === EXPORT_MEDIA_LOAD_ERROR) {
    return message;
  }

  // A clip failed to load before rendering could finish.
  if (/media failed to load/i.test(message)) return EXPORT_MEDIA_LOAD_ERROR;

  // (i) Storage / CORS / canvas-capture failures.
  if (
    name === 'SecurityError' ||
    /cors/i.test(message) ||
    /storage/i.test(message) ||
    /capture/i.test(message) ||
    /tainted/i.test(message) ||
    /securityerror/i.test(message)
  ) {
    return EXPORT_FINISHING_ERROR;
  }

  // (ii) Conversion failures (the WebM → MP4 stage and the direct engine).
  if (
    CONVERSION_ERROR_NAMES.has(name) ||
    /ffmpeg/i.test(message) ||
    /conversion/i.test(message) ||
    /convert/i.test(message) ||
    /transcod/i.test(message) ||
    /mediabunny/i.test(message)
  ) {
    return EXPORT_FINISHING_ERROR;
  }

  // (iii) Empty / invalid output validation failures.
  if (
    /empty file/i.test(message) ||
    /empty recording/i.test(message) ||
    /suspiciously small/i.test(message) ||
    /unexpected file type/i.test(message) ||
    /failed validation/i.test(message)
  ) {
    return EXPORT_FINISHING_ERROR;
  }

  // (iv) Unknown — a plain generic from the same family, never raw.
  return EXPORT_GENERIC_ERROR;
}
