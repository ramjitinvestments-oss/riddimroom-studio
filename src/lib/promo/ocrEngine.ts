import { mergeLineSets, type OcrLine } from './readout';

/**
 * The dedicated artwork engine — Tesseract OCR running ENTIRELY on
 * the device. This replaced the Gemini server read (retired in R11
 * after three rounds of failures that could not be diagnosed from
 * outside the owner's session): no server, no API key, no quota,
 * no network round-trip per read.
 *
 * R13 — TWO PASSES, because poster art defeats any single one: the
 * auto pass reads composed lines; a sparse-text pass then finds
 * scattered words the line pass missed (measured on the owner's
 * G.S.Y.M. design, where sparse recovered SAVED + MIND at 96%).
 * `mergeLineSets` fuses the two without duplicates.
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

interface TessLine {
  text: string;
  confidence: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number };
}

interface TessWorker {
  recognize: (image: string) => Promise<{ data: { lines?: TessLine[] } }>;
  setParameters: (params: Record<string, string>) => Promise<unknown>;
}

interface TesseractGlobal {
  createWorker: (langs: string, oem: number, options: Record<string, unknown>) => Promise<TessWorker>;
}

declare global {
  interface Window {
    Tesseract?: TesseractGlobal;
  }
}

let scriptPromise: Promise<TesseractGlobal> | null = null;
let workerPromise: Promise<TessWorker> | null = null;
/** The in-flight analyze call's progress sink (the worker is shared,
    so the logger forwards to whoever is currently reading). */
let progressSink: ((fraction: number, stage: string) => void) | null = null;

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

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const T = await loadEngineScript();
      return T.createWorker('eng', 1, {
        workerPath: WORKER_URL,
        corePath: CORE_PATH,
        langPath: LANG_PATH,
        logger: (m: { status?: string; progress?: number }) => {
          if (progressSink && typeof m.progress === 'number') progressSink(m.progress, m.status || 'working');
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

function toLines(data: { lines?: TessLine[] }, width: number, height: number): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const line of data.lines || []) {
    const text = (line.text || '').trim();
    if (!text) continue;
    lines.push({
      text,
      confidence: Math.round(line.confidence || 0),
      y: line.bbox ? line.bbox.y0 / height : 0,
      box: line.bbox
        ? {
            x: line.bbox.x0 / width,
            y: line.bbox.y0 / height,
            w: (line.bbox.x1 - line.bbox.x0) / width,
            h: (line.bbox.y1 - line.bbox.y0) / height,
          }
        : undefined,
    });
  }
  return lines;
}

/**
 * Read every text line in the artwork, on-device, in two passes
 * (auto lines, then sparse words) merged into one line set.
 * Progress reports a combined 0..1 fraction across both passes.
 * Throws on load failure so the caller can say so in plain words.
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

  const worker = await getWorker();
  let phase = 0;
  progressSink = (fraction, stage) => {
    if (onProgress) onProgress(phase === 0 ? fraction * 0.5 : 0.5 + fraction * 0.5, stage);
  };
  try {
    const first = await worker.recognize(dataUrl);
    const autoLines = toLines(first.data, canvas.width, canvas.height);
    phase = 1;
    let sparseLines: OcrLine[] = [];
    try {
      await worker.setParameters({ tessedit_pageseg_mode: '11' });
      const second = await worker.recognize(dataUrl);
      sparseLines = toLines(second.data, canvas.width, canvas.height);
    } catch {
      sparseLines = [];
    } finally {
      try {
        await worker.setParameters({ tessedit_pageseg_mode: '3' });
      } catch {
        /* restore is best-effort */
      }
    }
    return mergeLineSets(autoLines, sparseLines);
  } finally {
    progressSink = null;
  }
}
