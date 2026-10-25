import { mergeLineSets, type OcrLine } from './readout';
import { isThinRead, rescueRead } from './paddleEngine';

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

function toLines(
  data: { lines?: TessLine[] },
  width: number,
  height: number,
  yOffsetPx = 0,
  fullHeight = height,
): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const line of data.lines || []) {
    const text = (line.text || '').trim();
    if (!text) continue;
    lines.push({
      text,
      confidence: Math.round(line.confidence || 0),
      y: line.bbox ? (line.bbox.y0 + yOffsetPx) / fullHeight : 0,
      box: line.bbox
        ? {
            x: line.bbox.x0 / width,
            y: (line.bbox.y0 + yOffsetPx) / fullHeight,
            w: (line.bbox.x1 - line.bbox.x0) / width,
            h: (line.bbox.y1 - line.bbox.y0) / fullHeight,
          }
        : undefined,
    });
  }
  return lines;
}

/** Crop one horizontal band of the prepared canvas into its own
    data URL for a region read (R18). Returns null when the band is
    degenerate. */
function cropBand(canvas: HTMLCanvasElement, y0: number, y1: number): { url: string; y0: number; height: number } | null {
  const top = Math.max(0, Math.floor(y0));
  const height = Math.min(canvas.height, Math.ceil(y1)) - top;
  if (height < 24) return null;
  const band = document.createElement('canvas');
  band.width = canvas.width;
  band.height = height;
  const bctx = band.getContext('2d');
  if (!bctx) return null;
  bctx.drawImage(canvas, 0, top, canvas.width, height, 0, 0, canvas.width, height);
  return { url: band.toDataURL('image/png'), y0: top, height };
}

/**
 * R20 contrast variant of a band: a per-pixel stretch around the
 * midpoint ((v−128)×1.4+128, clamped). Faded print on busy grounds
 * is where the plain region read starves; the stretch is applied to
 * the CROP ONLY (a global stretch measurably hurt these arts in R13
 * testing and stays banned), and the merge keeps whichever read of
 * each line is cleaner — the variant can only add candidates.
 */
function contrastBandUrl(canvas: HTMLCanvasElement, y0: number, y1: number): string | null {
  const top = Math.max(0, Math.floor(y0));
  const height = Math.min(canvas.height, Math.ceil(y1)) - top;
  if (height < 24) return null;
  const band = document.createElement('canvas');
  band.width = canvas.width;
  band.height = height;
  const bctx = band.getContext('2d');
  if (!bctx) return null;
  bctx.drawImage(canvas, 0, top, canvas.width, height, 0, 0, canvas.width, height);
  try {
    const img = bctx.getImageData(0, 0, band.width, band.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = (d[i + c] - 128) * 1.4 + 128;
        d[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    bctx.putImageData(img, 0, 0);
  } catch {
    return null;
  }
  return band.toDataURL('image/png');
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
    if (!onProgress) return;
    const span = phase === 0 ? [0, 0.4] : phase === 1 ? [0.4, 0.7] : [0.7, 1];
    onProgress(span[0] + fraction * (span[1] - span[0]), stage);
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
    let merged = mergeLineSets(autoLines, sparseLines);

    // R18 region reads: two targeted re-reads as BLOCKS (PSM 6) —
    // the top band where brands live, and the band around the
    // largest line (the headline zone). A band read sees its text
    // bigger and less distracted than the full-page passes; the
    // merge keeps whichever read of a line is cleaner. Global
    // tricks (inversion, blanket upscale) measurably HURT these
    // arts in R13 testing and stay banned — regions only.
    phase = 2;
    try {
      const bands: Array<{ url: string; y0: number; height: number }> = [];
      const top = cropBand(canvas, 0, canvas.height * 0.38);
      if (top) bands.push(top);
      let biggest: OcrLine | undefined;
      for (const l of merged) {
        if (l.box && (!biggest?.box || l.box.h > biggest.box.h)) biggest = l;
      }
      if (biggest?.box) {
        const y0 = (biggest.box.y - biggest.box.h * 0.6) * canvas.height;
        const y1 = (biggest.box.y + biggest.box.h * 1.6) * canvas.height;
        const headlineBand = cropBand(canvas, y0, y1);
        // Skip when the headline band is basically the top band again.
        if (headlineBand && Math.abs(headlineBand.y0 - (top?.y0 ?? -1)) > canvas.height * 0.08) bands.push(headlineBand);
      }
      if (bands.length > 0) {
        await worker.setParameters({ tessedit_pageseg_mode: '6' });
        for (const band of bands) {
          try {
            const region = await worker.recognize(band.url);
            merged = mergeLineSets(merged, toLines(region.data, canvas.width, canvas.height, band.y0, canvas.height));
          } catch {
            /* a failed band never sinks the read */
          }
          // R20: the contrast-stretched twin of the same band.
          try {
            const twin = contrastBandUrl(canvas, band.y0, band.y0 + band.height);
            if (twin) {
              const stretched = await worker.recognize(twin);
              merged = mergeLineSets(merged, toLines(stretched.data, canvas.width, canvas.height, band.y0, canvas.height));
            }
          } catch {
            /* the twin is a bonus read, never a blocker */
          }
        }
      }
    } catch {
      /* region reads are an enhancement, never a blocker */
    } finally {
      try {
        await worker.setParameters({ tessedit_pageseg_mode: '3' });
      } catch {
        /* restore is best-effort */
      }
    }

    // R20 rescue pass: when the Tesseract stack came back thin —
    // the signature of heavy display/brush art — a second on-device
    // engine (PP-OCRv6) takes one look and its lines merge in as
    // candidates. Fully failure-tolerant: the Tesseract read stands
    // whenever the rescue can't run. See paddleEngine.ts for the
    // benchmark that justifies the trigger and the model choice.
    if (isThinRead(merged)) {
      try {
        if (onProgress) onProgress(0.92, 'deep-reading display type');
        const rescue = await rescueRead(canvas);
        if (rescue.length > 0) merged = mergeLineSets(merged, rescue);
      } catch {
        /* rescue is a bonus, never a blocker */
      }
    }
    return merged;
  } finally {
    progressSink = null;
  }
}
