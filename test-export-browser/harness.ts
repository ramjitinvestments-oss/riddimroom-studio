/**
 * Browser-only smoke test for the export engine (Canvas2DRenderer). Not
 * part of the shipped app — run once via Playwright to prove the actual
 * canvas/MediaRecorder/AudioContext pipeline produces a real, usable video
 * file end to end, using a same-origin synthetic source (no Firebase
 * Storage / CORS dependency) so this test isolates the renderer's own
 * mechanics from the separate, already-documented CORS operational
 * requirement.
 */
import { createEmptyProject, createTrack, addTrack, addItem, addMediaAsset, generateTimelineId } from '../src/lib/timeline/utils';
import { addTextItem, addWatermarkItem, addCaptionItems } from '../src/lib/timeline/insert';
import { Canvas2DRenderer } from '../src/lib/export/canvas2dRenderer';
import { validateRenderResult } from '../src/lib/export/validate';
import type { MediaAsset, TrackType, VideoTimelineItem } from '../src/types/timeline';

interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

async function makeSyntheticVideoBlob(durationSeconds: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext('2d')!;
  const stream = (canvas as HTMLCanvasElement & { captureStream: (fps?: number) => MediaStream }).captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
  });
  recorder.start(100);
  const start = performance.now();
  await new Promise<void>((resolve) => {
    function draw() {
      const t = (performance.now() - start) / 1000;
      ctx.fillStyle = `hsl(${(t * 120) % 360},80%,50%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'white';
      ctx.font = '20px sans-serif';
      ctx.fillText(`t=${t.toFixed(2)}`, 10, 30);
      if (t < durationSeconds) requestAnimationFrame(draw);
      else resolve();
    }
    requestAnimationFrame(draw);
  });
  recorder.stop();
  return done;
}

async function run() {
  const checks: CheckResult[] = [];
  const check = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass: !!pass, detail });
  const results: Record<string, unknown> = { checks };

  try {
    const videoBlob = await makeSyntheticVideoBlob(3);
    const videoUrl = URL.createObjectURL(videoBlob);
    check('Synthetic source video blob has real bytes', videoBlob.size > 1000, `size=${videoBlob.size}`);

    const imgCanvas = document.createElement('canvas');
    imgCanvas.width = 64;
    imgCanvas.height = 64;
    const imgCtx = imgCanvas.getContext('2d')!;
    imgCtx.fillStyle = 'red';
    imgCtx.fillRect(0, 0, 64, 64);
    const imageDataUrl = imgCanvas.toDataURL('image/png');

    let project = createEmptyProject({ ownerUid: 'test-uid' });
    const specs: Array<[TrackType, string]> = [
      ['video', 'Main Video'],
      ['image', 'Watermark'],
      ['text', 'Text'],
      ['caption', 'Captions'],
      ['audio', 'Original Audio'],
    ];
    specs.forEach(([type, name], i) => {
      project = addTrack(project, createTrack(type, name, i));
    });

    const videoAsset: MediaAsset = {
      id: 'vid1',
      kind: 'video',
      storageUrl: videoUrl,
      fileName: 'synthetic.webm',
      sizeBytes: videoBlob.size,
      mimeType: 'video/webm',
      durationSeconds: 3,
      width: 320,
      height: 240,
      createdAt: Date.now(),
    };
    project = addMediaAsset(project, videoAsset);
    const videoTrack = project.tracks.find((t) => t.type === 'video')!;
    const videoItem: VideoTimelineItem = {
      id: generateTimelineId('item'),
      type: 'video',
      trackId: videoTrack.id,
      startTime: 0,
      endTime: 3,
      zIndex: 0,
      visible: true,
      mediaAssetId: 'vid1',
      position: { x: 50, y: 50 },
      scale: 1,
      rotation: 0,
      opacity: 1,
      trimStart: 0,
      trimEnd: 3,
      speed: 1,
      reverse: false,
      volume: 1,
      muted: false,
    };
    project = addItem(project, videoItem);

    project = addTextItem(project, { text: 'Hello Export', atTime: 0.5, durationSeconds: 2 });

    const watermarkAsset: MediaAsset = {
      id: 'wm1',
      kind: 'image',
      storageUrl: imageDataUrl,
      fileName: 'wm.png',
      sizeBytes: 1000,
      mimeType: 'image/png',
      width: 64,
      height: 64,
      createdAt: Date.now(),
    };
    project = addWatermarkItem(project, { asset: watermarkAsset, atTime: 0, durationSeconds: 3 });

    project = addCaptionItems(project, {
      words: [
        { text: 'hi', start: 0, end: 0.4 },
        { text: 'there', start: 0.5, end: 0.9 },
      ],
      atTime: 0,
      captionStyleId: 'classic',
      source: 'manual',
    });

    const renderer = new Canvas2DRenderer();
    const progressFractions: number[] = [];
    const result = await renderer.render(project, { onProgress: (p) => progressFractions.push(p.fraction) });

    check('Renderer produced a non-empty blob', result.blob.size > 0, `size=${result.blob.size}`);
    check('Renderer reports a video/webm mimeType', result.mimeType.startsWith('video/webm'), result.mimeType);
    check('Renderer duration matches project duration (~3s)', Math.abs(result.durationSeconds - 3) < 0.5, `${result.durationSeconds}`);
    check('Progress callback fired at least once', progressFractions.length > 0, `count=${progressFractions.length}`);

    const validation = validateRenderResult(result.blob, result.durationSeconds);
    check('validateRenderResult accepts the real export output', validation.valid, validation.error);

    results.blobSize = result.blob.size;
    results.durationSeconds = result.durationSeconds;
  } catch (err: any) {
    results.crashed = true;
    results.error = err?.message || String(err);
    results.stack = err?.stack;
  }

  (window as any).__EXPORT_TEST_RESULT__ = results;
}

run();
