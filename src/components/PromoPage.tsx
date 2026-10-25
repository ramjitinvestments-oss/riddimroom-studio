import React, { useCallback, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLicenseTier } from '../hooks/useLicenseTier';
import BrandLogo from './BrandLogo';
import { analyzeImageFile, recipeBands, sliceBandFiles, type ArtworkAnalysis } from '../lib/promo/analyze';
import {
  buildCountdownProject, buildKineticProject, buildLineupProject, buildLogoProject,
  buildNewsflashProject, buildSlamProject, buildStackProject, buildVersusProject,
  PROMO_SKINS, type PromoRecipeId, type PromoSkinId, type PromoTexts,
} from '../lib/promo/recipes';
import { ASPECT_RATIO_OPTIONS } from '../lib/aspectRatios';
import { createProject, saveProject } from '../lib/projects/persistence';
import { uploadMediaFile } from '../lib/media/upload';

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
  const [duration, setDuration] = useState(12);
  const [phase, setPhase] = useState<'pick' | 'ready' | 'building'>('pick');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pickedRef = useRef<PickedFile[]>([]);
  pickedRef.current = picked;

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setError(null);
    try {
      const list = Array.from(files).slice(0, 6);
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
    } catch (err: any) {
      setError(err?.message || 'That file could not be read as an image.');
    }
  }, []);

  const recipeMeta = RECIPES.find((r) => r.id === recipe)!;
  const fileProblem: string | null =
    recipeMeta.need === 'two' && picked.length !== 2
      ? 'Versus needs exactly 2 artworks.'
      : recipeMeta.need === 'lineup' && picked.length < 2
        ? 'Lineup needs the poster plus at least 1 more artwork.'
        : recipeMeta.need === 'stack' && (picked.length < 2 || picked.length > 4)
          ? 'Flyer Stack needs 2 to 4 artworks.'
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

      if (recipe === 'slam' || recipe === 'spin-slam') {
        const art = await upload(first, 'your artwork');
        project = buildSlamProject(project, art, cleanTexts, { ...buildOpts, variant: recipe === 'spin-slam' ? 'spin' : 'slam' });
      } else if (recipe === 'countdown') {
        const art = await upload(first, 'your artwork');
        project = buildCountdownProject(project, art, cleanTexts, buildOpts);
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
          project = buildKineticProject(project, art, slices, cleanTexts, buildOpts);
        }
      }

      setStatus('Saving…');
      await saveProject(project);
      onOpenProject(project.id);
    } catch (err: any) {
      setError(err?.message || 'The promo could not be built. Try again.');
      setPhase('ready');
    }
  }, [currentUser, picked, analysis, fileProblem, ratioId, fit, skin, texts, duration, recipe, tier, onOpenProject]);

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
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {RECIPES.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setRecipe(r.id)}
                    className={`text-left rounded-lg border p-3 transition ${
                      recipe === r.id ? 'bg-gold/15 border-gold/60' : 'bg-white/5 border-white/10 hover:bg-white/10'
                    }`}
                  >
                    <p className={`text-sm font-bold ${recipe === r.id ? 'text-gold' : 'text-white'}`}>{r.name}</p>
                    <p className="text-xs text-white/50 mt-1">{r.blurb}</p>
                  </button>
                ))}
              </div>
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
            </div>

            <div className="mt-4 bg-white/5 border border-white/10 rounded-xl p-4 space-y-3">
              <label className="block text-xs font-bold uppercase tracking-wide text-white/60">
                3 · Your words (optional — added type, your art stays untouched)
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input className={inputCls} placeholder="Hook line 1 — e.g. ONE NIGHT." value={texts.hook1}
                  onChange={(e) => setTexts((t) => ({ ...t, hook1: e.target.value }))} />
                <input className={inputCls} placeholder="Hook line 2 — e.g. TWO SOUNDS." value={texts.hook2}
                  onChange={(e) => setTexts((t) => ({ ...t, hook2: e.target.value }))} />
                <input className={inputCls} placeholder="Call to action — e.g. TICKETS: LINK IN BIO" value={texts.cta}
                  onChange={(e) => setTexts((t) => ({ ...t, cta: e.target.value }))} />
                <input className={inputCls} placeholder="Sub line — e.g. SAT • DEC 20 • THE GRAND HALL" value={texts.sub}
                  onChange={(e) => setTexts((t) => ({ ...t, sub: e.target.value }))} />
              </div>
            </div>

            <button
              onClick={() => void handleBuild()}
              disabled={phase === 'building' || !!fileProblem}
              className="mt-6 w-full py-3 min-h-[48px] bg-gold hover:bg-gold-bright disabled:opacity-50 rounded-lg text-black text-sm font-black uppercase tracking-wide"
            >
              {phase === 'building' ? status || 'Building…' : 'Build my promo'}
            </button>
            <p className="text-xs text-white/40 mt-3 text-center">
              Opens in the editor — add music, fine-tune, then export. Free accounts carry the RiddimRoom mark.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
