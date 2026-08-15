/**
 * RiddimRoom Studio — background removal (Phase 1 Step 7).
 *
 * Provider abstraction (mirrors `src/lib/transcription`'s pattern) so the
 * current implementation — `@imgly/background-removal`, a client-side WASM
 * model, no API key/credential required, dynamically imported so its
 * (multi-MB) model weights are never in the main bundle — can be swapped
 * for a stronger server-side/hosted model later without touching callers.
 * Runs entirely in the browser: fetches the source image bytes, segments
 * foreground/background locally, returns a transparent PNG.
 */

export interface BackgroundRemovalProvider {
  readonly name: string;
  removeBackground(image: Blob, onProgress?: (fraction: number) => void): Promise<Blob>;
}

class ImglyBackgroundRemovalProvider implements BackgroundRemovalProvider {
  readonly name = 'imgly-isnet';

  async removeBackground(image: Blob, onProgress?: (fraction: number) => void): Promise<Blob> {
    const { removeBackground } = await import('@imgly/background-removal');
    return removeBackground(image, {
      progress: (_key, current, total) => {
        if (onProgress && total > 0) onProgress(current / total);
      },
    });
  }
}

export function getBackgroundRemovalProvider(): BackgroundRemovalProvider {
  return new ImglyBackgroundRemovalProvider();
}
