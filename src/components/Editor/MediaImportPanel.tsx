import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AudioLines, Camera, Clapperboard, PictureInPicture2 } from 'lucide-react';
import { validateMediaFile } from '../../lib/media/validate';
import { uploadMediaFile, type UploadProgressEvent } from '../../lib/media/upload';
import { probeMediaFileCached, mediaKindForMimeType } from '../../lib/media/probe';
import { createImportQueue, MAX_CONCURRENT_UPLOADS, type ImportQueue } from '../../lib/media/importQueue';
import { MAX_MEDIA_SECONDS } from '../../lib/media/constants';
import { generateTimelineId } from '../../lib/timeline/utils';
import type { AudioTimelineItem, MediaAsset } from '../../types/timeline';
import { CameraCapture, type CaptureDualResult, type CaptureResult } from './CameraCapture';
import { TrimSelectModal } from './TrimSelectModal';
import { PipAddButtons } from './PipAddButtons';
import {
  answerPipRequest,
  claimPipRequest,
  markPipRequestRedispatched,
  releasePipRequestClaim,
  RECORD_PIP_EVENT,
  UPLOAD_PIP_EVENT,
} from '../../lib/pipRequests';
import { humanizeUploadError } from '../../lib/media/uploadErrors';

/**
 * Phase 1 Step 4-5 (Capture + Upload).
 *
 * Owns validation -> upload-with-progress -> retry-on-failure for both file
 * import and live camera capture, and hands the caller a finished
 * `MediaAsset` once bytes are actually in Firebase Storage (never keeps
 * media only in React state — the asset object holds a real Storage
 * download URL, not a local blob URL, by the time onAssetUploaded fires).
 *
 * "Universal 30-second media standard" pass: video/audio files are now
 * probed for duration BEFORE any upload starts. A file at or under
 * `MAX_MEDIA_SECONDS` uploads exactly as before. A file over the limit opens
 * `TrimSelectModal` instead — the user picks a <=30s window, and only that
 * window's `trimStart`/`trimEnd` (passed through to `onAssetUploaded`, then
 * `appendMediaToTimeline`) ever lands on the timeline; the full file is
 * still what gets uploaded to Storage (re-uploading a trimmed blob would
 * need a client-side re-encode, out of scope here — the SELECTED WINDOW is
 * what matters for the product rule, not the bytes at rest in Storage).
 * Camera recordings skip this modal entirely (the camera already
 * auto-stops at the limit) but still get defensively clamped in case of a
 * few hundred ms of stop-latency overshoot.
 *
 * WS-S1 (upload speed): uploads run through a bounded import queue
 * (lib/media/importQueue.ts, max 3 concurrent), and `uploadMediaFile`
 * dedupes by sampled content hash against the per-user registry
 * (lib/media/dedupe.ts) — picking a file that was already imported
 * resolves instantly to the existing asset with no re-upload.
 */

interface PendingUpload {
  id: string;
  fileName: string;
  file: File;
  progress: number;
  status: 'uploading' | 'error' | 'done';
  error?: string;
}

/**
 * Tweaks round — every upload enters through one of three unmistakable
 * actions, and the purpose travels with the upload (through the probe /
 * trim-select modal too) so the finished asset lands where the user
 * asked: 'main' → the main timeline, 'overlay' → a PiP/image overlay,
 * 'audio' → the music/audio track. All three run the exact same
 * validate → probe → upload pipeline; purpose only changes the routing
 * callback at the end.
 */
type UploadPurpose = 'main' | 'overlay' | 'audio';

export interface AssetUploadedOptions {
  trimStart?: number;
  trimEnd?: number;
  /** Audio purpose only — device audio lands as a music-track item. */
  role?: AudioTimelineItem['role'];
  /**
   * Overlay purpose only — initial mute state for a video overlay's own
   * audio. Camera recordings routed to the overlay track pass `false`
   * (a talking-head take is meant to be heard); uploaded files omit it
   * and keep the overlay insert path's muted default.
   */
  muted?: boolean;
}

interface UploadMeta {
  trimStart?: number;
  trimEnd?: number;
  isCameraCapture?: boolean;
  purpose?: UploadPurpose;
  /** R29 — dual-camera pair routing: both files of a pair share a group id; see `dualGroupsRef`. */
  dualGroupId?: string;
  dualRole?: 'main' | 'front';
  startDeltaMs?: number;
  /** R32 Phase 4 — the camera review's pair layout, carried through the dual group. */
  dualLayout?: 'pip' | 'split';
  /**
   * R40 P-31 — post-import pair offer tracking: two visual files from
   * ONE main import carry a shared batch id (and their slot in it) so
   * the panel can offer pairing AFTER both have landed normally.
   */
  pairOfferBatchId?: string;
  pairOfferIndex?: 0 | 1;
}

interface PendingTrimSelection {
  file: File;
  kind: 'video' | 'audio';
  durationSeconds: number;
  purpose: UploadPurpose;
  pairOfferBatchId?: string;
  pairOfferIndex?: 0 | 1;
}

interface MediaImportPanelProps {
  uid: string;
  /** The project's canvas dimensions — threaded down to `CameraCapture` so recording can negotiate a matching, non-distorted aspect ratio. */
  canvasWidth: number;
  canvasHeight: number;
  onAssetUploaded: (asset: MediaAsset, options?: AssetUploadedOptions) => void;
  /** "Add Overlay" uploads route here instead (PiP video / corner image overlay). Falls back to `onAssetUploaded` when not provided. */
  onOverlayAssetUploaded?: (asset: MediaAsset, options?: AssetUploadedOptions) => void;
  /** R29 — a finished dual-camera pair (rear main + front overlay) routes here once BOTH files have uploaded. */
  onDualAssetUploaded?: (main: MediaAsset, overlay: MediaAsset, options: { startDeltaMs: number; layout: 'pip' | 'split' }) => void;
  /** R32 Phase 4 — a finished imported pair (two visual files added as a pair) routes here once BOTH files have uploaded. */
  onPairAssetUploaded?: (assetA: MediaAsset, assetB: MediaAsset, options: { layout: 'pip' | 'split' }) => void;
}

export function MediaImportPanel({ uid, canvasWidth, canvasHeight, onAssetUploaded, onOverlayAssetUploaded, onDualAssetUploaded, onPairAssetUploaded }: MediaImportPanelProps) {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [showCamera, setShowCamera] = useState(false);
  // R36 WS-1 — true while the camera is open for "Record PiP": every
  // finished take then lands DIRECTLY as the PiP (see the CameraCapture
  // wiring at the bottom), instead of offering the main/overlay choice.
  const [cameraForPip, setCameraForPip] = useState(false);
  const panelRootRef = useRef<HTMLDivElement>(null);
  const [pendingTrim, setPendingTrim] = useState<PendingTrimSelection | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Tweaks round — one hidden input per clear action (main / overlay /
  // audio). All three feed the exact same `handleFiles`/`startUpload`/
  // `uploadMediaFile` pipeline — the separate inputs exist purely so each
  // action can carry its own `accept` filter and routing purpose, not as
  // parallel upload systems.
  const overlayInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const assetIdByUploadId = useRef<Map<string, string>>(new Map());
  const uploadMetaByUploadId = useRef<Map<string, UploadMeta>>(new Map());
  // R29 — dual-camera pairs upload as two independent files (either can
  // finish first); each pair is held here until BOTH assets exist, then
  // handed to `onDualAssetUploaded` exactly once.
  const dualGroupsRef = useRef<
    Map<string, { main?: MediaAsset; front?: MediaAsset; startDeltaMs: number; layout: 'pip' | 'split'; fired: boolean }>
  >(new Map());
  // R40 P-31 — the pair interception is gone: two visual files import
  // like any others, each landing on the timeline on its own. This
  // ref only remembers WHICH two assets came from one two-file pick,
  // so that once BOTH have landed the panel can show the quiet
  // post-import offer below ("Use these two as a pair?").
  const pairOfferBatchesRef = useRef<Map<string, { assets: Array<MediaAsset | undefined> }>>(new Map());
  const [pairOffer, setPairOffer] = useState<{ assets: [MediaAsset, MediaAsset] } | null>(null);
  // R40 P-45 — the pair layout choice everywhere: Corner PiP first
  // and the default, then Split 50/50 (camera review + PipPanel order).
  const [pairLayoutChoice, setPairLayoutChoice] = useState<'pip' | 'split'>('pip');
  // WS-S1 — uploads run through a bounded queue (at most
  // MAX_CONCURRENT_UPLOADS resumable uploads in flight at once) instead
  // of every picked file starting its upload immediately. Per-file
  // progress / error / retry semantics are unchanged: a queued file
  // simply reports progress once its slot opens, and one file's failure
  // settles only its own promise.
  const importQueueRef = useRef<ImportQueue | null>(null);
  if (!importQueueRef.current) {
    importQueueRef.current = createImportQueue(MAX_CONCURRENT_UPLOADS);
  }

  const runUpload = useCallback(
    (uploadId: string, file: File, assetId: string) => {
      importQueueRef.current!.enqueue(() =>
        uploadMediaFile({
          uid,
          file,
          assetId,
          onProgress: (evt: UploadProgressEvent) => {
            setPending((list) => list.map((u) => (u.id === uploadId ? { ...u, progress: evt.fraction } : u)));
          },
        }),
      )
        .then(({ asset }) => {
          setPending((list) => list.map((u) => (u.id === uploadId ? { ...u, status: 'done', progress: 1 } : u)));
          const meta = uploadMetaByUploadId.current.get(uploadId);
          let trimStart = meta?.trimStart;
          let trimEnd = meta?.trimEnd;
          // Camera recordings skip the trim/select modal (see header
          // comment) but still get a defensive clamp: the auto-stop timer
          // in CameraCapture fires on a 1s tick, so the real recorded
          // duration can land a fraction of a second past the limit —
          // that's clamped here silently rather than surfacing a
          // trim-select prompt for a sub-second timing artifact.
          if (meta?.isCameraCapture && typeof asset.durationSeconds === 'number' && asset.durationSeconds > MAX_MEDIA_SECONDS + 0.05) {
            trimStart = 0;
            trimEnd = MAX_MEDIA_SECONDS;
          }
          // R29 — dual-camera pair: hold each finished asset in its
          // group until the other half lands, then hand the pair to the
          // dual insert path exactly once and skip normal routing.
          if (meta?.dualGroupId && meta.dualRole && onDualAssetUploaded) {
            let group = dualGroupsRef.current.get(meta.dualGroupId);
            if (!group) {
              group = { startDeltaMs: meta.startDeltaMs ?? 0, layout: meta.dualLayout ?? 'pip', fired: false };
              dualGroupsRef.current.set(meta.dualGroupId, group);
            }
            if (meta.dualRole === 'main') group.main = asset;
            else group.front = asset;
            if (group.main && group.front && !group.fired) {
              group.fired = true;
              const mainAsset = group.main;
              const frontAsset = group.front;
              const groupStartDeltaMs = group.startDeltaMs;
              const groupLayout = group.layout;
              dualGroupsRef.current.delete(meta.dualGroupId);
              onDualAssetUploaded(mainAsset, frontAsset, { startDeltaMs: groupStartDeltaMs, layout: groupLayout });
            }
            uploadMetaByUploadId.current.delete(uploadId);
            return;
          }
          // Route by the purpose the upload started with (tweaks round):
          // overlay uploads land as PiP/corner overlays, device audio
          // lands on the music track, everything else on the main
          // timeline — all through the caller's existing insert paths.
          const purpose = meta?.purpose ?? 'main';
          const hasTrim = trimStart !== undefined || trimEnd !== undefined;
          if (purpose === 'overlay' && onOverlayAssetUploaded) {
            // A camera recording the user deliberately sent to the
            // overlay track is a talking-head take — it starts with its
            // audio ON (muted: false). An uploaded file keeps the
            // overlay path's muted default (option omitted entirely).
            const overlayOptions: AssetUploadedOptions = {};
            if (hasTrim) {
              overlayOptions.trimStart = trimStart;
              overlayOptions.trimEnd = trimEnd;
            }
            if (meta?.isCameraCapture) overlayOptions.muted = false;
            onOverlayAssetUploaded(asset, Object.keys(overlayOptions).length > 0 ? overlayOptions : undefined);
          } else if (purpose === 'audio') {
            onAssetUploaded(asset, { trimStart, trimEnd, role: 'music' });
          } else {
            onAssetUploaded(asset, hasTrim ? { trimStart, trimEnd } : undefined);
          }
          // R40 P-31 — AFTER this file has landed like any other, note
          // it against its two-file batch; when the second half lands
          // too, the quiet pair offer appears. The upload itself was
          // never held, blocked or re-routed by the pair question.
          if (meta?.pairOfferBatchId && meta.pairOfferIndex !== undefined && onPairAssetUploaded) {
            let batch = pairOfferBatchesRef.current.get(meta.pairOfferBatchId);
            if (!batch) {
              batch = { assets: [undefined, undefined] };
              pairOfferBatchesRef.current.set(meta.pairOfferBatchId, batch);
            }
            batch.assets[meta.pairOfferIndex] = asset;
            const [landedA, landedB] = batch.assets;
            if (landedA && landedB) {
              pairOfferBatchesRef.current.delete(meta.pairOfferBatchId);
              setPairOffer({ assets: [landedA, landedB] });
            }
          }
          uploadMetaByUploadId.current.delete(uploadId);
        })
        .catch((err: any) => {
          setPending((list) =>
            list.map((u) => (u.id === uploadId ? { ...u, status: 'error', error: humanizeUploadError(err) } : u)),
          );
        });
    },
    [uid, onAssetUploaded, onOverlayAssetUploaded, onDualAssetUploaded, onPairAssetUploaded],
  );

  const startUpload = useCallback(
    (file: File, meta?: UploadMeta) => {
      const validation = validateMediaFile(file);
      const uploadId = generateTimelineId('upload');
      if (!validation.valid) {
        setPending((list) => [
          ...list,
          { id: uploadId, fileName: file.name, file, progress: 0, status: 'error', error: humanizeUploadError(validation.error) },
        ]);
        return;
      }
      const assetId = generateTimelineId('asset');
      assetIdByUploadId.current.set(uploadId, assetId);
      if (meta) uploadMetaByUploadId.current.set(uploadId, meta);
      setPending((list) => [...list, { id: uploadId, fileName: file.name, file, progress: 0, status: 'uploading' }]);
      runUpload(uploadId, file, assetId);
    },
    [runUpload],
  );

  const retryUpload = useCallback(
    (uploadId: string) => {
      const upload = pending.find((u) => u.id === uploadId);
      if (!upload) return;
      const assetId = assetIdByUploadId.current.get(uploadId) ?? generateTimelineId('asset');
      assetIdByUploadId.current.set(uploadId, assetId);
      setPending((list) => list.map((u) => (u.id === uploadId ? { ...u, status: 'uploading', progress: 0, error: undefined } : u)));
      runUpload(uploadId, upload.file, assetId);
    },
    [pending, runUpload],
  );

  const dismissUpload = useCallback((uploadId: string) => {
    setPending((list) => list.filter((u) => u.id !== uploadId));
    assetIdByUploadId.current.delete(uploadId);
    uploadMetaByUploadId.current.delete(uploadId);
  }, []);

  /**
   * "Universal 30-second media standard" spec item 2 — the actual gate.
   * Probes duration BEFORE uploading a single byte; only video/audio files
   * are duration-limited (images have no intrinsic duration). A probe
   * failure (unusual codec, corrupt file, etc.) falls through to the normal
   * upload path rather than blocking the user — `uploadMediaFile` already
   * has its own best-effort probe-failure fallback, so this mirrors that
   * same "never let a probe quirk block a real upload" policy.
   */
  const intakeFile = useCallback(
    (file: File, purpose: UploadPurpose, pairOffer?: { batchId: string; index: 0 | 1 }) => {
      const batchMeta = pairOffer
        ? { pairOfferBatchId: pairOffer.batchId, pairOfferIndex: pairOffer.index }
        : {};
      const mimeType = file.type || '';
      const kind = mediaKindForMimeType(mimeType);
      if (kind !== 'video' && kind !== 'audio') {
        startUpload(file, { purpose, ...batchMeta });
        return;
      }
      // WS-S1 — the cached probe: this result is stored under the file's
      // content hash, so `uploadMediaFile`'s own probe of the same file
      // resolves from the cache instead of probing the file a second time.
      probeMediaFileCached(file, mimeType)
        .then((probed) => {
          const dur = probed.durationSeconds;
          if (typeof dur === 'number' && Number.isFinite(dur) && dur > MAX_MEDIA_SECONDS + 0.25) {
            setPendingTrim({ file, kind, durationSeconds: dur, purpose, ...batchMeta });
          } else {
            startUpload(file, { purpose, ...batchMeta });
          }
        })
        .catch(() => startUpload(file, { purpose, ...batchMeta }));
    },
    [startUpload],
  );

  const handleFiles = useCallback(
    (files: FileList | null, purpose: UploadPurpose) => {
      if (!files) return;
      const list = Array.from(files);
      // R40 P-31 — exactly two visual files in ONE main import action
      // import like any others, one by one, with NO pair gate in front
      // of them. They only carry a shared batch tag so the panel can
      // offer pairing afterwards, once both have landed (see the
      // pair-offer tracking in runUpload and the offer UI below).
      if (purpose === 'main' && onPairAssetUploaded && list.length === 2) {
        const kinds = list.map((f) => mediaKindForMimeType(f.type || ''));
        if (kinds.every((k) => k === 'video' || k === 'image')) {
          const batchId = generateTimelineId('pairoffer');
          list.forEach((file, idx) => intakeFile(file, purpose, { batchId, index: idx as 0 | 1 }));
          return;
        }
      }
      list.forEach((file) => intakeFile(file, purpose));
    },
    [intakeFile, onPairAssetUploaded],
  );

  /** R40 P-31 — take the post-import pair offer: the two landed assets are placed as a pair. */
  const confirmPairOffer = useCallback(() => {
    if (!pairOffer || !onPairAssetUploaded) return;
    const [assetA, assetB] = pairOffer.assets;
    setPairOffer(null);
    onPairAssetUploaded(assetA, assetB, { layout: pairLayoutChoice });
  }, [pairOffer, pairLayoutChoice, onPairAssetUploaded]);

  const startCaptureUpload = useCallback(
    (result: CaptureResult, purpose: UploadPurpose) => {
      setShowCamera(false);
      setCameraForPip(false);
      const extension = result.kind === 'photo' ? 'jpg' : 'webm';
      const mimeType = result.kind === 'photo' ? 'image/jpeg' : (result.blob.type || 'video/webm');
      const file = new File([result.blob], `capture-${Date.now()}.${extension}`, { type: mimeType });
      // Deliberately bypasses intakeFile/probe-then-modal — the camera
      // already auto-stopped this recording at the limit, so a second
      // trim-select prompt right after recording would be redundant
      // friction; runUpload applies a silent defensive clamp instead (see
      // its own comment above). The purpose rides along so a recording
      // the user chose as an overlay in the camera's review state routes
      // to the overlay insert path in `runUpload`, exactly like an
      // "Add Overlay" file upload.
      startUpload(file, result.kind === 'video' ? { isCameraCapture: true, purpose } : { purpose });
    },
    [startUpload],
  );

  const handleCapture = useCallback(
    (result: CaptureResult) => startCaptureUpload(result, 'main'),
    [startCaptureUpload],
  );

  const handleCaptureAsOverlay = useCallback(
    (result: CaptureResult) => {
      // CameraCapture only offers the overlay choice for VIDEO review
      // states; anything else takes the normal path defensively.
      if (result.kind !== 'video' || !onOverlayAssetUploaded) {
        startCaptureUpload(result, 'main');
        return;
      }
      startCaptureUpload(result, 'overlay');
    },
    [startCaptureUpload, onOverlayAssetUploaded],
  );

  /**
   * R36 WS-1 — "Record PiP" landing: the take goes through the SAME
   * overlay upload path as handleCaptureAsOverlay (purpose 'overlay' →
   * EditorShell's addPipOverlay insert with the R24 camera defaults:
   * rounded shape, pip.fit 'source', sound on), for video and photo
   * alike — in PiP camera mode there is no main-clip choice to offer.
   */
  const handleCaptureForcedOverlay = useCallback(
    (result: CaptureResult) => {
      if (!onOverlayAssetUploaded) {
        startCaptureUpload(result, 'main');
        return;
      }
      startCaptureUpload(result, 'overlay');
    },
    [startCaptureUpload, onOverlayAssetUploaded],
  );

  const openRecordPipCamera = useCallback(() => {
    setCameraForPip(true);
    setShowCamera(true);
  }, []);

  const openMainCamera = useCallback(() => {
    setCameraForPip(false);
    setShowCamera(true);
  }, []);

  // R36 WS-1 — PiP requests from PipPanel / the timeline Overlay lane
  // arrive as window events (lib/pipRequests, the R27 undo-toast
  // pattern). This panel owns the camera and the overlay file input,
  // so it is the only listener. It can be mounted more than once
  // (desktop aside + mobile sheet render the same node): the first
  // RENDERED instance claims each event object, hidden duplicates
  // (a display:none aside) neither claim nor answer it.
  // R40 P-42 — this instance's claim identity + the claims it is
  // holding but has not answered yet. A claim is answered a beat
  // after the action fires (once this instance has actually opened
  // its camera / picker and is still here); if the instance unmounts
  // before answering, the cleanup below RELEASES the claim and
  // re-dispatches the request once, so another mounted instance can
  // answer instead of the tap dying with this one. The dispatcher's
  // own one-time retry (lib/pipRequests) covers the rest.
  const pipInstanceRef = useRef<object | null>(null);
  if (!pipInstanceRef.current) pipInstanceRef.current = {};
  const pipHeldClaimsRef = useRef<Array<{ event: Event; name: string; timer: number }>>([]);
  useEffect(() => {
    const instance = pipInstanceRef.current!;
    const isRendered = () => {
      const el = panelRootRef.current;
      if (!el || typeof el.getClientRects !== 'function') return true;
      return el.getClientRects().length > 0;
    };
    const holdClaim = (e: Event, name: string, act: () => void) => {
      if (!isRendered() || !claimPipRequest(e, instance)) return;
      act();
      const timer = window.setTimeout(() => {
        pipHeldClaimsRef.current = pipHeldClaimsRef.current.filter((h) => h.event !== e);
        answerPipRequest(e, instance);
      }, 100);
      pipHeldClaimsRef.current.push({ event: e, name, timer });
    };
    const onRecordPip = (e: Event) => holdClaim(e, RECORD_PIP_EVENT, openRecordPipCamera);
    const onUploadPip = (e: Event) =>
      holdClaim(e, UPLOAD_PIP_EVENT, () => overlayInputRef.current?.click());
    window.addEventListener(RECORD_PIP_EVENT, onRecordPip);
    window.addEventListener(UPLOAD_PIP_EVENT, onUploadPip);
    return () => {
      window.removeEventListener(RECORD_PIP_EVENT, onRecordPip);
      window.removeEventListener(UPLOAD_PIP_EVENT, onUploadPip);
      // Unmount: free every claim this instance never answered and
      // re-dispatch each once — a live instance can still answer it.
      for (const held of pipHeldClaimsRef.current) {
        window.clearTimeout(held.timer);
        if (releasePipRequestClaim(held.event, instance) && markPipRequestRedispatched(held.event)) {
          window.dispatchEvent(new CustomEvent(held.name));
        }
      }
      pipHeldClaimsRef.current = [];
    };
  }, [openRecordPipCamera]);

  const handleCaptureDual = useCallback(
    (result: CaptureDualResult) => {
      setShowCamera(false);
      const groupId = generateTimelineId('dual');
      const makeFile = (blob: Blob, tag: string) =>
        new File([blob], `capture-dual-${tag}-${Date.now()}.webm`, { type: blob.type || 'video/webm' });
      // purpose 'main' is inert here — the dual branch in runUpload
      // intercepts routing for both files before purpose is consulted.
      startUpload(makeFile(result.main.blob, 'main'), {
        isCameraCapture: true,
        purpose: 'main',
        dualGroupId: groupId,
        dualRole: 'main',
        startDeltaMs: result.startDeltaMs,
        dualLayout: result.layout,
      });
      startUpload(makeFile(result.overlay.blob, 'front'), {
        isCameraCapture: true,
        purpose: 'main',
        dualGroupId: groupId,
        dualRole: 'front',
        startDeltaMs: result.startDeltaMs,
        dualLayout: result.layout,
      });
    },
    [startUpload],
  );

  return (
    <div ref={panelRootRef} className="flex flex-col gap-3">
      {/* Tweaks round — three unmistakable add actions. "Add Video /
          Image" is THE main-timeline action (gold, primary); "Add
          Overlay" and "Add Audio" sit beside it at the same size so a
          first-time user never has to guess which generic "upload"
          button does what. Camera stays as a quieter secondary action. */}
      <div className="flex flex-col gap-2">
        <button
          onClick={() => fileInputRef.current?.click()}
          className="min-h-11 px-3 rounded-lg bg-gold hover:bg-gold-bright text-black text-[13px] font-bold flex items-center justify-center gap-2 transition"
        >
          <Clapperboard size={18} /> Add Video / Image
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => overlayInputRef.current?.click()}
            className="min-h-11 flex-1 px-3 rounded-lg border border-gold/40 bg-gold/10 hover:bg-gold/20 text-gold text-[13px] font-bold flex items-center justify-center gap-2 transition"
            title="Add a video or image ON TOP of your main video (talking-head, logo, reaction clip)"
          >
            <PictureInPicture2 size={17} /> Add Overlay
          </button>
          <button
            onClick={() => audioInputRef.current?.click()}
            className="min-h-11 flex-1 px-3 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-white text-[13px] font-bold flex items-center justify-center gap-2 transition"
            title="Add music, voiceover, or sound effects from your device — lands on the music track"
          >
            <AudioLines size={17} /> Add Audio
          </button>
        </div>
        {/* R36 WS-1 — the overlay surface's primary pair: Record PiP /
            Upload PiP as equal actions. Both reuse the paths above —
            Record PiP opens this panel's camera in PiP mode, Upload
            PiP clicks the same overlay file input as "Add Overlay".
            The main flow's quiet camera entry below is untouched. */}
        <PipAddButtons onRecord={openRecordPipCamera} onUpload={() => overlayInputRef.current?.click()} />
        <button
          onClick={openMainCamera}
          className="min-h-10 px-3 rounded-lg text-white/60 hover:text-white hover:bg-white/5 text-xs font-bold flex items-center justify-center gap-1.5 transition"
        >
          <Camera size={14} /> Record with camera instead
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files, 'main');
            e.target.value = '';
          }}
        />
        <input
          ref={overlayInputRef}
          type="file"
          accept="video/*,image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files, 'overlay');
            e.target.value = '';
          }}
        />
        <input
          ref={audioInputRef}
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg"
          multiple
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files, 'audio');
            e.target.value = '';
          }}
        />
      </div>

      <p className="text-[10px] text-white/60">Videos, songs, and audio are limited to {MAX_MEDIA_SECONDS / 60} minutes per clip.</p>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          handleFiles(e.dataTransfer.files, 'main');
        }}
        className="border border-dashed border-white/15 rounded-lg px-4 py-4 text-center text-xs text-white/60"
      >
        Drag and drop video, image, or audio files here
      </div>

      {/* R40 P-31 — the pair offer, shown only AFTER two files from
          one pick have both landed on the timeline like any others.
          It is a quiet, dismissible secondary offer (never gold, never
          a gate): the two files are already in the project either
          way, and "Add as a pair" simply re-places those two landed
          assets together. Layout order + default match every other
          pair surface (R40 P-45): Corner PiP first, then Split 50/50. */}
      {pairOffer && (
        <div className="flex flex-col gap-2 rounded-lg border border-white/15 bg-white/5 px-3 py-2.5">
          <p className="text-xs font-bold text-white">Use these two as a pair?</p>
          <ul className="flex flex-col gap-1">
            {pairOffer.assets.map((asset) => (
              <li key={asset.id} className="text-[11px] text-white/70">
                <span className="block truncate">
                  {asset.fileName}
                  {asset.width && asset.height ? ` — ${asset.width}×${asset.height}` : ''}
                  {typeof asset.durationSeconds === 'number' && Number.isFinite(asset.durationSeconds)
                    ? ` · ${asset.durationSeconds.toFixed(1)}s`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-bold uppercase tracking-wide text-white/50">Layout:</span>
            {(
              [
                { id: 'pip', label: 'Corner PiP' },
                { id: 'split', label: 'Split 50/50' },
              ] as Array<{ id: 'pip' | 'split'; label: string }>
            ).map((choice) => (
              <button
                key={choice.id}
                onClick={() => setPairLayoutChoice(choice.id)}
                aria-pressed={pairLayoutChoice === choice.id}
                className={`min-h-11 px-3 rounded-lg text-xs font-bold uppercase tracking-wide transition ${
                  pairLayoutChoice === choice.id ? 'bg-gold text-black' : 'bg-white/10 hover:bg-white/20 text-white'
                }`}
              >
                {choice.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={confirmPairOffer}
              className="min-h-11 px-3 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-bold uppercase tracking-wide"
            >
              Add as a pair
            </button>
            <button
              onClick={() => setPairOffer(null)}
              className="min-h-11 px-3 rounded-lg text-white/60 hover:text-white text-xs font-bold uppercase tracking-wide"
            >
              Not now
            </button>
          </div>
        </div>
      )}

      {pending.length > 0 && (
        <ul className="flex flex-col gap-2">
          {pending.map((upload) => (
            <li key={upload.id} className="flex items-center gap-2 text-xs bg-white/5 rounded-lg px-3 py-2">
              <span className="flex-1 truncate text-white/70">{upload.fileName}</span>
              {upload.status === 'uploading' && (
                <>
                  <span className="shrink-0 text-white/60">Uploading… {Math.round(upload.progress * 100)}%</span>
                  <div className="w-24 h-1.5 bg-white/10 rounded overflow-hidden">
                    <div className="h-full bg-gold" style={{ width: `${Math.round(upload.progress * 100)}%` }} />
                  </div>
                </>
              )}
              {upload.status === 'done' && <span className="text-emerald-400 font-bold">Done</span>}
              {upload.status === 'error' && (
                <>
                  <span className="text-red-400 max-w-[16rem] truncate" title={upload.error}>
                    {upload.error}
                  </span>
                  <button onClick={() => retryUpload(upload.id)} className="text-white/60 hover:text-white underline">
                    Retry
                  </button>
                </>
              )}
              {(upload.status === 'error' || upload.status === 'done') && (
                <button onClick={() => dismissUpload(upload.id)} className="text-white/30 hover:text-white/70">
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {showCamera && (
        <CameraCapture
          onCapture={cameraForPip ? handleCaptureForcedOverlay : handleCapture}
          onCaptureAsOverlay={
            onOverlayAssetUploaded ? (cameraForPip ? handleCaptureForcedOverlay : handleCaptureAsOverlay) : undefined
          }
          onCaptureDual={!cameraForPip && onDualAssetUploaded ? handleCaptureDual : undefined}
          overlayOnly={cameraForPip}
          onClose={() => {
            setShowCamera(false);
            setCameraForPip(false);
          }}
          canvasWidth={canvasWidth}
          canvasHeight={canvasHeight}
        />
      )}

      {pendingTrim && (
        <TrimSelectModal
          file={pendingTrim.file}
          kind={pendingTrim.kind}
          durationSeconds={pendingTrim.durationSeconds}
          onCancel={() => setPendingTrim(null)}
          onConfirm={({ trimStart, trimEnd }) => {
            const { file, purpose, pairOfferBatchId, pairOfferIndex } = pendingTrim;
            setPendingTrim(null);
            startUpload(file, { trimStart, trimEnd, purpose, pairOfferBatchId, pairOfferIndex });
          }}
        />
      )}
    </div>
  );
}
