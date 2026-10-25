/**
 * Audio helpers for the Promo flow (R20). The built-in music pack
 * and synth loops were REMOVED on the owner's directive — the app
 * adds no audio of its own; the only music in a promo is the user's
 * own uploaded track. What remains here is the duration probe the
 * fit/start math runs on.
 */

/**
 * Probe an audio file's REAL duration via an off-DOM audio element
 * (the upload pipeline's metadata can disagree — the fit math must
 * run on the truth). Resolves null when the browser can't say.
 */
export function probeAudioDurationSeconds(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const el = new Audio();
      const done = (value: number | null) => {
        URL.revokeObjectURL(url);
        resolve(value);
      };
      el.addEventListener('loadedmetadata', () => {
        done(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
      });
      el.addEventListener('error', () => done(null));
      el.src = url;
    } catch {
      resolve(null);
    }
  });
}
