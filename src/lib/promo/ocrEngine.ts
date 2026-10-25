import type { OcrLine } from './readout';

/**
 * The dedicated artwork engine — Tesseract OCR running ENTIRELY on
 * the device. This replaces the Gemini server read (retired in R11
 * after three rounds of failures that could not be diagnosed from
 * outside the owner's session): no server, no API key, no quota,
 * no network round-trip per read — and its output is exactly what
 * the proof run measured on the owner's own images.
 *
 * The engine's assets (script, worker, WASM core, English language
 * data) load from pinned jsDelivr URLs — the same runtime-CDN
 * pattern as the premium fonts — so no binary ever enters the repo.
 * First load takes a few seconds; the worker is then reused and the
 * browser caches the assets.
 */

const SCRIPT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.0.5/dist/tesseract.min.js';
const WORKER_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.0.5/dist/worker.min.js';
const CORE_PATH = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.0';
const LANG_PATH = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0';

/** OCR works best around 1600px wide: small art is upscaled, huge art downscaled. */
const TARGET_WIDTH = 1600;

interface TesseractGlobal {
  createWorker: (
    langs: string,
    oem: number,
    options: Record<string, unknown>,
  ) => Promise<{
    recognize: (image: string) => Promise<{ data: { lines?: Array<{ text: string; confidence: number; bbox?: { y0: number } }> } }>;
  }>;
}

declare global {
  interface Window {
    Tesseract?: TesseractGlobal;
  }
}

let scriptPromise: Promise<TesseractGlobal> | null = null;
let workerPromise: Promise<Awaited<ReturnType<TesseractGlobal['createWorker']>>> | null = null;

function loadEngineScript(): Promise<TesseractGlobal> {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!scriptPromise) {
    scriptPromise = new Promise<TesseractGlobal>((resolve, reject) => {
      const el = document.createElement('script');
      el.src = SCRIPT_URL;
      el.async = true;
      el.onload = () => {
        if (window.Tesseract) resolve(window.Tesseract);
        else reject(new Error('OCR engine script loaded without the engine.'));
      };
      el.onerror = () => reject(new Error('OCR engine could not be loaded (network).'));
      document.head.appendChild(el);
    });
  }
  return scriptPromise;
}

async function getWorker(onProgress?: (fraction: number, stage: string) => void) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const T = await loadEngineScript();
      return T.createWorker('eng', 1, {
        workerPath: WORKER_URL,
        corePath: CORE_PATH,
        langPath: LANG_PATH,
        logger: (m: { status?: string; progress?: number }) => {
          if (onProgress && typeof m.progress === 'number') onProgress(m.progress, m.status || 'working');
        },
      });
    })();
    // A failed load must not poison later attempts.
    workerPromise.catch(() => {
      workerPromise = null;
      scriptPromise = null;
    });
  }
  return workerPromise;
}

/**
 * Read every text line in the artwork, on-device. Progress reports
 * the engine's own recognize fraction (0..1). Throws on load
 * failure so the caller can say so in plain words.
 */
export async function analyzeArtwork(
  bitmap: ImageBitmap,
  onProgress?: (fraction: number, stage: string) => void,
): Promise<OcrLine[]> {
  const scale = TARGET_WIDTH / bitmap.width;
  const canvas = document.createElement('canvas');
  canvas.width = TARGET_WIDTH;
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable for artwork analysis.');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/png');

  const worker = await getWorker(onProgress);
  const { data } = await worker.recognize(dataUrl);
  const lines: OcrLine[] = [];
  for (const line of data.lines || []) {
    const text = (line.text || '').trim();
    if (!text) continue;
    lines.push({
      text,
      confidence: Math.round(line.confidence || 0),
      y: line.bbox ? line.bbox.y0 / canvas.height : 0,
    });
  }
  return lines;
}
