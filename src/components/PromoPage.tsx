import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLicenseTier } from '../hooks/useLicenseTier';
import BrandLogo from './BrandLogo';
import { analyzeImageFile, recipeBands, sliceBandFiles, type ArtworkAnalysis } from '../lib/promo/analyze';
import {
  buildCountdownProject, buildKineticProject, buildLineupProject, buildLogoProject,
  buildNewsflashProject, buildSlamProject, buildStackProject, buildVersusProject,
  PROMO_SKINS, PROMO_SKIN_LOOP, type PromoRecipeId, type PromoSkinId, type PromoTexts,
} from '../lib/promo/recipes';
import { ASPECT_RATIO_OPTIONS } from '../lib/aspectRatios';
import { createProject, saveProject } from '../lib/projects/persistence';
import { uploadMediaFile } from '../lib/media/upload';
import { getLoopDef, renderLoopFile, LOOP_DURATION_SECONDS } from '../lib/media/loops';
import { fetchPackTrackFile, packTrackForSkin, probeAudioDurationSeconds, PROMO_PACK_SHELVES } from '../lib/media/tracks';
import { loadBrandKit, saveBrandKit } from '../lib/promo/brandKit';
import {
  bankSuggestion,
  cycleAlternate,
  fieldAlternates,
  mergeIntoUntouched,
  splitHeadline,
  type SuggestionContext,
  type SuggestionField,
  type VisionSuggestion,
} from '../lib/promo/suggest';
import { analyzeArtwork } from '../lib/promo/ocrEngine';
import { classifyReadout, type OcrLine, type ReadoutResult } from '../lib/promo/readout';
import { RefreshCw } from 'lucide-react';
import { DEFAULT_PROMO_FONT, FONT_OPTIONS, ensureFontsLoaded } from '../lib/fonts';
import { addItem, addMediaAsset, generateTimelineId, getTracksByType } from '../lib/timeline/utils';
import type { AudioTimelineItem, MediaAsset, Project } from '../types/timeline';

/**
 * Adds the skin's built-in beat to a built promo, fitted to its length:
 * trimmed when the promo fits inside the 8s loop, looped when it must
 * repeat, standard 0.5s fitted fade-out — the same fit math the
 * template music path uses. Pure: the caller renders + uploads the loop.
 */
function addPromoMusic(project: Project, asset: MediaAsset, totalSeconds: number): Project {
  const track = getTracksByType(project, 'audio')[0];
  if (!track) return project;
  const sourceDuration =
    typeof asset.durationSeconds === 'number' && asset.durationSeconds > 0 ? asset.durationSeconds : LOOP_DURATION_SECONDS;
  const loops = totalSeconds > sourceDuration;
  const item: AudioTimelineItem = {
    id: generateTimelineId('item'),
    type: 'audio',
    trackId: track.id,
    startTime: 0,
    endTime: totalSeconds,
    zIndex: project.items.reduce((m, i) => Math.max(m, i.zIndex), -1) + 1,
    visible: true,
    mediaAssetId: asset.id,
    role: 'music',
    volume: 0.9,
    muted: false,
    trimStart: 0,
    trimEnd: loops ? sourceDuration : totalSeconds,
    fade: { fadeInDuration: 0, fadeOutDuration: Math.min(0.5, totalSeconds) },
    ...(loops ? { loop: true } : {}),
  };
  return addItem(addMediaAsset(project, asset), item);
}

/**
 * Viral Promo — artwork in, a scroll-stopping promo project out.
 *
 * The page runs the Director analysis in the browser (band detection +
 * artwork classification), lets the user confirm the recipe, format,
 * stage fit, genre skin and the added kinetic type, then builds a normal
 * Studio project with the recipe builders and opens it in the editor —
 * preview, music and export all use Studio's existing engine, licensing
 * and watermark rules. Access is the existing account gate: pending users
 * never reach this page, and the owner toggles testers on in Admin.
 */

type RecipeNeed = 'single' | 'slices' | 'two' | 'lineup' | 'stack';

const RECIPE_FOR_KIND: Record<ArtworkAnalysis['suggestedKind'], PromoRecipeId> = {
  logo: 'logo-build',
  portrait: 'slam',
  flyer: 'kinetic-build',
};

const RECIPES: Array<{ id: PromoRecipeId; name: string; blurb: string; need: RecipeNeed }> = [
  { id: 'kinetic-build', name: 'Kinetic Build', blurb: 'Your flyer assembles itself piece by piece on the beat, shine sweep, then the CTA card.', need: 'slices' },
  { id: 'logo-build', name: 'Logo Build', blurb: 'Your logo elements power on one by one into a vertical lockup with a sheen finish.', need: 'slices' },
  { id: 'slam', name: 'Slam', blurb: 'Full-screen impact: punch-zoom entrance, slow push, hook type, then the CTA phase.', need: 'single' },
  { id: 'spin-slam', name: '3D Slam Spin', blurb: 'The slam, entered with a spin and a flash hit.', need: 'single' },
  { id: 'countdown', name: 'Countdown', blurb: 'Your art on stage under a giant 3-2-1, then the name and CTA land.', need: 'single' },
  { id: 'newsflash', name: 'Newsflash', blurb: 'Glitch-in art, headline up top, lower-third stack in sequence.', need: 'single' },
  { id: 'lineup', name: 'Lineup Reveal', blurb: 'Poster first, then a solo hero moment per artwork, poster finale. Upload poster + cast shots.', need: 'lineup' },
  { id: 'versus', name: 'Versus', blurb: 'Two artworks clash from opposite sides with the VS mark between them.', need: 'two' },
  { id: 'flyer-stack', name: 'Flyer Stack', blurb: 'Several flyers fan in as a stack — top one gets the shine.', need: 'stack' },
];

const KIND_LABELS: Record<ArtworkAnalysis['suggestedKind'], string> = {
  logo: 'Logo on a dark ground',
  portrait: 'Portrait art / photo',
  flyer: 'Flyer / poster',
};

interface PickedFile {
  file: File;
  bitmap: ImageBitmap;
  previewUrl: string;
}

interface PromoPageProps {
  onOpenProject: (projectId: string) => void;
  onBack: () => void;
}

function cleanName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Untitled';
}

export function PromoPage({ onOpenProject, onBack }: PromoPageProps) {
  const { currentUser } = useAuth();
  const { tier } = useLicenseTier();
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [analysis, setAnalysis] = useState<ArtworkAnalysis | null>(null);
  const [recipe, setRecipe] = useState<PromoRecipeId>('kinetic-build');
  const [ratioId, setRatioId] = useState('9:16');
  const [fit, setFit] = useState<'fit' | 'fill'>('fit');
  const [skin, setSkin] = useState<PromoSkinId>('dancehall-raw');
  const [texts, setTexts] = useState<PromoTexts>({ hook1: '', hook2: '', cta: '', sub: '' });
  const [autoNote, setAutoNote] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [analyzePct, setAnalyzePct] = useState<number | null>(null);
  const [readLines, setReadLines] = useState<OcrLine[]>([]);
  const touchedRef = useRef<Set<string>>(new Set());
  const visionRef = useRef<VisionSuggestion | null>(null);
  const suggestCtxRef = useRef<SuggestionContext | null>(null);
  const suggestRunRef = useRef(0);
  const currentUserRef = useRef<typeof currentUser>(null);
  currentUserRef.current = currentUser;
  const lastBitmapRef = useRef<ImageBitmap | null>(null);
  const inFlightRef = useRef(0);
  const readCacheRef = useRef<Map<string, ReadoutResult>>(new Map());
  const suggestKeyRef = useRef<string>('');
  const [ownTrack, setOwnTrack] = useState<File | null>(null);
  const [packTrackId, setPackTrackId] = useState<string | null>(null);
  const [fontFamily, setFontFamily] = useState<string>(DEFAULT_PROMO_FONT);
  const ownTrackInputRef = useRef<HTMLInputElement | null>(null);
  const [duration, setDuration] = useState(12);
  const [musicOn, setMusicOn] = useState(true);
  const [kitNote, setKitNote] = useState<string | null>(null);
  const [phase, setPhase] = useState<'pick' | 'ready' | 'building'>('pick');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pickedRef = useRef<PickedFile[]>([]);
  pickedRef.current = picked;

  // Brand kit: prefill this device's saved defaults once, on mount.
  useEffect(() => {
    void ensureFontsLoaded();
    const kit = loadBrandKit();
    if (kit) {
      setSkin(kit.skinId);
      setTexts((t) => ({ ...t, cta: kit.ctaText, sub: kit.subText }));
      setKitNote('Brand defaults loaded from this device.');
    }
  }, []);

  const handleSaveKit = useCallback(() => {
    const ok = saveBrandKit({ ctaText: texts.cta?.trim() ?? '', subText: texts.sub?.trim() ?? '', skinId: skin });
    setKitNote(ok ? 'Saved — these will prefill next time, on this device.' : 'Could not save on this device.');
  }, [texts.cta, texts.sub, skin]);


  // Auto-fit words: the bank fills untouched fields instantly; the
  // DEDICATED ON-DEVICE ENGINE (Tesseract OCR, R11) then reads the
  // artwork itself — no server, no key, no quota (the Gemini read
  // was retired after three rounds of unverifiable failures). The
  // spinner is owned by an in-flight counter so no interleaving can
  // strand it, and every line the engine reads is shown in the
  // readout panel for one-tap assignment.
  const applyReadout = useCallback((result: ReadoutResult) => {
    visionRef.current = {
      hook1: result.fields.hook1 ?? '',
      hook2: result.fields.hook2 ?? '',
      sub: result.fields.sub ?? '',
      cta: result.fields.cta ?? '',
      genre: result.genre,
    };
    setReadLines(result.lines);
    setTexts((t) => mergeIntoUntouched(t, touchedRef.current, result.fields));
    setAutoNote(
      result.headline
        ? 'Words read from your artwork itself — tap any line to make it yours.'
        : 'The engine read your artwork — tap a line below to place it where it belongs.',
    );
  }, []);

  const runSuggestion = useCallback(async (bitmap: ImageBitmap, kind: SuggestionContext['kind'], fileName: string, cacheKey = '', force = false) => {
    const runId = ++suggestRunRef.current;
    const ctx: SuggestionContext = { kind, fileName };
    suggestCtxRef.current = ctx;
    suggestKeyRef.current = cacheKey;
    lastBitmapRef.current = bitmap;
    visionRef.current = null;
    setTexts((t) => mergeIntoUntouched(t, touchedRef.current, bankSuggestion(ctx)));
    setAutoNote('Words suggested from your artwork type — tap any line to make it yours.');

    if (!force && cacheKey) {
      const cached = readCacheRef.current.get(cacheKey);
      if (cached) {
        applyReadout(cached);
        return;
      }
    }

    inFlightRef.current += 1;
    setSuggesting(true);
    setAnalyzePct(0);
    try {
      let lines: OcrLine[] = [];
      try {
        lines = await analyzeArtwork(bitmap, (fraction, stage) => {
          if (suggestRunRef.current === runId && stage === 'recognizing text') setAnalyzePct(Math.round(fraction * 100));
        });
      } catch {
        if (suggestRunRef.current === runId) {
          setAutoNote('The artwork engine could not load — check your connection. Suggested words are in; tap "Analyze artwork" to try again.');
        }
        return;
      }
      if (suggestRunRef.current !== runId) return;
      if (lines.length === 0) {
        setReadLines([]);
        setAutoNote('No readable words found in this image — suggested words are in. Type your own, or analyze again after a clearer upload.');
        return;
      }
      const result = classifyReadout(lines, ctx);
      if (cacheKey) readCacheRef.current.set(cacheKey, result);
      applyReadout(result);
    } finally {
      inFlightRef.current = Math.max(0, inFlightRef.current - 1);
      setSuggesting(inFlightRef.current > 0);
      if (suggestRunRef.current === runId) setAnalyzePct(null);
    }
  }, [applyReadout]);

  const handleAnalyze = useCallback(() => {
    const bitmap = lastBitmapRef.current;
    const ctx = suggestCtxRef.current;
    if (!bitmap || !ctx || suggesting) return;
    void runSuggestion(bitmap, ctx.kind, ctx.fileName, suggestKeyRef.current, true);
  }, [runSuggestion, suggesting]);

  /** One-tap assignment from the readout: a line the engine read,
      placed exactly where the user wants it. Counts as the user's
      own edit, so later auto-fills never overwrite it. */
  const assignReadLine = useCallback((target: 'hook' | 'sub' | 'cta', text: string) => {
    if (target === 'hook') {
      const [h1, h2] = splitHeadline(text);
      touchedRef.current.add('hook1');
      if (h2) touchedRef.current.add('hook2');
      setTexts((t) => ({ ...t, hook1: h1, ...(h2 ? { hook2: h2 } : {}) }));
    } else if (target === 'sub') {
      touchedRef.current.add('sub');
      setTexts((t) => ({ ...t, sub: text }));
    } else {
      touchedRef.current.add('cta');
      setTexts((t) => ({ ...t, cta: text }));
    }
  }, []);

  const cycleField = useCallback((field: SuggestionField) => {
    const ctx = suggestCtxRef.current;
    if (!ctx) return;
    touchedRef.current.add(field);
    const visionValue = visionRef.current?.[field]?.trim();
    const alternates = Array.from(
      new Set([visionValue, ...fieldAlternates(field, ctx)].filter((v): v is string => !!v && v.length > 0)),
    );
    setTexts((t) => ({ ...t, [field]: cycleAlternate(alternates, t[field] ?? '') }));
  }, []);

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setError(null);
    try {
      const list = Array.from(files).slice(0, 10);
      if (list.length === 0) return;
      const results: PickedFile[] = [];
      let firstAnalysis: ArtworkAnalysis | null = null;
      for (const file of list) {
        const { analysis: a, bitmap } = await analyzeImageFile(file);
        if (!firstAnalysis) firstAnalysis = a;
        results.push({ file, bitmap, previewUrl: URL.createObjectURL(file) });
      }
      setPicked((prev) => {
        prev.forEach((p) => URL.revokeObjectURL(p.previewUrl));
        return results;
      });
      setAnalysis(firstAnalysis);
      if (firstAnalysis) setRecipe(RECIPE_FOR_KIND[firstAnalysis.suggestedKind]);
      setPhase('ready');
      if (firstAnalysis && results[0]) {
        void runSuggestion(results[0].bitmap, firstAnalysis.suggestedKind, list[0].name, `${list[0].name}:${list[0].size}`);
      }
    } catch (err: any) {
      setError(err?.message || 'That file could not be read as an image.');
    }
  }, [runSuggestion]);

  const handleSample = useCallback(async () => {
    try {
      const res = await fetch('/sample-flyer.svg');
      if (!res.ok) throw new Error('sample missing');
      const blob = await res.blob();
      const file = new File([blob], 'sample-concert-flyer.svg', { type: 'image/svg+xml' });
      await handleFiles([file]);
    } catch {
      setError('The sample flyer could not be loaded. Upload your own artwork instead.');
    }
  }, [handleFiles]);

  const recipeMeta = RECIPES.find((r) => r.id === recipe)!;
  const fileProblem: string | null =
    recipeMeta.need === 'two' && picked.length !== 2
      ? 'Versus needs exactly 2 artworks.'
      : recipeMeta.need === 'lineup' && picked.length < 2
        ? 'Lineup needs the poster plus at least 1 more artwork.'
        : recipeMeta.need === 'stack' && (picked.length < 2 || picked.length > 6)
          ? 'Flyer Stack needs 2 to 6 artworks.'
          : null;

  const handleBuild = useCallback(async () => {
    if (!currentUser || picked.length === 0 || !analysis || fileProblem) return;
    setPhase('building');
    setError(null);
    try {
      const uid = currentUser.uid;
      const ratio = ASPECT_RATIO_OPTIONS.find((r) => r.id === ratioId) ?? ASPECT_RATIO_OPTIONS[1];
      const first = picked[0];
      const base = cleanName(first.file.name);
      const cleanTexts: PromoTexts = {
        hook1: texts.hook1?.trim() || undefined,
        hook2: texts.hook2?.trim() || undefined,
        cta: texts.cta?.trim() || undefined,
        sub: texts.sub?.trim() || undefined,
        font: fontFamily,
      };
      const buildOpts = { duration, fit, skin };
      setStatus('Creating your project…');
      let project = await createProject(uid, `Viral Promo — ${base}`, ratio.canvasWidth, ratio.canvasHeight, {
        watermarkEnabled: tier !== 'lifetime',
      });

      const upload = async (p: PickedFile, label: string) => {
        setStatus(`Uploading ${label}…`);
        return (await uploadMediaFile({ uid, file: p.file })).asset;
      };

      const uploadExtras = async (): Promise<MediaAsset[]> => {
        const extras: MediaAsset[] = [];
        for (let i = 1; i < picked.length; i++) {
          extras.push(await upload(picked[i], `photo ${i + 1} of ${picked.length}`));
        }
        return extras;
      };

      if (recipe === 'slam' || recipe === 'spin-slam') {
        const art = await upload(first, 'your artwork');
        const extras = await uploadExtras();
        project = buildSlamProject(project, art, cleanTexts, { ...buildOpts, extras, variant: recipe === 'spin-slam' ? 'spin' : 'slam' });
      } else if (recipe === 'countdown') {
        const art = await upload(first, 'your artwork');
        const extras = await uploadExtras();
        project = buildCountdownProject(project, art, cleanTexts, { ...buildOpts, extras });
      } else if (recipe === 'newsflash') {
        const art = await upload(first, 'your artwork');
        project = buildNewsflashProject(project, art, cleanTexts, buildOpts);
      } else if (recipe === 'versus') {
        const a = await upload(picked[0], 'artwork 1');
        const b = await upload(picked[1], 'artwork 2');
        project = buildVersusProject(project, a, b, cleanTexts, buildOpts);
      } else if (recipe === 'lineup') {
        const entries = [];
        for (let i = 0; i < picked.length; i++) {
          const asset = await upload(picked[i], `artwork ${i + 1} of ${picked.length}`);
          entries.push({ asset, name: cleanName(picked[i].file.name) });
        }
        project = buildLineupProject(project, entries, cleanTexts, buildOpts);
      } else if (recipe === 'flyer-stack') {
        const assets = [];
        for (let i = 0; i < picked.length; i++) {
          assets.push(await upload(picked[i], `artwork ${i + 1} of ${picked.length}`));
        }
        project = buildStackProject(project, assets, cleanTexts, buildOpts);
      } else {
        // slices recipes: kinetic-build / logo-build
        const bands = recipeBands(analysis);
        setStatus(`Slicing your artwork into ${bands.length} pieces…`);
        const featherPx = recipe === 'kinetic-build' ? Math.max(6, Math.round(first.bitmap.height * 0.008)) : 0;
        const sliceFiles = await sliceBandFiles(first.bitmap, bands, base, { featherPx });
        const slices = [];
        for (let i = 0; i < sliceFiles.length; i++) {
          setStatus(`Uploading piece ${i + 1} of ${sliceFiles.length}…`);
          const up = await uploadMediaFile({ uid, file: sliceFiles[i] });
          slices.push({ asset: up.asset, band: bands[i] });
        }
        if (recipe === 'logo-build') {
          project = buildLogoProject(project, slices, cleanTexts, buildOpts);
        } else {
          const art = await upload(first, 'your artwork');
          const extras = await uploadExtras();
          project = buildKineticProject(project, art, slices, cleanTexts, { ...buildOpts, extras });
        }
      }

      // Music, fitted to the promo's length, in the owner's order:
      // their own track first, then the skin's REAL pack track (a
      // license-verified recording), then the built-in synth loop as
      // the last-resort fallback. A failure here never blocks the
      // promo — it just opens without music (the editor's Music
      // panel can add it later).
      if (musicOn) {
        try {
          setStatus('Adding the beat…');
          let musicFile: File | null = ownTrack;
          if (!musicFile) {
            try {
              musicFile = await fetchPackTrackFile(packTrackForSkin(skin, packTrackId));
            } catch {
              musicFile = null;
            }
          }
          if (!musicFile) {
            const def = getLoopDef(PROMO_SKIN_LOOP[skin]);
            if (def) musicFile = await renderLoopFile(def);
          }
          if (musicFile) {
            const probed = await probeAudioDurationSeconds(musicFile);
            const up = await uploadMediaFile({ uid, file: musicFile });
            const asset =
              probed && (!up.asset.durationSeconds || Math.abs(up.asset.durationSeconds - probed) > 0.75)
                ? { ...up.asset, durationSeconds: probed }
                : up.asset;
            project = addPromoMusic(project, asset, duration);
          }
        } catch {
          // Music is a layer, not a blocker — the promo still opens.
        }
      }

      setStatus('Saving…');
      await saveProject(project);
      onOpenProject(project.id);
    } catch (err: any) {
      setError(err?.message || 'The promo could not be built. Try again.');
      setPhase('ready');
    }
  }, [currentUser, picked, analysis, fileProblem, ratioId, fit, skin, texts, duration, recipe, tier, onOpenProject, musicOn, ownTrack, packTrackId, fontFamily]);

  const inputCls =
    'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-gold/60';
  const chipCls = (active: boolean) =>
    `px-3 py-1.5 rounded-lg border text-xs font-bold ${active ? 'bg-gold text-black border-gold' : 'bg-white/5 border-white/10 text-white/70'}`;

  return (
    <div className="min-h-screen bg-[#070707] text-white">
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/10">
        <BrandLogo size="sm" />
        <button
          onClick={onBack}
          className="px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-bold uppercase"
        >
          Back
        </button>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-black uppercase tracking-wide">
          Viral <span className="text-gold">Promo</span>
        </h1>
        <p className="text-sm text-white/60 mt-2 max-w-xl">
          Upload a flyer, poster or logo. We take it apart, build it back on the beat, and hand you a
          promo ready to post. <span className="text-white font-bold">Your artwork is never redrawn</span> —
          every letter stays pixel-perfect.
        </p>

        {error && <p className="text-sm text-red-400 mt-4">{error}</p>}

        <div className="mt-6 bg-white/5 border border-white/10 rounded-xl p-4">
          <label className="block text-xs font-bold uppercase tracking-wide text-white/60 mb-2">
            1 · Your artwork
          </label>
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) void handleFiles(e.target.files);
            }}
            className="block w-full text-sm text-white/70 file:mr-3 file:px-4 file:py-2 file:rounded-lg file:border file:border-gold/60 file:bg-gold/15 file:text-gold file:text-xs file:font-bold file:uppercase"
          />
          {picked.length === 0 && (
            <button
              onClick={() => void handleSample()}
              className="mt-3 min-h-[44px] px-4 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 text-xs font-bold text-white/80"
            >
              No flyer handy? Try the sample flyer →
            </button>
          )}
          {picked.length > 0 && (
            <div className="mt-4 flex gap-4 items-start">
              <div className="flex gap-2">
                {picked.map((p, i) => (
                  <img key={i} src={p.previewUrl} alt={`Artwork ${i + 1}`} className="w-20 rounded-lg border border-white/10" />
                ))}
              </div>
              {analysis && (
                <div className="text-xs text-white/60 space-y-1">
                  <p>
                    Detected: <span className="text-white font-bold">{KIND_LABELS[analysis.suggestedKind]}</span>
                  </p>
                  <p>
                    {analysis.width} × {analysis.height}px · {analysis.bands.length} element band
                    {analysis.bands.length === 1 ? '' : 's'} found · {picked.length} file{picked.length === 1 ? '' : 's'}
                  </p>
                  <p className="text-white/40">Wrong call? Pick a different recipe below — the art is never altered either way.</p>
                </div>
              )}
            </div>
          )}
        </div>

        {phase !== 'pick' && (
          <>
            <div className="mt-4 bg-white/5 border border-white/10 rounded-xl p-4">
              <label className="block text-xs font-bold uppercase tracking-wide text-white/60 mb-2">
                2 · Recipe
              </label>
              {/* v9 mobile-first: one dropdown + the chosen recipe's
                  blurb, instead of nine stacked cards on a phone. */}
              <select
                aria-label="Promo recipe"
                value={recipe}
                onChange={(e) => setRecipe(e.target.value as PromoRecipeId)}
                className="w-full min-h-[48px] bg-white/5 border border-gold/40 rounded-lg px-3 py-2 text-sm font-bold text-white focus:outline-none focus:border-gold"
              >
                {RECIPES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-white/50 mt-2">{recipeMeta.blurb}</p>
              {fileProblem && <p className="text-xs text-amber-300 mt-3">{fileProblem}</p>}

              <div className="flex flex-wrap items-center gap-2 mt-4">
                <span className="text-xs font-bold uppercase tracking-wide text-white/60 mr-1">Format</span>
                {ASPECT_RATIO_OPTIONS.map((r) => (
                  <button key={r.id} onClick={() => setRatioId(r.id)} className={chipCls(ratioId === r.id)}>
                    {r.id}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <span className="text-xs font-bold uppercase tracking-wide text-white/60 mr-1">Length</span>
                {[10, 12, 15].map((d) => (
                  <button key={d} onClick={() => setDuration(d)} className={chipCls(duration === d)}>
                    {d}s
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <span className="text-xs font-bold uppercase tracking-wide text-white/60 mr-1">Stage fit</span>
                <button onClick={() => setFit('fit')} className={chipCls(fit === 'fit')}>Fit whole art</button>
                <button onClick={() => setFit('fill')} className={chipCls(fit === 'fill')}>Fill screen</button>
              </div>
              {fit === 'fill' && analysis?.suggestedKind === 'flyer' && (
                <p className="text-xs text-amber-300 mt-2">
                  Fill screen crops the edges — flyer text near the edge may clip. Fit whole art never crops anything.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <span className="text-xs font-bold uppercase tracking-wide text-white/60 mr-1">Skin</span>
                {(Object.keys(PROMO_SKINS) as PromoSkinId[]).map((id) => (
                  <button key={id} onClick={() => setSkin(id)} className={chipCls(skin === id)}>
                    {PROMO_SKINS[id].label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <span className="text-xs font-bold uppercase tracking-wide text-white/60 mr-1">Beat</span>
                <select
                  aria-label="Pack track"
                  value={packTrackForSkin(skin, packTrackId).id}
                  onChange={(e) => {
                    setPackTrackId(e.target.value);
                    setOwnTrack(null);
                    setMusicOn(true);
                  }}
                  className={`min-h-[36px] rounded-lg border px-2 text-xs font-bold focus:outline-none focus:border-gold/60 ${musicOn && !ownTrack ? 'bg-gold text-black border-gold' : 'bg-white/5 border-white/10 text-white/80'}`}
                >
                  {PROMO_PACK_SHELVES[skin].map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title} — {t.artist}
                    </option>
                  ))}
                </select>
                <button onClick={() => ownTrackInputRef.current?.click()} className={chipCls(musicOn && !!ownTrack)}>
                  {ownTrack ? `Your track: ${ownTrack.name}` : 'Your own track'}
                </button>
                <input
                  ref={ownTrackInputRef}
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      setOwnTrack(f);
                      setMusicOn(true);
                    }
                    e.target.value = '';
                  }}
                />
                <button
                  onClick={() => {
                    setOwnTrack(null);
                    setMusicOn(false);
                  }}
                  className={chipCls(!musicOn)}
                >
                  No music
                </button>
                {musicOn && !ownTrack && (
                  <span className="text-[11px] text-white/40">
                    A real recording ({packTrackForSkin(skin, packTrackId).license}), fitted to your promo's length.
                  </span>
                )}
                {musicOn && ownTrack && (
                  <span className="text-[11px] text-white/40">Your track, fitted to your promo's length.</span>
                )}
              </div>
            </div>

            <div className="mt-4 bg-white/5 border border-white/10 rounded-xl p-4 space-y-3">
              <label className="block text-xs font-bold uppercase tracking-wide text-white/60">
                3 · Your words — auto-filled from your artwork, edit anything
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-bold uppercase tracking-wide text-white/40">Type style — premium fonts</span>
                <select
                  aria-label="Promo font"
                  value={fontFamily}
                  onChange={(e) => setFontFamily(e.target.value)}
                  className="w-full min-h-11 bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-sm text-white focus:outline-none focus:border-gold/60"
                  style={{ fontFamily: fontFamily }}
                >
                  {FONT_OPTIONS.map((f) => (
                    <option key={f.family} value={f.family}>
                      {f.label} — {f.vibe}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {(
                  [
                    ['hook1', 'Hook line 1 — e.g. ONE NIGHT.'],
                    ['hook2', 'Hook line 2 — e.g. TWO SOUNDS.'],
                    ['cta', 'Call to action — e.g. TICKETS: LINK IN BIO'],
                    ['sub', 'Sub line — date • venue • city'],
                  ] as Array<[SuggestionField, string]>
                ).map(([field, placeholder]) => (
                  <div key={field} className="relative">
                    <input className={`${inputCls} pr-10`} placeholder={placeholder} value={texts[field] ?? ''}
                      onChange={(e) => {
                        touchedRef.current.add(field);
                        setTexts((t) => ({ ...t, [field]: e.target.value }));
                      }} />
                    <button
                      type="button"
                      aria-label={`Another suggestion for ${field}`}
                      title="Another suggestion"
                      onClick={() => cycleField(field)}
                      className="absolute right-1 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-md text-white/40 hover:text-gold hover:bg-white/10"
                    >
                      <RefreshCw size={14} />
                    </button>
                  </div>
                ))}
              </div>
              {(suggesting || autoNote) && (
                <p className="text-[11px] text-white/40">
                  {suggesting ? `Analyzing your artwork on this device${analyzePct !== null ? ` — ${analyzePct}%` : '…'}` : autoNote}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  onClick={handleSaveKit}
                  className="min-h-[40px] px-3 rounded-lg border border-gold/40 bg-gold/10 hover:bg-gold/20 text-gold text-[11px] font-bold"
                >
                  Save CTA + sub + skin as my brand defaults
                </button>
                <button
                  onClick={handleAnalyze}
                  disabled={suggesting || !analysis}
                  className="min-h-[40px] px-3 rounded-lg border border-gold/40 bg-gold/10 hover:bg-gold/20 text-gold text-[11px] font-bold disabled:opacity-50"
                >
                  {suggesting ? 'Analyzing…' : 'Analyze artwork'}
                </button>
                {kitNote && <span className="text-[11px] text-white/40">{kitNote}</span>}
              </div>
              {readLines.length > 0 && (
                <div className="rounded-lg border border-white/10 bg-black/30 p-3 space-y-1.5">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-white/50">What the engine read</p>
                  {readLines.map((line, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="flex-1 min-w-0 truncate text-xs text-white/85" title={line.text}>{line.text}</span>
                      <span className="text-[10px] text-white/30 shrink-0">{line.confidence}%</span>
                      {(['hook', 'sub', 'cta'] as const).map((target) => (
                        <button
                          key={target}
                          onClick={() => assignReadLine(target, line.text)}
                          className="shrink-0 min-h-[28px] px-2 rounded-md border border-white/15 bg-white/5 hover:bg-gold/20 hover:text-gold text-[10px] font-bold uppercase text-white/60"
                        >
                          {target}
                        </button>
                      ))}
                    </div>
                  ))}
                  <p className="text-[10px] text-white/35 pt-0.5">Tap Hook, Sub or CTA to place a line exactly where it belongs.</p>
                </div>
              )}
            </div>

            <button
              onClick={() => void handleBuild()}
              disabled={phase === 'building' || !!fileProblem}
              className="mt-6 w-full py-3 min-h-[48px] bg-gold hover:bg-gold-bright disabled:opacity-50 rounded-lg text-black text-sm font-black uppercase tracking-wide"
            >
              {phase === 'building' ? status || 'Building…' : 'Build my promo'}
            </button>
            <p className="text-xs text-white/40 mt-3 text-center">
              Opens in the editor with the beat already on — fine-tune, then export. Free accounts carry the RiddimRoom mark.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
