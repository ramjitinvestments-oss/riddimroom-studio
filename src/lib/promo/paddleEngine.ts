import type { OcrLine } from './readout';

/**
 * The RESCUE engine (R20) — PP-OCRv6-medium via ONNX Runtime Web,
 * running entirely on-device, loaded lazily and ONLY when the
 * Tesseract stack comes back thin. The R20 benchmark (8 synthetic
 * flyers + the owner's real art, ground truth read by eye) is why
 * it exists and why it is not the primary engine:
 *
 *   token recall   Tesseract stack   PP-OCRv6 medium
 *   all 11 images       0.916             0.896
 *   G.S.Y.M. design     0.375             0.750   ← the rescue case
 *   Powerline logo      0.700             0.400
 *   concert poster      1.000             0.833
 *
 * PP-OCR reads the heavy display/brush class Tesseract starves on
 * (it recovered "GOD SAVED YOUR MIND" whole), but it merges words
 * on clean posters and is slower — so Tesseract stays primary and
 * this engine only ever ADDS candidate lines through the same
 * merge the other passes use. Any failure (model CDN unreachable,
 * WASM unsupported) returns [] and the Tesseract read stands.
 */

export interface PaddleResultItem {
  text: string;
  confidence: number; // 0..1
  box: { x: number; y: number; width: number; height: number }; // px, original image
}

/** A read is "thin" when it found little or trusts little of it —
    the signature of display/brush art the primary engine starves on. */
export function isThinRead(lines: OcrLine[]): boolean {
  if (lines.length < 4) return true;
  const mean = lines.reduce((a, l) => a + l.confidence, 0) / lines.length;
  return mean < 55;
}

/** Map PP-OCR results into the shared OcrLine shape (pure). */
export function paddleResultsToLines(results: PaddleResultItem[], width: number, height: number): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const r of results) {
    const text = (r.text || '').trim();
    if (!text || width <= 0 || height <= 0) continue;
    lines.push({
      text,
      confidence: Math.round((r.confidence || 0) * 100),
      y: r.box.y / height,
      box: {
        x: r.box.x / width,
        y: r.box.y / height,
        w: r.box.width / width,
        h: r.box.height / height,
      },
    });
  }
  return lines;
}

interface PaddleServiceLike {
  recognize: (image: ArrayBuffer, options?: Record<string, unknown>) => Promise<{ results?: PaddleResultItem[] }>;
}

let servicePromise: Promise<PaddleServiceLike> | null = null;

async function getRescueService(): Promise<PaddleServiceLike> {
  if (!servicePromise) {
    servicePromise = (async () => {
      const mod = await import('ppu-paddle-ocr/web');
      const service = new mod.PaddleOcrService({ model: mod.V6_MEDIUM_MODEL });
      await service.initialize();
      return service as unknown as PaddleServiceLike;
    })();
    // A failed load must not poison later attempts.
    servicePromise.catch(() => {
      servicePromise = null;
    });
  }
  return servicePromise;
}

/**
 * Run the rescue read over the prepared canvas. NEVER throws —
 * returns [] when the engine can't load or finds nothing.
 */
export async function rescueRead(canvas: HTMLCanvasElement): Promise<OcrLine[]> {
  try {
    const service = await getRescueService();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return [];
    const buffer = await blob.arrayBuffer();
    const result = await service.recognize(buffer, { flatten: true });
    return paddleResultsToLines(result.results ?? [], canvas.width, canvas.height);
  } catch {
    return [];
  }
}
