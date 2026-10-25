import React, { useCallback, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLicenseTier } from '../hooks/useLicenseTier';
import BrandLogo from './BrandLogo';
import { analyzeImageFile, recipeBands, sliceBandFiles, type ArtworkAnalysis } from '../lib/promo/analyze';
import { buildKineticProject, buildLogoProject, buildSlamProject, type PromoRecipeId, type PromoTexts } from '../lib/promo/recipes';
import { createProject, saveProject } from '../lib/projects/persistence';
import { uploadMediaFile } from '../lib/media/upload';

/**
 * Viral Promo — one upload in, a scroll-stopping vertical promo project out.
 *
 * The page runs the Director analysis in the browser (band detection +
 * artwork classification), lets the user confirm the recipe and the added
 * kinetic type, then builds a normal Studio project with the proven recipe
 * builders and opens it in the editor — preview, music and export all use
 * Studio's existing engine, licensing and watermark rules. Access is the
 * existing account gate: pending users never reach this page (App routes
 * them to the pending screen), and the owner toggles testers on in Admin.
 */

const RECIPE_FOR_KIND: Record<ArtworkAnalysis['suggestedKind'], PromoRecipeId> = {
  logo: 'logo-build',
  portrait: 'slam',
  flyer: 'kinetic-build',
};

const RECIPE_LABELS: Record<PromoRecipeId, { name: string; blurb: string }> = {
  'kinetic-build': {
    name: 'Kinetic Build',
    blurb: 'Your flyer assembles itself piece by piece on the beat, shine sweep, then the CTA card.',
  },
  'logo-build': {
    name: 'Logo Build',
    blurb: 'Your logo elements power on one by one into a tall vertical lockup with a sheen finish.',
  },
  slam: {
    name: 'Slam',
    blurb: 'Full-screen impact: punch-zoom entrance, slow push, hook type, then the CTA phase.',
  },
};

const KIND_LABELS: Record<ArtworkAnalysis['suggestedKind'], string> = {
  logo: 'Logo on a dark ground',
  portrait: 'Portrait art / photo',
  flyer: 'Flyer / poster',
};

interface PromoPageProps {
  onOpenProject: (projectId: string) => void;
  onBack: () => void;
}

export function PromoPage({ onOpenProject, onBack }: PromoPageProps) {
  const { currentUser } = useAuth();
  const { tier } = useLicenseTier();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [analysis, setAnalysis] = useState<ArtworkAnalysis | null>(null);
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const fileRef = useRef<File | null>(null);
  const [recipe, setRecipe] = useState<PromoRecipeId>('kinetic-build');
  const [texts, setTexts] = useState<PromoTexts>({ hook1: '', hook2: '', cta: '', sub: '' });
  const [duration, setDuration] = useState(12);
  const [phase, setPhase] = useState<'pick' | 'ready' | 'building'>('pick');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    try {
      const { analysis: a, bitmap } = await analyzeImageFile(file);
      bitmapRef.current = bitmap;
      fileRef.current = file;
      setAnalysis(a);
      setRecipe(RECIPE_FOR_KIND[a.suggestedKind]);
      setFileName(file.name);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(file);
      });
      setPhase('ready');
    } catch (err: any) {
      setError(err?.message || 'That file could not be read as an image.');
    }
  }, []);

  const handleBuild = useCallback(async () => {
    if (!currentUser || !fileRef.current || !bitmapRef.current || !analysis) return;
    setPhase('building');
    setError(null);
    try {
      const uid = currentUser.uid;
      const base = fileName.replace(/\.[^.]+$/, '') || 'promo';
      const cleanTexts: PromoTexts = {
        hook1: texts.hook1?.trim() || undefined,
        hook2: texts.hook2?.trim() || undefined,
        cta: texts.cta?.trim() || undefined,
        sub: texts.sub?.trim() || undefined,
      };
      setStatus('Creating your project…');
      let project = await createProject(uid, `Viral Promo — ${base}`, 1080, 1920, {
        watermarkEnabled: tier !== 'lifetime',
      });

      if (recipe === 'slam') {
        setStatus('Uploading your artwork…');
        const art = await uploadMediaFile({ uid, file: fileRef.current });
        project = buildSlamProject(project, art.asset, cleanTexts, duration);
      } else {
        const bands = recipeBands(analysis);
        setStatus(`Slicing your artwork into ${bands.length} pieces…`);
        const sliceFiles = await sliceBandFiles(bitmapRef.current, bands, base);
        const slices = [];
        for (let i = 0; i < sliceFiles.length; i++) {
          setStatus(`Uploading piece ${i + 1} of ${sliceFiles.length}…`);
          const up = await uploadMediaFile({ uid, file: sliceFiles[i] });
          slices.push({ asset: up.asset, band: bands[i] });
        }
        if (recipe === 'logo-build') {
          project = buildLogoProject(project, slices, cleanTexts, duration);
        } else {
          setStatus('Uploading your artwork…');
          const art = await uploadMediaFile({ uid, file: fileRef.current });
          project = buildKineticProject(project, art.asset, slices, cleanTexts, duration);
        }
      }

      setStatus('Saving…');
      await saveProject(project);
      onOpenProject(project.id);
    } catch (err: any) {
      setError(err?.message || 'The promo could not be built. Try again.');
      setPhase('ready');
    }
  }, [currentUser, analysis, fileName, recipe, texts, duration, tier, onOpenProject]);

  const inputCls =
    'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-gold/60';

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
          vertical promo ready to post. <span className="text-white font-bold">Your artwork is never redrawn</span> —
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
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
            className="block w-full text-sm text-white/70 file:mr-3 file:px-4 file:py-2 file:rounded-lg file:border file:border-gold/60 file:bg-gold/15 file:text-gold file:text-xs file:font-bold file:uppercase"
          />
          {previewUrl && (
            <div className="mt-4 flex gap-4 items-start">
              <img src={previewUrl} alt="Your artwork" className="w-32 rounded-lg border border-white/10" />
              {analysis && (
                <div className="text-xs text-white/60 space-y-1">
                  <p>
                    Detected: <span className="text-white font-bold">{KIND_LABELS[analysis.suggestedKind]}</span>
                  </p>
                  <p>
                    {analysis.width} × {analysis.height}px · {analysis.bands.length} element band
                    {analysis.bands.length === 1 ? '' : 's'} found
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
                {(Object.keys(RECIPE_LABELS) as PromoRecipeId[]).map((id) => (
                  <button
                    key={id}
                    onClick={() => setRecipe(id)}
                    className={`text-left rounded-lg border p-3 transition ${
                      recipe === id ? 'bg-gold/15 border-gold/60' : 'bg-white/5 border-white/10 hover:bg-white/10'
                    }`}
                  >
                    <p className={`text-sm font-bold ${recipe === id ? 'text-gold' : 'text-white'}`}>{RECIPE_LABELS[id].name}</p>
                    <p className="text-xs text-white/50 mt-1">{RECIPE_LABELS[id].blurb}</p>
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 mt-4">
                <span className="text-xs font-bold uppercase tracking-wide text-white/60">Length</span>
                {[10, 12, 15].map((d) => (
                  <button
                    key={d}
                    onClick={() => setDuration(d)}
                    className={`px-3 py-1.5 rounded-lg border text-xs font-bold ${
                      duration === d ? 'bg-gold text-black border-gold' : 'bg-white/5 border-white/10 text-white/70'
                    }`}
                  >
                    {d}s
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
              disabled={phase === 'building'}
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
