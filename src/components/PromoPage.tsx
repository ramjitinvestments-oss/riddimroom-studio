import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLicenseTier } from '../hooks/useLicenseTier';
import BrandLogo from './BrandLogo';
import { analyzeImageFile, recipeBands, sliceBandFiles, type ArtworkAnalysis } from '../lib/promo/analyze';
import {
  buildCountdownProject, buildKineticProject, buildLineupProject, buildLogoProject,
  buildNewsflashProject, buildSlamProject, buildStackProject, buildVersusProject,
  PROMO_SKINS, type PromoRecipeId, type PromoSkinId, type PromoTexts, type SliceInput,
} from '../lib/promo/recipes';
import { ASPECT_RATIO_OPTIONS } from '../lib/aspectRatios';
import { createDefaultProject, createProject, saveProject } from '../lib/projects/persistence';
import { uploadMediaFile } from '../lib/media/upload';
import { probeAudioDurationSeconds } from '../lib/media/tracks';
import { loadBrandKit, saveBrandKit } from '../lib/promo/brandKit';
import type { ExtractedSite } from '../lib/promo/siteExtract';
import {
  approvedFacts, clearSiteProfile, loadSiteProfile, profileFromScan, saveSiteProfile,
  siteCampaignPools, type SiteProfile,
} from '../lib/promo/siteProfile';
import { checkFactTexts, lineFactsApproved, type FactReceipt } from '../lib/promo/factCheck';
import { fetchSiteImageFile, requestSiteScan } from '../lib/promo/siteScanClient';
import {
  bankSuggestion,
  type NoTextPurpose,
  cycleAlternate,
  posterAlternates,
  posterSuggestion,
  fieldAlternates,
  mergeIntoUntouched,
  resolveCampaignContext,
  type CampaignContext,
  splitHeadline,
  suggestedSkinFor,
  type SuggestionContext,
  type SuggestionField,
  type VisionSuggestion,
} from '../lib/promo/suggest';
import { analyzeArtwork } from '../lib/promo/ocrEngine';
import { parseEventDate, planCampaign, campaignFileName, type CampaignPiece, type CampaignPlan } from '../lib/promo/campaign';
import { detectBeats, findHookWindow } from '../lib/media/beats';
import { convertPromoTextToCaptions } from '../lib/promo/viralCaptions';
import { CAPTION_SIZE_TIERS, type CaptionSizeTier } from '../lib/captions/styles';
import { createExportRenderer, getConfiguredExportEngine } from '../lib/export/mediabunnyExporter';
import { validateRenderResult } from '../lib/export/validate';
import { transcodeWebmToMp4 } from '../lib/export/mp4Transcoder';
import { resolveExportSettings } from '../lib/export/quality';
import { buildSocialPosts, buildSoundGuide, type SocialPost } from '../lib/export/socialPosts';
import { canExportToday, exportsRemainingToday, recordExport } from '../lib/licensing';
import { evaluateProjectExportGate } from '../lib/projectDurationGate';
import { classifyReadout, isCleanLine, mergeReadoutFields, stripJunkEdges, type FieldSource, type OcrLine, type ReadoutResult } from '../lib/promo/readout';
import { loadArtworkFixes, saveArtworkFixes } from '../lib/promo/fixes';
import type { SnapCorrection } from '../lib/promo/snap';
import { applyCameraTour, applyHomecoming, applyStageBackdrop } from '../lib/promo/camera';
import { enforceTextLayout } from '../lib/promo/layout';
import {
  POSTER_FORMATS,
  buildPosterProject,
  createCanvasMeasurer,
  createScrimFile,
  pickPosterLayout,
  renderPosterStillBlob,
  type PosterFormatId,
  type PosterLayout,
  type PosterLayoutChoice,
} from '../lib/promo/poster';
import type { FrameAssets } from '../lib/render/compositor';
import { RefreshCw } from 'lucide-react';
import { DEFAULT_PROMO_FONT, FONT_OPTIONS, ensureFontsLoaded } from '../lib/fonts';
import { addItem, addMediaAsset, generateTimelineId, getTracksByType, updateItem } from '../lib/timeline/utils';
import type { AudioTimelineItem, MediaAsset, Project } from '../types/timeline';
import { MAX_FADE_SECONDS } from '../lib/media/constants';
import {
  clampFadeSeconds,
  computePeaks,
  effectiveStart,
  fittedPromoFade,
  promoStartForWindow,
  type SongPeaks,
} from '../lib/media/songPart';
import { SongPartPicker } from './SongPartPicker';

/**
 * R17/R20 music start: shift the music item's window to a chosen
 * start in the track — the detected hook by default, or the exact
 * part the user picked. Returns the project and how far the music
 * actually shifted (the beat grid shifts with it). No-ops for
 * looped items and tracks too short to hold the window.
 */
function applyMusicStart(project: Project, startAt: number, totalSeconds: number): { project: Project; applied: number } {
  if (startAt <= 0.25) return { project, applied: 0 };
  const item = project.items.find((i) => i.type === 'audio' && i.role === 'music');
  if (!item || item.type !== 'audio' || item.loop) return { project, applied: 0 };
  const asset = project.mediaAssets[item.mediaAssetId];
  if (!asset?.durationSeconds || asset.durationSeconds < startAt + totalSeconds) return { project, applied: 0 };
  return {
    project: updateItem(project, item.id, { trimStart: startAt, trimEnd: startAt + totalSeconds }),
    applied: startAt,
  };
}

/**
 * Adds the skin's built-in beat to a built promo, fitted to its length:
 * trimmed when the promo fits inside the 8s loop, looped when it must
 * repeat, with the R26 fitted fade — fade-in 0s, fade-out 2s at the
 * fitted end, clamped by `fittedPromoFade` (the ONE definition of the
 * rule, in lib/media/songPart). Pure: the caller renders + uploads
 * the loop.
 */
function addPromoMusic(project: Project, asset: MediaAsset, totalSeconds: number): Project {
  const track = getTracksByType(project, 'audio')[0];
  if (!track) return project;
  const sourceDuration =
    typeof asset.durationSeconds === 'number' && asset.durationSeconds > 0 ? asset.durationSeconds : totalSeconds;
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
    fade: fittedPromoFade(totalSeconds),
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

interface CampaignResult {
  piece: CampaignPiece;
  projectId: string;
  posts: SocialPost[];
  fileName: string;
  /** built = project saved, ready to open; done = MP4 rendered here. */
  status: 'built' | 'done' | 'failed';
  url?: string;
  blob?: Blob;
  error?: string;
  /** R26 (WS-A1): the built project's fitted music item, so its fades
      stay adjustable right here on the results card. The sliders
      mutate + re-save that piece's saved project (see
      handleResultFade) — a piece already rendered keeps its MP4;
      the new fades apply when it is next rendered/opened. */
  musicItemId?: string;
  musicFittedSeconds?: number;
  fadeIn?: number;
  fadeOut?: number;
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
  const textsRef = useRef(texts);
  textsRef.current = texts;
  /** R18: persist the user's corrected wording for this artwork
      (after the edit lands) so it is never handed back wrong. */
  const persistFixesSoon = useCallback(() => {
    setTimeout(() => {
      const key = suggestKeyRef.current;
      if (!key) return;
      const t = textsRef.current;
      const anyTouched = (['hook1', 'hook2', 'sub', 'cta'] as SuggestionField[]).some(
        (f) => touchedRef.current.has(f) && (t[f] ?? '').trim().length > 0,
      );
      if (anyTouched) saveArtworkFixes(key, t);
    }, 0);
  }, []);
  const [autoNote, setAutoNote] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [analyzePct, setAnalyzePct] = useState<number | null>(null);
  const [readLines, setReadLines] = useState<OcrLine[]>([]);
  /** R16 provenance: where each field's words came from. */
  const [fieldSources, setFieldSources] = useState<Partial<Record<SuggestionField, FieldSource | 'yours'>>>({});
  /** R21: URL campaign — the scan draft, the confirmed website
      profile, and the offer the campaign is grounded in. */
  const [siteUrl, setSiteUrl] = useState('');
  const [siteScanning, setSiteScanning] = useState(false);
  const [siteScanError, setSiteScanError] = useState<string | null>(null);
  const [siteScan, setSiteScan] = useState<ExtractedSite | null>(null);
  const [siteProfile, setSiteProfile] = useState<SiteProfile | null>(null);
  const [siteOfferId, setSiteOfferId] = useState('');
  const [sitePicks, setSitePicks] = useState<Partial<Record<'phone' | 'email', string>>>({});
  const [siteEdits, setSiteEdits] = useState<Partial<Record<'name' | 'tagline' | 'phone' | 'email' | 'address', string>>>({});
  const [siteImageBusy, setSiteImageBusy] = useState(false);
  const [siteNote, setSiteNote] = useState<string | null>(null);
  /** R16: the engine read too little — ask for the headline once. */
  const [needsHeadlineAsk, setNeedsHeadlineAsk] = useState(false);
  const [askValue, setAskValue] = useState('');
  const skinTouchedRef = useRef(false);
  const touchedRef = useRef<Set<string>>(new Set());
  const visionRef = useRef<VisionSuggestion | null>(null);
  const suggestCtxRef = useRef<SuggestionContext | null>(null);
  const suggestRunRef = useRef(0);
  const currentUserRef = useRef<typeof currentUser>(null);
  currentUserRef.current = currentUser;
  const lastBitmapRef = useRef<ImageBitmap | null>(null);
  const inFlightRef = useRef(0);
  const readCacheRef = useRef<Map<string, ReadoutResult>>(new Map());
  const lastReadoutRef = useRef<ReadoutResult | null>(null);
  const suggestKeyRef = useRef<string>('');
  const [ownTrack, setOwnTrack] = useState<File | null>(null);
  /** R20: the user's chosen music start (seconds into their track);
      null = automatic (the detected hook). */
  const [musicStart, setMusicStart] = useState<number | null>(null);
  const [ownTrackSeconds, setOwnTrackSeconds] = useState<number | null>(null);
  /** R26 (WS-A3): the picked track's detected hook + waveform peaks,
      feeding the song-part picker before build (the build itself
      reuses the same cached analysis). */
  const [ownTrackHook, setOwnTrackHook] = useState<number | null>(null);
  const [ownTrackPeaks, setOwnTrackPeaks] = useState<SongPeaks | null>(null);
  /** R26 (WS-A1): built campaign projects by id, kept so the results
      cards' fade sliders can mutate + re-save them in place. */
  const builtProjectsRef = useRef(new Map<string, Project>());
  /** R20: the picked art carries no readable words — captions are
      composed from its look + the user's one-tap purpose answer. */
  const [artNoWords, setArtNoWords] = useState(false);
  const [artPurpose, setArtPurpose] = useState<NoTextPurpose | null>(null);
  const paletteRef = useRef<{ warmth: number; saturation: number; meanLuminance: number } | null>(null);
  const purposeRef = useRef<NoTextPurpose | null>(null);
  useEffect(() => {
    setMusicStart(null);
    if (!ownTrack) {
      setOwnTrackSeconds(null);
      return;
    }
    let live = true;
    void probeAudioDurationSeconds(ownTrack).then((seconds) => {
      if (live) setOwnTrackSeconds(seconds);
    });
    return () => {
      live = false;
    };
  }, [ownTrack]);
  const [fontFamily, setFontFamily] = useState<string>(DEFAULT_PROMO_FONT);
  /** R27 (WS-M2): the poster builder keeps its OWN font — the two
      selects no longer share one hidden state. */
  const [posterFontFamily, setPosterFontFamily] = useState<string>(DEFAULT_PROMO_FONT);
  /** R27 (WS-M2): "Fine-tune (optional)" disclosure, closed by default. */
  const [fineTuneOpen, setFineTuneOpen] = useState(false);
  /** R27 (WS-M2): technical read detail ("Show what was read"), closed by default. */
  const [showReadDetail, setShowReadDetail] = useState(false);
  /** R27 (WS-M2): the headline the readout found, for the human summary. */
  const [readHeadline, setReadHeadline] = useState('');
  /** R27 (WS-M2): campaign result pieces expanded via their Details toggle. */
  const [expandedPieces, setExpandedPieces] = useState<Set<string>>(new Set());
  const ownTrackInputRef = useRef<HTMLInputElement | null>(null);
  const [duration, setDuration] = useState(12);
  const [musicOn, setMusicOn] = useState(true);
  const [kitNote, setKitNote] = useState<string | null>(null);
  /** R18 correctness: the name/brand as printed (snap-to-truth
      target), the snap repairs to show, and the saved-fix note. */
  const [brandName, setBrandName] = useState('');
  const brandNameRef = useRef('');
  const [corrections, setCorrections] = useState<SnapCorrection[]>([]);
  const [fixNote, setFixNote] = useState<string | null>(null);
  const [phase, setPhase] = useState<'pick' | 'ready' | 'building'>('pick');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [campaignResults, setCampaignResults] = useState<CampaignResult[]>([]);
  const [campaignRunning, setCampaignRunning] = useState(false);
  const [campaignStatus, setCampaignStatus] = useState('');
  const [campaignPct, setCampaignPct] = useState(0);
  const [campaignNote, setCampaignNote] = useState<string | null>(null);
  const [copiedPieceId, setCopiedPieceId] = useState<string | null>(null);
  const campaignAbortRef = useRef<AbortController | null>(null);
  /** R17 Viral Finish: words as beat-timed animated captions, and
      music that starts at its hook. */
  const [captionMode, setCaptionMode] = useState<'words' | 'lines'>('words');
  /** R19: caption size tier for the viral-words conversion (promo
      words are headlines — L is the default). */
  const [captionSize, setCaptionSize] = useState<CaptionSizeTier>('L');
  const [hookTrim, setHookTrim] = useState(true);
  const trackAnalysisCacheRef = useRef(new Map<string, Promise<{ beats: number[]; bpm: number; hook: number } | null>>());

  /** R23 Headline Poster: the user's own photo + one headline + one
      sub, built as a normal project by lib/promo/poster. Suggestions
      fill only fields the user has not touched (posterTouchedRef),
      exactly like the artwork flow's touchedRef rule. */
  const [posterOpen, setPosterOpen] = useState(false);
  const [posterPicked, setPosterPicked] = useState<PickedFile | null>(null);
  const [posterAnalysis, setPosterAnalysis] = useState<ArtworkAnalysis | null>(null);
  const [posterTexts, setPosterTexts] = useState<{ headline: string; sub: string }>({ headline: '', sub: '' });
  const posterTouchedRef = useRef<Set<'headline' | 'sub'>>(new Set());
  const [posterLayoutChoice, setPosterLayoutChoice] = useState<PosterLayoutChoice>('auto');
  const [posterPurpose, setPosterPurpose] = useState<NoTextPurpose | null>(null);
  const [posterProject, setPosterProject] = useState<Project | null>(null);
  const [posterPreviewUrl, setPosterPreviewUrl] = useState<string | null>(null);
  const [posterStatus, setPosterStatus] = useState('');
  const [posterError, setPosterError] = useState<string | null>(null);
  const [posterNote, setPosterNote] = useState<string | null>(null);
  /** Uploaded assets of the built master, kept so the 4:5 / 1:1
      derivatives reuse the same photo (scrims are per-format). */
  const posterBuiltRef = useRef<{
    photo: MediaAsset;
    layout: PosterLayout;
    scrims: Partial<Record<PosterFormatId, MediaAsset | null>>;
    stillBlob: Blob | null;
  } | null>(null);

  /** Decode a track once (cached per file) and read its beat grid
      + hook position — the Viral Finish runs on these. */
  const analyzeTrackFile = useCallback(async (file: File, totalSeconds: number) => {
    const key = `${file.name}:${file.size}`;
    let pending = trackAnalysisCacheRef.current.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const buffer = await file.arrayBuffer();
          const ctx = new OfflineAudioContext(1, 1, 44100);
          const audio = await ctx.decodeAudioData(buffer);
          const samples = audio.getChannelData(0);
          const grid = detectBeats(samples, audio.sampleRate);
          return { beats: grid.beats, bpm: grid.bpm, hook: findHookWindow(samples, audio.sampleRate, totalSeconds) };
        } catch {
          return null;
        }
      })();
      trackAnalysisCacheRef.current.set(key, pending);
    }
    return pending;
  }, []);
  const pickedRef = useRef<PickedFile[]>([]);
  pickedRef.current = picked;

  // R26 (WS-A3): as soon as a track is picked, run the same cached
  // analysis the build uses (hook position) plus the waveform peaks,
  // so the song-part picker can show both before anything is built.
  useEffect(() => {
    if (!ownTrack) {
      setOwnTrackHook(null);
      setOwnTrackPeaks(null);
      return;
    }
    let live = true;
    const file = ownTrack;
    void analyzeTrackFile(file, duration).then((a) => {
      if (live) setOwnTrackHook(a ? a.hook : null);
    });
    void computePeaks(file).then((p) => {
      if (live) setOwnTrackPeaks(p);
    });
    return () => {
      live = false;
    };
  }, [ownTrack, duration, analyzeTrackFile]);

  // Brand kit: prefill this device's saved defaults once, on mount.
  useEffect(() => {
    void ensureFontsLoaded();
    const kit = loadBrandKit();
    if (kit) {
      skinTouchedRef.current = true; // a saved kit is the user's own choice
      setSkin(kit.skinId);
      setTexts((t) => ({ ...t, cta: kit.ctaText, sub: kit.subText }));
      if (kit.brandName) {
        setBrandName(kit.brandName);
        brandNameRef.current = kit.brandName;
      }
      setKitNote('Brand defaults loaded from this device.');
    }
  }, []);

  // R34: poster door deep-link — the Dashboard's Headline Poster door
  // sets this key before navigating here; open the poster builder
  // (the same state the "Other ways to start" card sets) and clear it.
  useEffect(() => {
    try {
      if (sessionStorage.getItem('rr-promo-start') === 'poster') {
        sessionStorage.removeItem('rr-promo-start');
        setPosterOpen(true);
      }
    } catch {
      /* sessionStorage unavailable — no deep-link, no behaviour change */
    }
  }, []);

  // R21: a website profile confirmed on this device is offered again.
  useEffect(() => {
    const saved = loadSiteProfile();
    if (saved) {
      setSiteProfile(saved);
      setSiteUrl(saved.url);
      if (saved.offers.length > 0) setSiteOfferId(saved.offers[0].id);
      setSiteNote('Website profile loaded from this device — scan again any time to refresh it.');
    }
  }, []);

  const handleSaveKit = useCallback(() => {
    const ok = saveBrandKit({ ctaText: texts.cta?.trim() ?? '', subText: texts.sub?.trim() ?? '', skinId: skin, brandName: brandName.trim() });
    setKitNote(ok ? 'Saved — these will prefill next time, on this device.' : 'Could not save on this device.');
  }, [texts.cta, texts.sub, skin, brandName]);


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
    lastReadoutRef.current = result;
    setReadLines(result.lines);
    setReadHeadline(result.headline);
    setCorrections(result.corrections);
    setTexts((t) => mergeReadoutFields(t, touchedRef.current, result));
    // R18 correction memory: words the user already fixed FOR THIS
    // ARTWORK come back exactly as corrected — a re-read never hands
    // him the same wrong word twice.
    const fixes = loadArtworkFixes(suggestKeyRef.current);
    if (fixes) {
      const appliedFields = (['hook1', 'hook2', 'sub', 'cta'] as SuggestionField[]).filter((f) => fixes[f]?.trim());
      if (appliedFields.length > 0) {
        for (const f of appliedFields) touchedRef.current.add(f);
        setTexts((t) => {
          const next = { ...t };
          for (const f of appliedFields) next[f] = fixes[f] as string;
          return next;
        });
        setFieldSources((prev) => {
          const next = { ...prev };
          for (const f of appliedFields) next[f] = 'yours' as const;
          return next;
        });
        setFixNote('Your saved fixes for this artwork are on — the words you corrected stay corrected.');
      }
    }
    setFieldSources((prev) => {
      const next = { ...prev };
      for (const f of ['hook1', 'hook2', 'sub', 'cta'] as SuggestionField[]) {
        if (touchedRef.current.has(f)) continue;
        if (result.fields[f]) next[f] = result.sources[f] ?? 'art';
        else delete next[f];
      }
      return next;
    });
    setArtNoWords(false);
    if (!skinTouchedRef.current) setSkin(suggestedSkinFor(result.genre, suggestCtxRef.current?.kind, paletteRef.current));
    setNeedsHeadlineAsk(!result.headline && result.lines.length < 3);
    setAutoNote(
      result.headline
        ? 'Words read from your artwork itself — tap any line to make it yours.'
        : 'Studio read your artwork — tap a line below to place it where it belongs.',
    );
  }, []);

  /** R20: the no-text purpose answer re-runs the bank for untouched
      fields with the purpose steering it. 'Just the look' also
      CLEARS the generic sub/CTA on untouched fields — minimal means
      minimal. Everything stays labelled 'suggested'. */
  const applyPurpose = useCallback((purpose: NoTextPurpose) => {
    purposeRef.current = purpose;
    setArtPurpose(purpose);
    const base = suggestCtxRef.current;
    if (!base) return;
    const bank = bankSuggestion({ ...base, purpose, brandName: brandNameRef.current || undefined });
    setTexts((t) => {
      const next = { ...t };
      for (const f of ['hook1', 'hook2', 'sub', 'cta'] as SuggestionField[]) {
        if (touchedRef.current.has(f)) continue;
        if (bank[f]) next[f] = bank[f];
        else if (purpose === 'look') next[f] = '';
      }
      return next;
    });
    setFieldSources((prev) => {
      const next = { ...prev };
      for (const f of ['hook1', 'hook2', 'sub', 'cta'] as SuggestionField[]) {
        if (touchedRef.current.has(f)) continue;
        if (bank[f]) next[f] = 'suggested';
        else delete next[f];
      }
      return next;
    });
    setAutoNote('This image has no words — these captions are suggestions built from its look, not a read. Edit anything.');
  }, []);

  const runSuggestion = useCallback(async (bitmap: ImageBitmap, kind: SuggestionContext['kind'], fileName: string, cacheKey = '', force = false) => {
    const runId = ++suggestRunRef.current;
    const ctx: SuggestionContext = { kind, fileName, brandName: brandNameRef.current || undefined, purpose: purposeRef.current };
    suggestCtxRef.current = ctx;
    suggestKeyRef.current = cacheKey;
    setCorrections([]);
    setFixNote(null);
    lastBitmapRef.current = bitmap;
    visionRef.current = null;
    lastReadoutRef.current = null;
    const bank = bankSuggestion(ctx);
    setTexts((t) => mergeIntoUntouched(t, touchedRef.current, bank));
    setFieldSources((prev) => {
      const next = { ...prev };
      for (const f of ['hook1', 'hook2', 'sub', 'cta'] as SuggestionField[]) {
        if (!touchedRef.current.has(f) && bank[f]) next[f] = 'suggested';
      }
      return next;
    });
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
          setAutoNote('Studio could not load the artwork reader — check your connection. Suggested words are in; tap "Analyze artwork" to try again.');
        }
        return;
      }
      if (suggestRunRef.current !== runId) return;
      if (lines.length === 0) {
        setReadLines([]);
        setReadHeadline('');
        setArtNoWords(true);
        // No words, no genre — the palette picks the stage dressing.
        if (!skinTouchedRef.current) setSkin(suggestedSkinFor('', suggestCtxRef.current?.kind, paletteRef.current));
        setAutoNote(
          purposeRef.current
            ? 'This image has no words — these captions are suggestions built from its look, not a read. Edit anything.'
            : 'This image has no words — suggestions from its look are in. Tell me what it’s for (below) and they’ll fit better.',
        );
        return;
      }
      const result = classifyReadout(lines, ctx, { brandName: brandNameRef.current });
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
    setFieldSources((prev) => ({
      ...prev,
      ...(target === 'hook' ? { hook1: 'art' as const, hook2: 'art' as const } : { [target]: 'art' as const }),
    }));
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
    persistFixesSoon();
  }, [persistFixesSoon]);

  const cycleField = useCallback((field: SuggestionField) => {
    const ctx = suggestCtxRef.current;
    if (!ctx) return;
    touchedRef.current.add(field);
    const visionValue = visionRef.current?.[field]?.trim();
    const alternates = Array.from(
      new Set([visionValue, ...fieldAlternates(field, ctx)].filter((v): v is string => !!v && v.length > 0)),
    );
    setTexts((t) => {
      const value = cycleAlternate(alternates, t[field] ?? '');
      setFieldSources((prev) => ({ ...prev, [field]: visionValue && value === visionValue ? ('art' as const) : ('suggested' as const) }));
      return { ...t, [field]: value };
    });
    persistFixesSoon();
  }, [persistFixesSoon]);

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
      if (firstAnalysis) {
        paletteRef.current = {
          warmth: firstAnalysis.palette.warmth,
          saturation: firstAnalysis.palette.saturation,
          meanLuminance: firstAnalysis.meanLuminance,
        };
        setRecipe(RECIPE_FOR_KIND[firstAnalysis.suggestedKind]);
      }
      setPhase('ready');
      if (firstAnalysis && results[0]) {
        void runSuggestion(results[0].bitmap, firstAnalysis.suggestedKind, list[0].name, `${list[0].name}:${list[0].size}`);
      }
    } catch (err: any) {
      setError(err?.message || 'That file could not be read as an image.');
    }
  }, [runSuggestion]);

  /** R23: the SuggestionContext for poster copy — the same
      construction the artwork flow builds in runSuggestion (kind +
      file name + purpose + brand name), pointed at the poster photo. */
  const posterCtx = useCallback(
    (pickedFile: PickedFile, a: ArtworkAnalysis, purpose: NoTextPurpose | null): SuggestionContext => ({
      kind: a.suggestedKind,
      fileName: pickedFile.file.name,
      purpose,
      brandName: brandNameRef.current || undefined,
    }),
    [],
  );

  /** R23: fill headline/sub from the poster bank — untouched fields
      only; a field the user has typed in or cycled is theirs. */
  const applyPosterSuggestion = useCallback(
    (pickedFile: PickedFile, a: ArtworkAnalysis, purpose: NoTextPurpose | null) => {
      const s = posterSuggestion(posterCtx(pickedFile, a, purpose));
      setPosterTexts((t) => ({
        headline: posterTouchedRef.current.has('headline') ? t.headline : s.headline || t.headline,
        sub: posterTouchedRef.current.has('sub') ? t.sub : s.sub || t.sub,
      }));
    },
    [posterCtx],
  );

  const handlePosterPurpose = useCallback(
    (purpose: NoTextPurpose) => {
      setPosterPurpose(purpose);
      if (posterPicked && posterAnalysis) applyPosterSuggestion(posterPicked, posterAnalysis, purpose);
    },
    [posterPicked, posterAnalysis, applyPosterSuggestion],
  );

  const cyclePosterField = useCallback(
    (field: 'headline' | 'sub') => {
      if (!posterPicked || !posterAnalysis) return;
      posterTouchedRef.current.add(field);
      const alternates = posterAlternates(field, posterCtx(posterPicked, posterAnalysis, posterPurpose));
      setPosterTexts((t) => ({ ...t, [field]: cycleAlternate(alternates, t[field]) }));
    },
    [posterPicked, posterAnalysis, posterCtx, posterPurpose],
  );

  const handlePosterFile = useCallback(
    async (file: File) => {
      setPosterError(null);
      try {
        const { analysis: a, bitmap } = await analyzeImageFile(file);
        const next: PickedFile = { file, bitmap, previewUrl: URL.createObjectURL(file) };
        setPosterPicked((prev) => {
          if (prev) URL.revokeObjectURL(prev.previewUrl);
          return next;
        });
        setPosterAnalysis(a);
        // A new photo invalidates any poster built from the old one.
        setPosterProject(null);
        posterBuiltRef.current = null;
        setPosterPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return null;
        });
        applyPosterSuggestion(next, a, posterPurpose);
      } catch (err: any) {
        setPosterError(err?.message || 'That file could not be read as an image.');
      }
    },
    [applyPosterSuggestion, posterPurpose],
  );

  const resolvedPosterLayout = useCallback((): PosterLayout => {
    if (posterLayoutChoice !== 'auto') return posterLayoutChoice;
    return posterAnalysis ? pickPosterLayout(posterAnalysis) : 'B';
  }, [posterLayoutChoice, posterAnalysis]);

  /** R23: FrameAssets for a still render, mirroring the export
      renderer's preload (canvas2dRenderer): one detached <img> per
      image asset in the project, keyed by asset id and loaded from
      the asset's storage URL, waiting for load before drawing. */
  const loadPosterFrameAssets = useCallback(async (project: Project): Promise<FrameAssets> => {
    const images = new Map<string, HTMLImageElement>();
    await Promise.all(
      Object.values(project.mediaAssets)
        .filter((asset) => asset.kind === 'image')
        .map(
          (asset) =>
            new Promise<void>((resolve) => {
              const el = new Image();
              el.crossOrigin = 'anonymous';
              el.addEventListener('load', () => resolve(), { once: true });
              el.addEventListener('error', () => resolve(), { once: true });
              el.src = asset.storageUrl;
              images.set(asset.id, el);
              if (el.complete) resolve();
            }),
        ),
    );
    return { images };
  }, []);

  const downloadPosterBlob = useCallback((blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, []);

  const handleBuildPoster = useCallback(async () => {
    if (!currentUser || !posterPicked || !posterAnalysis) return;
    setPosterError(null);
    setPosterNote(null);
    try {
      const uid = currentUser.uid;
      const format = POSTER_FORMATS['9:16'];
      const layout = resolvedPosterLayout();
      const base = cleanName(posterPicked.file.name);
      setPosterStatus('Creating your poster project…');
      // Same licensing rule as handleBuild: free-tier projects carry
      // the watermark, so the still does too (the compositor draws
      // the watermark pill into the frame).
      let project = await createProject(uid, `Headline Poster — ${base}`, format.canvasWidth, format.canvasHeight, {
        watermarkEnabled: tier !== 'lifetime',
      });
      setPosterStatus('Uploading your photo…');
      const photo = (await uploadMediaFile({ uid, file: posterPicked.file })).asset;
      setPosterStatus('Building the poster…');
      const scrimFile = await createScrimFile(layout, format.canvasWidth, format.canvasHeight);
      const scrim = (await uploadMediaFile({ uid, file: scrimFile })).asset;
      project = buildPosterProject(
        project,
        photo,
        scrim,
        {
          headline: posterTexts.headline.trim(),
          sub: posterTexts.sub.trim() || undefined,
          headlineFont: posterFontFamily,
        },
        { layout },
        createCanvasMeasurer(),
      );
      project = enforceTextLayout(project);
      setPosterStatus('Saving…');
      project = await saveProject(project);
      setPosterProject(project);
      posterBuiltRef.current = { photo, layout, scrims: { '9:16': scrim }, stillBlob: null };
      setPosterStatus('Rendering your preview…');
      const blob = await renderPosterStillBlob(project, await loadPosterFrameAssets(project));
      if (posterBuiltRef.current) posterBuiltRef.current.stillBlob = blob;
      setPosterPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
      setPosterNote(
        'Poster saved as its own project — download it below, re-render it in another format, open it in the editor, or animate it.',
      );
    } catch (err: any) {
      setPosterError(err?.message || 'The poster could not be built. Try again.');
    } finally {
      setPosterStatus('');
    }
  }, [currentUser, posterPicked, posterAnalysis, resolvedPosterLayout, posterTexts, posterFontFamily, tier, loadPosterFrameAssets]);

  /** R23: download the 9:16 master still, or a 4:5 / 1:1 derivative —
      a FRESH build at that format's canvas (the builder re-lays the
      text out; never a crop), rendered and downloaded without saving
      a second project. The photo asset is reused; the scrim is
      created per format because its gradient is sized to its canvas. */
  const handleDownloadPoster = useCallback(
    async (formatId: PosterFormatId) => {
      const master = posterProject;
      const built = posterBuiltRef.current;
      if (!currentUser || !master || !built) return;
      setPosterError(null);
      try {
        if (formatId === '9:16') {
          const blob = built.stillBlob ?? (await renderPosterStillBlob(master, await loadPosterFrameAssets(master)));
          downloadPosterBlob(blob, 'headline-poster-9x16.png');
          return;
        }
        const format = POSTER_FORMATS[formatId];
        setPosterStatus(`Rendering the ${formatId} poster…`);
        let scrim = built.scrims[formatId];
        if (scrim === undefined) {
          const scrimFile = await createScrimFile(built.layout, format.canvasWidth, format.canvasHeight);
          scrim = (await uploadMediaFile({ uid: currentUser.uid, file: scrimFile })).asset;
          built.scrims[formatId] = scrim;
        }
        // createDefaultProject (not createProject): the derivative
        // is rendered and discarded — only the 9:16 master is saved.
        let derivative = createDefaultProject(currentUser.uid, master.name, format.canvasWidth, format.canvasHeight, {
          watermarkEnabled: tier !== 'lifetime',
        });
        derivative = buildPosterProject(
          derivative,
          built.photo,
          scrim,
          {
            headline: posterTexts.headline.trim(),
            sub: posterTexts.sub.trim() || undefined,
            headlineFont: posterFontFamily,
          },
          { layout: built.layout },
          createCanvasMeasurer(),
        );
        derivative = enforceTextLayout(derivative);
        const blob = await renderPosterStillBlob(derivative, await loadPosterFrameAssets(derivative));
        downloadPosterBlob(blob, `headline-poster-${formatId.replace(':', 'x')}.png`);
      } catch (err: any) {
        setPosterError(err?.message || 'That poster could not be rendered. Try again.');
      } finally {
        setPosterStatus('');
      }
    },
    [currentUser, posterProject, posterTexts, posterFontFamily, tier, loadPosterFrameAssets, downloadPosterBlob],
  );

  /** R23 WS4: flatten the built poster to a PNG and hand it to the
      existing promo flow as source art — handleFiles runs the same
      analysis/suggestion path as a user upload, so recipes, the word
      camera tour and Homecoming all apply to it unchanged. The
      layered poster project stays saved for editing. */
  const handleAnimatePoster = useCallback(async () => {
    const master = posterProject;
    const built = posterBuiltRef.current;
    if (!master || !built) return;
    setPosterError(null);
    try {
      setPosterStatus('Flattening your poster…');
      const blob = built.stillBlob ?? (await renderPosterStillBlob(master, await loadPosterFrameAssets(master)));
      built.stillBlob = blob;
      const file = new File([blob], 'headline-poster.png', { type: 'image/png' });
      await handleFiles([file]);
      setPosterNote(
        'Your poster is loaded as the artwork — pick a recipe and style in the sections below, then build. The layered poster project stays saved.',
      );
    } catch (err: any) {
      setPosterError(err?.message || 'The poster could not be handed to the promo builder. Try again.');
    } finally {
      setPosterStatus('');
    }
  }, [posterProject, loadPosterFrameAssets, handleFiles]);

  /** R21: scan a website into a DRAFT profile — nothing is used
      until the user reviews and confirms it below. */
  const handleSiteScan = useCallback(async () => {
    if (!currentUser) {
      setSiteScanError('Sign in first — website scanning is for approved accounts.');
      return;
    }
    const url = siteUrl.trim();
    if (!url) {
      setSiteScanError('Paste your website address first.');
      return;
    }
    setSiteScanning(true);
    setSiteScanError(null);
    setSiteNote(null);
    try {
      const token = await currentUser.getIdToken();
      const outcome = await requestSiteScan(url, token);
      if (!outcome.ok) {
        setSiteScanError(outcome.error);
        return;
      }
      const scan = outcome.scan;
      if (!scan.readable) {
        setSiteScan(null);
        setSiteScanError(
          scan.reason === 'blocked'
            ? 'That website refused the scan — many sites block automated reads. A screenshot or flyer upload above will work instead.'
            : scan.reason === 'spa'
              ? 'That website builds its pages with JavaScript, so there is no readable text to scan. A screenshot or flyer upload above will work instead.'
              : scan.reason === 'http-error'
                ? 'That page returned an error — double-check the address and try again.'
                : 'We could not find readable content at that address — double-check it and try again.',
        );
        return;
      }
      setSiteScan(scan);
      setSiteEdits({
        name: scan.name?.value ?? '',
        tagline: scan.tagline?.value ?? '',
        phone: scan.phone?.value ?? '',
        email: scan.email?.value ?? '',
        address: scan.address?.value ?? '',
      });
      setSitePicks({ phone: scan.phone?.value, email: scan.email?.value });
      setSiteOfferId(scan.offers.length > 0 ? 'offer-0' : '');
      setSiteNote('We read your website — check every word below. Nothing is used until you confirm.');
    } catch {
      setSiteScanError('The scan could not be completed — try again in a moment.');
    } finally {
      setSiteScanning(false);
    }
  }, [currentUser, siteUrl]);

  /** R21: confirmation is the accuracy gate — only now do the
      website's facts become campaign material (verbatim, 'site'
      provenance, protected from bank overwrites). */
  const handleConfirmSiteProfile = useCallback(() => {
    if (!siteScan) return;
    const profile = profileFromScan(siteScan, { picks: sitePicks, edits: siteEdits });
    const offer = profile.offers.find((o) => o.id === siteOfferId) ?? null;
    setSiteProfile(profile);
    saveSiteProfile(profile);
    setSiteScan(null);
    const services = offer && offer.services.length ? offer.services : profile.services;
    const next: PromoTexts = {};
    const sources: Partial<Record<SuggestionField, FieldSource | 'yours'>> = {};
    const fill = (field: SuggestionField, value: string | null | undefined) => {
      const v = (value ?? '').trim();
      if (!v) return;
      next[field] = v;
      sources[field] = 'site';
      touchedRef.current.add(field);
    };
    fill('hook1', offer?.name ?? profile.name?.value);
    fill('hook2', profile.tagline?.value ?? services[0]);
    fill('sub', services.slice(0, 2).join(' • '));
    fill('cta', profile.phone?.value ? `CALL ${profile.phone.value}` : null);
    setTexts((t) => ({ ...t, ...next }));
    setFieldSources((prev) => ({ ...prev, ...sources }));
    if (profile.name?.value) {
      setBrandName(profile.name.value);
      brandNameRef.current = profile.name.value;
    }
    saveBrandKit({
      ctaText: next.cta ?? textsRef.current.cta ?? '',
      subText: next.sub ?? textsRef.current.sub ?? '',
      skinId: skin,
      brandName: profile.name?.value ?? '',
    });
    setSiteNote(
      'Profile confirmed. Pick one of your website images below to use as the artwork — or upload your own above — then build as usual. Every campaign piece will be checked against these facts.',
    );
  }, [siteScan, sitePicks, siteEdits, siteOfferId, skin]);

  const handleSiteImage = useCallback(
    async (imageUrl: string) => {
      if (!currentUser || siteImageBusy) return;
      setSiteImageBusy(true);
      setSiteScanError(null);
      try {
        const token = await currentUser.getIdToken();
        const outcome = await fetchSiteImageFile(imageUrl, token);
        if (!outcome.ok) {
          setSiteScanError(outcome.error);
          return;
        }
        await handleFiles([outcome.file]);
      } catch {
        setSiteScanError('That image could not be loaded — try another, or upload your own above.');
      } finally {
        setSiteImageBusy(false);
      }
    },
    [currentUser, siteImageBusy, handleFiles],
  );

  const handleForgetSite = useCallback(() => {
    setSiteProfile(null);
    setSiteScan(null);
    setSiteOfferId('');
    clearSiteProfile();
    setSiteNote(null);
  }, []);

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

      // Music (R20): the user's OWN track only — the app adds no
      // audio of its own anymore (the built-in pack and loops were
      // removed on the owner's directive). No track = a silent
      // promo. A failure here never blocks the build.
      let trackFile: File | null = null;
      if (musicOn && ownTrack) {
        try {
          setStatus('Adding your track…');
          const musicFile: File = ownTrack;
          {
            const probed = await probeAudioDurationSeconds(musicFile);
            const up = await uploadMediaFile({ uid, file: musicFile });
            const asset =
              probed && (!up.asset.durationSeconds || Math.abs(up.asset.durationSeconds - probed) > 0.75)
                ? { ...up.asset, durationSeconds: probed }
                : up.asset;
            project = addPromoMusic(project, asset, duration);
            trackFile = musicFile;
          }
        } catch {
          // Music is a layer, not a blocker — the promo still opens.
        }
      }

      // R12 premium pass: the word-box camera tour (when the
      // artwork's readout gave us word boxes) and the art-derived
      // stage backdrop (when the recipe left a black void).
      const readout = lastReadoutRef.current;
      if (readout) project = applyCameraTour(project, readout);
      project = applyStageBackdrop(project);
      project = applyHomecoming(project);
      project = enforceTextLayout(project);

      // R17 Viral Finish: start the music at its hook, then (in
      // Viral Words mode) turn the field lines into beat-timed
      // animated captions — the compositor pops each word gold as
      // its beat lands.
      const trackAnalysis = trackFile ? await analyzeTrackFile(trackFile, duration) : null;
      let appliedHook = 0;
      // The user's chosen part wins; otherwise the hook, when on.
      const startAt = musicStart ?? (hookTrim && trackAnalysis ? trackAnalysis.hook : 0);
      if (startAt > 0) {
        const trimmed = applyMusicStart(project, startAt, duration);
        project = trimmed.project;
        appliedHook = trimmed.applied;
      }
      if (captionMode === 'words') {
        const beats = (trackAnalysis?.beats ?? []).map((b) => b - appliedHook).filter((b) => b >= 0);
        project = convertPromoTextToCaptions(
          project,
          [cleanTexts.hook1 ?? '', cleanTexts.hook2 ?? '', cleanTexts.sub ?? '', cleanTexts.cta ?? ''],
          beats,
          undefined,
          CAPTION_SIZE_TIERS[captionSize],
        );
      }

      setStatus('Saving…');
      await saveProject(project);
      onOpenProject(project.id);
    } catch (err: any) {
      setError(err?.message || 'The promo could not be built. Try again.');
      setPhase('ready');
    }
  }, [currentUser, picked, analysis, fileProblem, ratioId, fit, skin, texts, duration, recipe, tier, onOpenProject, musicOn, ownTrack, musicStart, fontFamily, captionMode, hookTrim, analyzeTrackFile, captionSize]);


  /**
   * R24 (WS-C2/C5): THE resolved campaign context — resolved once
   * here, and genre, tag set, rotation pools and social posts all
   * key from it. Precedence: confirmed site profile → the user's
   * purpose answer → the artwork's own detected genre → filename.
   * Nothing in the campaign/results path detects genre on its own.
   */
  const resolvedContext = useCallback((): CampaignContext => {
    const g = lastReadoutRef.current?.genre ?? visionRef.current?.genre ?? '';
    return resolveCampaignContext({
      siteProfile,
      purpose: suggestCtxRef.current?.purpose ?? null,
      artworkGenre: g,
      suggestionCtx: suggestCtxRef.current,
    });
  }, [siteProfile]);

  /**
   * Alternate hook pairs for the campaign, best first: a strong
   * line the engine read but the fields didn't use, then the genre
   * bank's next pair. The planner dedupes against the master pair —
   * an "alt hook" that repeats the master is not an alt.
   */
  const currentAltPairs = useCallback((): Array<[string, string]> => {
    const pairs: Array<[string, string]> = [];
    const used = new Set(
      [texts.hook1, texts.hook2, texts.sub, texts.cta]
        .map((v) => (v ?? '').trim().toUpperCase())
        .filter(Boolean),
    );
    const readout = lastReadoutRef.current;
    if (readout) {
      const candidates = readout.lines
        .filter((l) => {
          const t = stripJunkEdges(l.text).trim();
          return l.confidence >= 55 && t.length >= 3 && t.length <= 40 && !used.has(t.toUpperCase());
        })
        .sort((a, b) => (b.box?.h ?? 0) - (a.box?.h ?? 0))
        .slice(0, 2);
      for (const candidate of candidates) {
        pairs.push(splitHeadline(stripJunkEdges(candidate.text).trim().toUpperCase()));
      }
    }
    const ctx = suggestCtxRef.current;
    if (ctx) {
      const genre = resolvedContext().genre;
      const h1 = fieldAlternates('hook1', ctx, genre);
      const h2 = fieldAlternates('hook2', ctx, genre);
      for (let i = 0; i < Math.min(h1.length, h2.length); i++) {
        if (h1[i] || h2[i]) pairs.push([h1[i] ?? '', h2[i] ?? '']);
      }
    }
    return pairs;
  }, [texts.hook1, texts.hook2, texts.sub, texts.cta, resolvedContext]);

  /**
   * Alternate sub lines for the campaign, ART FIRST (R16): the
   * artwork's own unused read lines — venue, date, brand lines —
   * rotate before any bank line is borrowed.
   */
  const campaignAltSubs = useCallback((): string[] => {
    const used = new Set(
      [texts.hook1, texts.hook2, texts.sub, texts.cta].map((v) => (v ?? '').trim().toUpperCase()).filter(Boolean),
    );
    const fromArt: string[] = [];
    const readout = lastReadoutRef.current;
    if (readout) {
      const lines = readout.lines
        .map((l) => ({ ...l, text: stripJunkEdges(l.text).trim() }))
        .filter((l) => l.confidence >= 50 && isCleanLine(l.text) && l.text.length >= 3 && l.text.length <= 42 && !used.has(l.text.toUpperCase()))
        .sort((a, b) => (b.box?.h ?? 0) - (a.box?.h ?? 0));
      for (const l of lines) if (!fromArt.includes(l.text)) fromArt.push(l.text);
    }
    const bank = suggestCtxRef.current
      ? fieldAlternates('sub', suggestCtxRef.current, resolvedContext().genre)
      : [];
    return [...fromArt, ...bank.filter((b) => !fromArt.some((a) => a.toUpperCase() === b.toUpperCase()))];
  }, [texts.hook1, texts.hook2, texts.sub, texts.cta, resolvedContext]);

  /** R21: when a website profile drives the campaign, build the
      planner extras once: pools from approved site facts only, a
      fact guard for bank lines, and the offer's real date. */
  const sitePlanExtras = useCallback(() => {
    if (!siteProfile) return null;
    const facts = approvedFacts(siteProfile);
    const offer = siteProfile.offers.find((o) => o.id === siteOfferId) ?? null;
    const pools = siteCampaignPools(siteProfile, offer);
    const t = textsRef.current;
    const confirmedTexts = [t.hook1 ?? '', t.hook2 ?? '', t.sub ?? '', t.cta ?? ''];
    const guard = (line: string) => lineFactsApproved(line, facts, confirmedTexts);
    const parsed = offer?.date ? new Date(offer.date) : null;
    const offerDate = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
    // R24 (WS-C4): event evidence for a site campaign is a real
    // event offer — a selected offer carrying a date from the site.
    return { facts, offer, pools, guard, offerDate, hasEventOffer: offerDate != null };
  }, [siteProfile, siteOfferId]);

  /**
   * R24: ONE plan-input builder for the campaign runner AND the
   * plan preview, so the preview can never diverge from what
   * actually builds. Everything keys from the resolved context:
   * site campaigns draw rotation pools from profile-approved lines
   * only (the planner adds the resolved genre's bank lines behind
   * the fact guard — never filename-genre party/ticket copy), and
   * event-only copy requires event evidence.
   */
  const campaignPlanInput = (kind: 'logo' | 'portrait' | 'flyer') => {
    const extras = sitePlanExtras();
    const rctx = resolvedContext();
    return {
      genre: rctx.genre,
      input: {
        texts: { hook1: texts.hook1, hook2: texts.hook2, cta: texts.cta, sub: texts.sub },
        masterRecipe: recipe,
        masterFormatId: ratioId,
        kind,
        altHookPairs: extras ? extras.pools.altHookPairs : currentAltPairs(),
        altSubs: extras ? extras.pools.altSubs : campaignAltSubs(),
        altCtas: extras
          ? extras.pools.altCtas
          : suggestCtxRef.current
            ? fieldAlternates('cta', suggestCtxRef.current, rctx.genre)
            : [],
        genre: rctx.genre,
        eventDate: extras?.offerDate ?? parseEventDate({ sub: texts.sub, hook1: texts.hook1, hook2: texts.hook2 }),
        eventEvidence: extras ? extras.hasEventOffer : suggestCtxRef.current?.purpose === 'event',
        silent: rctx.silent,
        font: fontFamily,
        factGuard: extras?.guard,
      },
    };
  };

  /**
   * The Campaign Engine runner: plan the set, upload the artwork
   * ONCE, build + save every piece's project, then render MP4s in
   * place — inside the plan's daily export allowance, each render
   * counted exactly like an editor export. Pieces past the limit
   * stay saved as projects (one tap in the editor finishes them),
   * and every piece carries its own ready-written social posts.
   */
  const handleCampaign = useCallback(async () => {
    if (!currentUser || picked.length === 0 || !analysis || fileProblem || campaignRunning) return;
    const uid = currentUser.uid;
    const base = cleanName(picked[0].file.name);
    const planInput = campaignPlanInput(analysis.suggestedKind);
    const campaignGenre = planInput.genre;
    const plan = planCampaign(planInput.input);
    setCampaignRunning(true);
    setCampaignNote(null);
    setCampaignResults([]);
    setCampaignPct(0);
    const controller = new AbortController();
    campaignAbortRef.current = controller;
    const results: CampaignResult[] = [];
    try {
      setCampaignStatus('Uploading your artwork once for the whole set…');
      const assets: MediaAsset[] = [];
      for (let i = 0; i < picked.length; i++) {
        assets.push((await uploadMediaFile({ uid, file: picked[i].file })).asset);
      }
      const art = assets[0];
      const extras = assets.slice(1);

      let slices: SliceInput[] | null = null;
      if (plan.pieces.some((pc) => pc.recipe === 'kinetic-build' || pc.recipe === 'logo-build')) {
        const bands = recipeBands(analysis);
        const featherPx = recipe === 'kinetic-build' ? Math.max(6, Math.round(picked[0].bitmap.height * 0.008)) : 0;
        const sliceFiles = await sliceBandFiles(picked[0].bitmap, bands, base, { featherPx });
        slices = [];
        for (let i = 0; i < sliceFiles.length; i++) {
          const up = await uploadMediaFile({ uid, file: sliceFiles[i] });
          slices.push({ asset: up.asset, band: bands[i] });
        }
      }

      let musicAsset: MediaAsset | null = null;
      let campaignTrackFile: File | null = null;
      if (musicOn && ownTrack) {
        try {
          setCampaignStatus('Fitting your track for the set…');
          const musicFile: File = ownTrack;
          {
            const probed = await probeAudioDurationSeconds(musicFile);
            const up = await uploadMediaFile({ uid, file: musicFile });
            musicAsset =
              probed && (!up.asset.durationSeconds || Math.abs(up.asset.durationSeconds - probed) > 0.75)
                ? { ...up.asset, durationSeconds: probed }
                : up.asset;
            campaignTrackFile = musicFile;
          }
        } catch {
          musicAsset = null;
        }
      }

      const readout = lastReadoutRef.current;
      const trackAnalysis = campaignTrackFile ? await analyzeTrackFile(campaignTrackFile, duration) : null;
      const built: Array<{ entry: CampaignResult; project: Project }> = [];
      for (const piece of plan.pieces) {
        if (controller.signal.aborted) break;
        setCampaignStatus(`Building ${piece.label}…`);
        const ratio = ASPECT_RATIO_OPTIONS.find((r) => r.id === piece.formatId) ?? ASPECT_RATIO_OPTIONS[1];
        let project = await createProject(uid, `Viral Promo — ${base} (${piece.label})`, ratio.canvasWidth, ratio.canvasHeight, {
          watermarkEnabled: tier !== 'lifetime',
        });
        const opts = { duration, fit, skin };
        switch (piece.recipe) {
          case 'slam':
          case 'spin-slam':
            project = buildSlamProject(project, art, piece.texts, { ...opts, extras, variant: piece.recipe === 'spin-slam' ? 'spin' : 'slam' });
            break;
          case 'countdown':
            project = buildCountdownProject(project, art, piece.texts, { ...opts, extras });
            break;
          case 'newsflash':
            project = buildNewsflashProject(project, art, piece.texts, opts);
            break;
          case 'versus':
            project = buildVersusProject(project, assets[0], assets[1] ?? assets[0], piece.texts, opts);
            break;
          case 'lineup':
            project = buildLineupProject(
              project,
              assets.map((asset, i) => ({ asset, name: cleanName(picked[i].file.name) })),
              piece.texts,
              opts,
            );
            break;
          case 'flyer-stack':
            project = buildStackProject(project, assets, piece.texts, opts);
            break;
          case 'logo-build':
            project = buildLogoProject(project, slices ?? [], piece.texts, opts);
            break;
          default:
            project = buildKineticProject(project, art, slices ?? [], piece.texts, { ...opts, extras });
        }
        if (musicAsset) project = addPromoMusic(project, musicAsset, duration);
        if (readout) project = applyCameraTour(project, readout);
        project = applyStageBackdrop(project);
        project = applyHomecoming(project);
        project = enforceTextLayout(project);
        // R17/R20 Viral Finish, per piece (see the single build).
        let appliedHook = 0;
        const startAt = musicStart ?? (hookTrim && trackAnalysis ? trackAnalysis.hook : 0);
        if (startAt > 0) {
          const trimmed = applyMusicStart(project, startAt, duration);
          project = trimmed.project;
          appliedHook = trimmed.applied;
        }
        if (captionMode === 'words') {
          const beats = (trackAnalysis?.beats ?? []).map((b) => b - appliedHook).filter((b) => b >= 0);
          project = convertPromoTextToCaptions(
            project,
            [piece.texts.hook1 ?? '', piece.texts.hook2 ?? '', piece.texts.sub ?? '', piece.texts.cta ?? ''],
            beats,
            undefined,
            CAPTION_SIZE_TIERS[captionSize],
          );
        }
        await saveProject(project);
        // R26 (WS-A1): keep the built project + its fitted music item
        // so the results card can adjust the music fades in place.
        builtProjectsRef.current.set(project.id, project);
        const musicItem = project.items.find((i) => i.type === 'audio' && i.role === 'music');
        const entry: CampaignResult = {
          piece,
          projectId: project.id,
          ...(musicItem && musicItem.type === 'audio'
            ? {
                musicItemId: musicItem.id,
                musicFittedSeconds: musicItem.endTime - musicItem.startTime,
                fadeIn: musicItem.fade.fadeInDuration,
                fadeOut: musicItem.fade.fadeOutDuration,
              }
            : {}),
          // R24 (WS-C1/C5): posts are written from the piece's
          // planner texts + the resolved context — never scraped
          // from the rendered items (caption conversion deletes
          // them) and never re-detected in the results path.
          posts: buildSocialPosts(project, {
            texts: piece.texts,
            genre: campaignGenre,
            formatLabel: piece.label,
          }),
          fileName: campaignFileName(base, piece),
          status: 'built',
        };
        results.push(entry);
        built.push({ entry, project });
        setCampaignResults([...results]);
      }

      // Render phase — same engine, same validation, same daily
      // counter as an editor export.
      const engine = getConfiguredExportEngine();
      const renderer = createExportRenderer(engine);
      await ensureFontsLoaded([fontFamily]);
      let quotaHit = false;
      let capHit = false;
      for (const { entry, project } of built) {
        if (controller.signal.aborted) break;
        // R35: the tier duration gate runs before the quota check and
        // before any rendering — a refused piece is marked on its
        // result card with the gate's plain message, consumes no
        // daily quota, and never reaches the renderer.
        const gate = evaluateProjectExportGate(project, tier);
        if (gate.exceedsCap) {
          capHit = true;
          entry.status = 'failed';
          entry.error = gate.message ?? undefined;
          setCampaignResults([...results]);
          continue;
        }
        if (!canExportToday(uid, tier)) {
          quotaHit = true;
          break;
        }
        try {
          setCampaignStatus(`Rendering ${entry.piece.label}…`);
          setCampaignPct(0);
          const output = resolveExportSettings(project.canvasWidth, project.canvasHeight, {
            resolution: 'native',
            frameRate: project.frameRate || 30,
            quality: 'high',
          });
          const result = await renderer.render(project, {
            signal: controller.signal,
            output,
            onProgress: (pr) => setCampaignPct(Math.round(pr.fraction * 100)),
          });
          const validation = validateRenderResult(result.blob, result.durationSeconds);
          if (!validation.valid) throw new Error(validation.error || 'Export failed validation.');
          let mp4 = result.blob;
          if (engine !== 'mediabunny') mp4 = await transcodeWebmToMp4(result.blob, project.frameRate || 30);
          recordExport(uid);
          entry.blob = mp4;
          entry.url = URL.createObjectURL(mp4);
          entry.status = 'done';
        } catch (err: any) {
          if (controller.signal.aborted) break;
          entry.status = 'failed';
          entry.error = err?.message || 'This piece could not be rendered here — open its project to export it.';
        }
        setCampaignResults([...results]);
      }

      if (controller.signal.aborted) {
        setCampaignNote('Campaign stopped — every piece built so far is saved above as its own project.');
      } else if (quotaHit) {
        setCampaignNote(
          tier === 'lifetime'
            ? 'The render queue stopped early — pieces above are saved as projects; open any of them to export.'
            : "Today's free export limit stopped the render queue — nothing is lost: every piece is saved above as its own project, ready to open and export. Lifetime removes the daily limit.",
        );
      } else if (capHit) {
        setCampaignNote('Some pieces were not rendered because they are longer than your plan allows — every piece is saved above as its own project, ready to open and trim.');
      } else if (results.length > 0 && results.every((r) => r.status === 'done')) {
        setCampaignNote('Campaign complete — every piece rendered, each with its post written under it.');
      }
    } catch (err: any) {
      setCampaignNote(err?.message || 'The campaign could not be built. Your single Build button above still works as before.');
    } finally {
      campaignAbortRef.current = null;
      setCampaignRunning(false);
      setCampaignStatus('');
      setCampaignPct(0);
    }
  }, [currentUser, picked, analysis, fileProblem, campaignRunning, recipe, ratioId, texts, fontFamily, currentAltPairs, campaignAltSubs, duration, fit, skin, tier, musicOn, ownTrack, musicStart, resolvedContext, captionMode, hookTrim, analyzeTrackFile, captionSize, sitePlanExtras]);

  /**
   * R26 (WS-A1): results-card fade adjustment. The campaign piece IS
   * a normal saved Studio project — this mutates its music item's
   * `fade` fields (clamped by the shared `clampFadeSeconds` to
   * min(3s, fitted length)) and re-saves it, no rebuild needed. A
   * piece already rendered here keeps its rendered MP4; the new
   * fades are in its project for the next render / editor open (the
   * same fields the editor's Music panel edits).
   */
  const handleResultFade = useCallback((r: CampaignResult, field: 'fadeIn' | 'fadeOut', rawValue: number) => {
    if (!r.musicItemId || r.musicFittedSeconds === undefined) return;
    const fitted = r.musicFittedSeconds;
    const fadeIn = clampFadeSeconds(field === 'fadeIn' ? rawValue : (r.fadeIn ?? 0), fitted);
    const fadeOut = clampFadeSeconds(field === 'fadeOut' ? rawValue : (r.fadeOut ?? 0), fitted);
    setCampaignResults((prev) => prev.map((x) => (x.piece.id === r.piece.id ? { ...x, fadeIn, fadeOut } : x)));
    const built = builtProjectsRef.current.get(r.projectId);
    if (!built) return;
    const next = updateItem(built, r.musicItemId, { fade: { fadeInDuration: fadeIn, fadeOutDuration: fadeOut } });
    builtProjectsRef.current.set(r.projectId, next);
    void saveProject(next).catch(() => {
      /* the on-screen values stay; the editor still offers the same sliders */
    });
  }, []);

  const shareCampaignPiece = useCallback(async (r: CampaignResult) => {
    if (!r.blob) return;
    const file = new File([r.blob], r.fileName, { type: 'video/mp4' });
    const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
    if (nav.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: r.piece.label });
      } catch {
        /* the user closed the share sheet */
      }
    }
  }, []);

  const copyCampaignPost = useCallback(async (r: CampaignResult) => {
    const text = r.posts[0]?.text ?? '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPieceId(r.piece.id);
      setTimeout(() => setCopiedPieceId((id) => (id === r.piece.id ? null : id)), 2000);
    } catch {
      /* clipboard unavailable — the post text is on screen to copy by hand */
    }
  }, []);

  const inputCls =
    'w-full min-h-11 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-base text-white placeholder-white/30 focus:outline-none focus:border-gold/60';
  const chipCls = (active: boolean) =>
    `inline-flex items-center justify-center min-h-11 px-3 py-1.5 rounded-lg border text-xs font-bold ${active ? 'bg-gold text-black border-gold' : 'bg-white/5 border-white/10 text-white/70'}`;

  const planPreview: CampaignPlan | null =
    phase !== 'pick' && analysis
      ? planCampaign(campaignPlanInput(analysis.suggestedKind).input)
      : null;

  /** R21 factual receipt: every campaign piece + post checked
      against the confirmed website profile. */
  const campaignReceipt: FactReceipt | null =
    siteProfile && campaignResults.length > 0
      ? checkFactTexts(
          campaignResults.map((r) => ({
            label: r.piece.label,
            texts: [
              ...Object.values(r.piece.texts).filter((v): v is string => typeof v === 'string'),
              ...r.posts.map((post) => post.text.replace(/#\w+/g, '')),
            ],
          })),
          approvedFacts(siteProfile),
          [texts.hook1 ?? '', texts.hook2 ?? '', texts.sub ?? '', texts.cta ?? ''],
        )
      : null;

  /** R27 (WS-M2): ONE disabled state + label for both build buttons
      (the in-flow desktop button and the mobile sticky bar). When the
      blocker is missing artwork or a file problem, the reason rides
      ON the button instead of living screens away in the Build card. */
  const buildDisabled =
    phase === 'building' || !!fileProblem || campaignRunning || picked.length === 0 || !analysis;
  const buildLabel =
    phase === 'building'
      ? status || 'Building…'
      : fileProblem
        ? fileProblem
        : picked.length === 0 || !analysis
          ? 'Add artwork to build'
          : 'Build my promo';

  /** R27 (WS-M2): the readout in human words — no bands, no
      percentages on the surface (the detail lives behind the
      "Show what was read" disclosure in the readout panel). */
  const readSummary =
    readLines.length === 0
      ? null
      : readHeadline
        ? `We found your headline and ${readLines.length} line${readLines.length === 1 ? '' : 's'} — tap any line to fix it`
        : `We read ${readLines.length} line${readLines.length === 1 ? '' : 's'} — tap any line to fix it`;

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

      <main className="max-w-3xl mx-auto px-6 pt-8 pb-28 lg:pb-8">
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
                  {readSummary ? (
                    <p>{readSummary}</p>
                  ) : suggesting ? (
                    <p>Reading your artwork…</p>
                  ) : (
                    <p>
                      {picked.length} file{picked.length === 1 ? '' : 's'} ready — your words appear below as
                      Studio reads them.
                    </p>
                  )}
                  <p className="text-white/40">Wrong call? Pick a different recipe below — the art is never altered either way.</p>
                </div>
              )}
            </div>
          )}
        </div>

        <p className="mt-8 text-[11px] font-bold uppercase tracking-wider text-white/40">
          Other ways to start
        </p>

        <div className="mt-3 bg-white/5 border border-white/10 rounded-xl p-4">
          <label className="block text-xs font-bold uppercase tracking-wide text-white/60 mb-2">
            Build from your website
          </label>
          <p className="text-xs text-white/50">
            Paste your business website and we read it — your name, services, prices and contact details,
            copied exactly as printed. You check and confirm every fact before anything is built from it.
          </p>
          {!siteProfile && !siteScan && (
            <div className="mt-3 flex gap-2">
              <input
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                placeholder="yourbusiness.com"
                inputMode="url"
                autoComplete="url"
                className={inputCls}
              />
              <button
                onClick={() => void handleSiteScan()}
                disabled={siteScanning}
                className="shrink-0 min-h-[44px] px-4 rounded-lg bg-gold text-black text-xs font-black uppercase disabled:opacity-50"
              >
                {siteScanning ? 'Scanning…' : 'Scan website'}
              </button>
            </div>
          )}
          {siteScanError && <p className="text-xs text-amber-300 mt-3">{siteScanError}</p>}
          {siteScan && (
            <div className="mt-4 space-y-3">
              <p className="text-xs font-bold text-white/80">
                Check your website profile — nothing is used until you confirm.
              </p>
              {(['name', 'tagline', 'phone', 'email', 'address'] as const).map((key) => (
                <div key={key}>
                  <label className="block text-[10px] font-bold uppercase tracking-wider text-white/40 mb-1">
                    {key === 'tagline' ? 'Tagline' : key}
                  </label>
                  <input
                    value={siteEdits[key] ?? ''}
                    onChange={(e) => setSiteEdits((prev) => ({ ...prev, [key]: e.target.value }))}
                    className={inputCls}
                    placeholder={key === 'name' ? 'Business name' : `No ${key} found — type it if you want it used`}
                  />
                </div>
              ))}
              {siteScan.conflicts.map((conflict) => (
                <div key={conflict.field} className="rounded-lg border border-amber-300/30 bg-amber-300/5 p-3">
                  <p className="text-[11px] font-bold text-amber-200">
                    Your site shows two different {conflict.field === 'phone' ? 'phone numbers' : 'email addresses'} —
                    which one should campaigns use?
                  </p>
                  <div className="mt-2 space-y-1">
                    {conflict.values.map((v) => (
                      <label key={v.value} className="flex items-center gap-2 text-xs text-white/80">
                        <input
                          type="radio"
                          name={`site-conflict-${conflict.field}`}
                          checked={sitePicks[conflict.field] === v.value}
                          onChange={() => setSitePicks((prev) => ({ ...prev, [conflict.field]: v.value }))}
                        />
                        {v.value}
                        <span className="text-white/40">
                          ({v.layer} · {v.sourceUrl.replace(/^https?:\/\//, '')})
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              {siteScan.services.length > 0 && (
                <p className="text-xs text-white/60">
                  Services read: <span className="text-white">{siteScan.services.join(' · ')}</span>
                </p>
              )}
              {siteScan.offers.length > 0 && (
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-white/40 mb-1">
                    Build the campaign around
                  </p>
                  <div className="space-y-1">
                    {siteScan.offers.map((offer, i) => (
                      <label key={offer.url + offer.name} className="flex items-center gap-2 text-xs text-white/80">
                        <input
                          type="radio"
                          name="site-offer"
                          checked={siteOfferId === `offer-${i}`}
                          onChange={() => setSiteOfferId(`offer-${i}`)}
                        />
                        {offer.name}
                        {offer.price ? ` — ${offer.price}` : ''}
                        {offer.date ? ` — ${offer.date}` : ''}
                      </label>
                    ))}
                    <label className="flex items-center gap-2 text-xs text-white/80">
                      <input
                        type="radio"
                        name="site-offer"
                        checked={siteOfferId === ''}
                        onChange={() => setSiteOfferId('')}
                      />
                      The business as a whole (no single offer)
                    </label>
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={handleConfirmSiteProfile}
                  className="min-h-[44px] px-4 rounded-lg bg-gold text-black text-xs font-black uppercase"
                >
                  Confirm profile
                </button>
                <button
                  onClick={() => setSiteScan(null)}
                  className="min-h-[44px] px-4 rounded-lg border border-white/15 bg-white/5 text-xs font-bold text-white/70"
                >
                  Discard scan
                </button>
              </div>
            </div>
          )}
          {siteProfile && (
            <div className="mt-3 space-y-3">
              <p className="text-xs text-white/70">
                Campaigns are grounded in{' '}
                <span className="text-white font-bold">{siteProfile.name?.value ?? siteProfile.url}</span>
                {siteProfile.phone?.value ? <> · {siteProfile.phone.value}</> : ''} — read from your website and
                confirmed by you.
              </p>
              {siteProfile.images.length > 0 && (
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-white/40 mb-2">
                    Use one of your website images as the artwork
                  </p>
                  <div className="flex gap-2 flex-wrap">
                    {siteProfile.images.map((img) => (
                      <button
                        key={img.url}
                        onClick={() => void handleSiteImage(img.url)}
                        disabled={siteImageBusy}
                        className="rounded-lg border border-white/15 overflow-hidden hover:border-gold/60 disabled:opacity-50"
                      >
                        <img src={img.url} alt={img.alt || 'Website image'} className="w-16 h-16 object-cover" />
                      </button>
                    ))}
                  </div>
                  {siteImageBusy && <p className="text-[11px] text-white/40 mt-2">Loading that image…</p>}
                </div>
              )}
              <button
                onClick={handleForgetSite}
                className="text-[11px] font-bold text-white/40 underline underline-offset-2"
              >
                Forget this website profile
              </button>
            </div>
          )}
          {siteNote && <p className="text-[11px] text-white/40 mt-3">{siteNote}</p>}
        </div>

        <div className="mt-4 bg-white/5 border border-white/10 rounded-xl p-4">
          <label className="block text-xs font-bold uppercase tracking-wide text-white/60 mb-2">
            Headline Poster
          </label>
          <p className="text-xs text-white/50">
            Turn your own photo into the poster format — one heavy headline, one sub-line, locked premium
            type over your picture. Download it as a still, open it in the editor, or turn it into an
            animated promo. The photo is yours — the app adds no photography of its own.
          </p>
          <button
            onClick={() => setPosterOpen((v) => !v)}
            className="mt-3 min-h-[44px] px-4 rounded-lg bg-gold text-black text-xs font-black uppercase"
          >
            {posterOpen ? 'Close the poster builder' : 'Make a headline poster'}
          </button>
          {posterOpen && (
            <div className="mt-4 space-y-3">
              <input
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handlePosterFile(f);
                  e.target.value = '';
                }}
                className="block w-full text-sm text-white/70 file:mr-3 file:px-4 file:py-2 file:rounded-lg file:border file:border-gold/60 file:bg-gold/15 file:text-gold file:text-xs file:font-bold file:uppercase"
              />
              {posterPicked && (
                <div className="flex gap-4 items-start">
                  <img src={posterPicked.previewUrl} alt="Poster photo" className="w-20 rounded-lg border border-white/10" />
                  {posterAnalysis && (
                    <div className="text-xs text-white/60 space-y-1">
                      <p>
                        {posterAnalysis.width} × {posterAnalysis.height}px — layout auto-pick reads the calm
                        zones of your photo; override it below any time.
                      </p>
                    </div>
                  )}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-bold uppercase tracking-wide text-white/40">What's it for?</span>
                {(
                  [
                    ['event', 'Party / Event'],
                    ['product', 'Product'],
                    ['business', 'Business'],
                    ['look', 'Just the look'],
                  ] as Array<[NoTextPurpose, string]>
                ).map(([id, label]) => (
                  <button key={id} type="button" onClick={() => handlePosterPurpose(id)} className={chipCls(posterPurpose === id)}>
                    {label}
                  </button>
                ))}
              </div>
              {(
                [
                  ['headline', 'Headline — e.g. ON ISLAND TIME.'],
                  ['sub', 'Sub line — one quiet scene line'],
                ] as Array<['headline' | 'sub', string]>
              ).map(([field, placeholder]) => (
                <div key={field}>
                  <div className="relative">
                    <input
                      className={`${inputCls} pr-10`}
                      placeholder={placeholder}
                      value={posterTexts[field]}
                      onChange={(e) => {
                        posterTouchedRef.current.add(field);
                        setPosterTexts((t) => ({ ...t, [field]: e.target.value }));
                      }}
                    />
                    <button
                      type="button"
                      aria-label={`Another suggestion for the poster ${field}`}
                      title="Another suggestion"
                      onClick={() => cyclePosterField(field)}
                      className="absolute right-1 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-md text-white/40 hover:text-gold hover:bg-white/10"
                    >
                      <RefreshCw size={14} />
                    </button>
                  </div>
                </div>
              ))}
              <p className="text-[11px] text-white/40">Suggestions from the poster bank — your words always win. Type anything and it stays yours.</p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wide text-white/60 mr-1">Layout</span>
                <button type="button" onClick={() => setPosterLayoutChoice('auto')} className={chipCls(posterLayoutChoice === 'auto')}>
                  Auto
                </button>
                <button type="button" onClick={() => setPosterLayoutChoice('B')} className={chipCls(posterLayoutChoice === 'B')}>
                  Bottom band
                </button>
                <button type="button" onClick={() => setPosterLayoutChoice('T')} className={chipCls(posterLayoutChoice === 'T')}>
                  Top overlay
                </button>
                {posterAnalysis && (
                  <span className="text-[11px] text-white/40">
                    {posterLayoutChoice === 'auto'
                      ? `Auto picked: ${pickPosterLayout(posterAnalysis) === 'B' ? 'Bottom band' : 'Top overlay'}`
                      : posterLayoutChoice === 'B'
                        ? 'Bottom band — text in the lower third over a dark scrim'
                        : 'Top overlay — text over the calm top zone'}
                  </span>
                )}
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-bold uppercase tracking-wide text-white/40">Headline type style</span>
                <select
                  aria-label="Poster headline font"
                  value={posterFontFamily}
                  onChange={(e) => setPosterFontFamily(e.target.value)}
                  className="w-full min-h-11 bg-white/5 border border-white/10 rounded-lg px-2.5 py-2 text-sm text-white focus:outline-none focus:border-gold/60"
                  style={{ fontFamily: posterFontFamily }}
                >
                  {FONT_OPTIONS.map((f) => (
                    <option key={f.family} value={f.family}>
                      {f.label} — {f.vibe}
                    </option>
                  ))}
                </select>
              </label>
              <button
                onClick={() => void handleBuildPoster()}
                disabled={!posterPicked || !!posterStatus || !currentUser || !posterTexts.headline.trim()}
                className="w-full min-h-[48px] py-3 rounded-lg bg-gold hover:bg-gold-bright disabled:opacity-50 text-black text-sm font-black uppercase tracking-wide"
              >
                {posterStatus || (posterTexts.headline.trim() ? 'Build poster' : 'Add a headline to build')}
              </button>
              {posterError && <p className="text-xs text-red-400">{posterError}</p>}
              {posterNote && <p className="text-[11px] text-white/50">{posterNote}</p>}
              {posterProject && posterPreviewUrl && (
                <div className="space-y-3 pt-1">
                  <img
                    src={posterPreviewUrl}
                    alt="Your headline poster"
                    className="mx-auto w-full max-w-[240px] rounded-md border border-white/10"
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => void handleDownloadPoster('9:16')}
                      disabled={!!posterStatus}
                      className="min-h-[40px] px-3 rounded-lg bg-gold text-black text-[11px] font-black uppercase disabled:opacity-50"
                    >
                      Download poster (PNG)
                    </button>
                    {(['4:5', '1:1'] as PosterFormatId[]).map((formatId) => (
                      <button
                        key={formatId}
                        onClick={() => void handleDownloadPoster(formatId)}
                        disabled={!!posterStatus}
                        className="min-h-[40px] px-3 rounded-lg border border-white/20 bg-white/5 hover:bg-white/10 text-[11px] font-bold text-white/80 disabled:opacity-50"
                      >
                        Download {formatId}
                      </button>
                    ))}
                    <button
                      onClick={() => onOpenProject(posterProject.id)}
                      className="min-h-[40px] px-3 rounded-lg border border-white/20 bg-white/5 hover:bg-white/10 text-[11px] font-bold text-white/80"
                    >
                      Open in editor
                    </button>
                    <button
                      onClick={() => void handleAnimatePoster()}
                      disabled={!!posterStatus}
                      className="min-h-[40px] px-3 rounded-lg border border-gold bg-gold/15 hover:bg-gold/25 text-gold text-[11px] font-black uppercase disabled:opacity-50"
                    >
                      Animate this poster
                    </button>
                  </div>
                  <p className="text-[10px] text-white/35">
                    The 4:5 and 1:1 posters are re-laid out for their canvas — never a crop of the 9:16.
                    Animating loads the finished poster as artwork above, ready to pick a recipe.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {phase !== 'pick' && (
          <>
            <div className="mt-4 bg-white/5 border border-white/10 rounded-xl p-4 space-y-3">
              <label className="block text-xs font-bold uppercase tracking-wide text-white/60">
                2 · Your words — auto-filled from your artwork, edit anything
              </label>
              {artNoWords && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-2.5 py-2">
                  <span className="text-[11px] font-bold text-white/70">No words in this image — what's it for?</span>
                  {(
                    [
                      ['event', 'Party / Event'],
                      ['product', 'Product'],
                      ['business', 'Business'],
                      ['look', 'Just the look'],
                    ] as Array<[NoTextPurpose, string]>
                  ).map(([id, label]) => (
                    <button key={id} type="button" onClick={() => applyPurpose(id)} className={chipCls(artPurpose === id)}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
              {needsHeadlineAsk && !texts.hook1 && (
                <div className="rounded-lg border border-gold/40 bg-gold/10 p-3 space-y-2">
                  <p className="text-xs text-gold font-bold">Studio couldn't read this artwork's headline.</p>
                  <p className="text-[11px] text-white/60">Type it exactly as printed — everything else still builds from the read.</p>
                  <div className="flex gap-2">
                    <input
                      className={inputCls}
                      placeholder="The headline, as printed"
                      value={askValue}
                      onChange={(e) => setAskValue(e.target.value)}
                    />
                    <button
                      type="button"
                      disabled={!askValue.trim()}
                      onClick={() => {
                        assignReadLine('hook', askValue.trim().toUpperCase());
                        setFieldSources((prev) => ({ ...prev, hook1: 'yours', hook2: 'yours' }));
                        setNeedsHeadlineAsk(false);
                        persistFixesSoon();
                      }}
                      className="shrink-0 px-3 rounded-lg bg-gold text-black text-xs font-bold disabled:opacity-50"
                    >
                      Use it
                    </button>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {(
                  [
                    ['hook1', 'Hook line 1 — e.g. ONE NIGHT.'],
                    ['hook2', 'Hook line 2 — e.g. TWO SOUNDS.'],
                    ['cta', 'Call to action — e.g. TICKETS: LINK IN BIO'],
                    ['sub', 'Sub line — date • venue • city'],
                  ] as Array<[SuggestionField, string]>
                ).map(([field, placeholder]) => (
                  <div key={field}>
                    <div className="relative">
                    <input id={`promo-field-${field}`} className={`${inputCls} pr-10`} placeholder={placeholder} value={texts[field] ?? ''}
                      onChange={(e) => {
                        touchedRef.current.add(field);
                        setFieldSources((prev) => ({ ...prev, [field]: 'yours' as const }));
                        setTexts((t) => ({ ...t, [field]: e.target.value }));
                        persistFixesSoon();
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
                    {(texts[field] ?? '').trim() && fieldSources[field] && (
                      <p className={`mt-1 text-[10px] font-bold uppercase tracking-wider ${(fieldSources[field] === 'art' || fieldSources[field] === 'site') ? 'text-gold/80' : 'text-white/35'}`}>
                        {fieldSources[field] === 'art'
                          ? 'From your artwork'
                          : fieldSources[field] === 'site'
                            ? 'From your website'
                            : fieldSources[field] === 'yours'
                              ? 'Your words'
                              : 'Suggested — tap ↻ for another'}
                      </p>
                    )}
                  </div>
                ))}
              </div>
              {(suggesting || autoNote) && (
                <p className="text-[11px] text-white/40">
                  {suggesting ? `Analyzing your artwork on this device${analyzePct !== null ? ` — ${analyzePct}%` : '…'}` : autoNote}
                </p>
              )}
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-bold uppercase tracking-wide text-white/40">Your name / brand, exactly as printed on your art</span>
                <input
                  className={inputCls}
                  placeholder="e.g. Rutenberg Realty — Studio fixes near-miss spellings to match this"
                  value={brandName}
                  onChange={(e) => {
                    setBrandName(e.target.value);
                    brandNameRef.current = e.target.value;
                  }}
                />
              </label>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  onClick={handleSaveKit}
                  className="min-h-[40px] px-3 rounded-lg border border-gold/40 bg-gold/10 hover:bg-gold/20 text-gold text-[11px] font-bold"
                >
                  Save CTA + sub + skin + brand name as my defaults
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
                  <p className="text-[11px] font-bold uppercase tracking-wider text-white/50">What Studio read</p>
                  {readLines.map((line, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="flex-1 min-w-0 truncate text-xs text-white/85" title={line.text}>{line.text}</span>
                      {(['hook', 'sub', 'cta'] as const).map((target) => (
                        <button
                          key={target}
                          onClick={() => assignReadLine(target, line.text)}
                          className="shrink-0 min-h-11 px-2 rounded-md border border-white/15 bg-white/5 hover:bg-gold/20 hover:text-gold text-[10px] font-bold uppercase text-white/60"
                        >
                          {target}
                        </button>
                      ))}
                    </div>
                  ))}
                  <p className="text-[10px] text-white/35 pt-0.5">Tap Hook, Sub or CTA to place a line exactly where it belongs.</p>
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => setShowReadDetail((v) => !v)}
                      aria-expanded={showReadDetail}
                      className="min-h-11 inline-flex items-center gap-1.5 text-[11px] font-bold text-white/50 hover:text-gold"
                    >
                      Show what was read
                      <span aria-hidden="true">{showReadDetail ? '▾' : '▸'}</span>
                    </button>
                    {showReadDetail && (
                      <div className="mt-1 space-y-1 text-[11px] text-white/40">
                        {analysis && (
                          <p>
                            {analysis.width} × {analysis.height}px · {analysis.bands.length} {analysis.bands.length === 1 ? 'block' : 'blocks'} of text found
                          </p>
                        )}
                        {readLines.map((line, i) => (
                          <p key={i}>
                            <span className="text-white/60">{line.text}</span> — {line.confidence}% sure
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {corrections.length > 0 && (
                <div className="rounded-lg border border-gold/30 bg-gold/5 p-3 space-y-1">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-gold/90">Corrected to the true spelling</p>
                  {corrections.map((c, i) => (
                    <p key={i} className="text-[11px] text-white/60">
                      <span className="line-through decoration-white/30">{c.from}</span> → <span className="text-white font-bold">{c.to}</span>
                    </p>
                  ))}
                </div>
              )}
              {fixNote && <p className="text-[11px] text-gold/80">{fixNote}</p>}
              {picked[0] && ((texts.hook1 ?? '').trim() || (texts.sub ?? '').trim() || (texts.cta ?? '').trim()) && (
                <div className="rounded-lg border border-white/10 bg-black/30 p-3 space-y-2">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-white/50">Proof — your words over your art</p>
                  <div className="relative mx-auto max-w-[240px]">
                    <img src={picked[0].previewUrl} alt="Artwork proof" className="w-full rounded-md border border-white/10" />
                    {(texts.hook1 ?? '').trim() && (
                      <button
                        type="button"
                        onClick={() => document.getElementById('promo-field-hook1')?.focus()}
                        className="absolute inset-x-1 top-[5%] text-center font-black uppercase leading-tight text-white text-sm px-1"
                        style={{ textShadow: '0 2px 10px rgba(0,0,0,.9), 0 0 3px rgba(0,0,0,.9)' }}
                      >
                        {texts.hook1}
                        {(texts.hook2 ?? '').trim() && <span className="block">{texts.hook2}</span>}
                      </button>
                    )}
                    {(texts.sub ?? '').trim() && (
                      <button
                        type="button"
                        onClick={() => document.getElementById('promo-field-sub')?.focus()}
                        className="absolute inset-x-1 top-[60%] text-center font-bold uppercase text-white/90 text-[10px] px-1"
                        style={{ textShadow: '0 1px 8px rgba(0,0,0,.95), 0 0 3px rgba(0,0,0,.9)' }}
                      >
                        {texts.sub}
                      </button>
                    )}
                    {(texts.cta ?? '').trim() && (
                      <button
                        type="button"
                        onClick={() => document.getElementById('promo-field-cta')?.focus()}
                        className="absolute inset-x-0 bottom-[4%] mx-auto w-fit max-w-[92%] rounded-full border border-gold/70 bg-black/60 px-2.5 py-1 text-center font-bold uppercase text-gold text-[10px]"
                      >
                        {texts.cta}
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] text-white/35">One glance before you build — tap any line to edit it.</p>
                </div>
              )}
            </div>

            <div className="mt-4 bg-white/5 border border-white/10 rounded-xl p-4">
              <label className="block text-xs font-bold uppercase tracking-wide text-white/60 mb-2">
                3 · Build
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
                <span className="text-xs font-bold uppercase tracking-wide text-white/60 mr-1">Music</span>
                <button onClick={() => ownTrackInputRef.current?.click()} className={chipCls(musicOn && !!ownTrack)}>
                  {ownTrack ? `Your track: ${ownTrack.name}` : 'Add your own track'}
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
                  <span className="text-[11px] text-white/40">Your promo is silent until you add a track — the app adds no audio of its own.</span>
                )}
                {musicOn && ownTrack && (
                  <button onClick={() => setHookTrim((v) => !v)} className={chipCls(hookTrim && musicStart === null)}>
                    {hookTrim ? 'Starts at the hook ✓' : 'Start at the hook'}
                  </button>
                )}
              </div>
              {musicOn && ownTrack && (
                <p className="text-[11px] text-white/40 mt-1.5">
                  Your track is cropped to the promo's length automatically
                  {ownTrackSeconds ? ` (${ownTrackSeconds.toFixed(0)}s track → ${duration}s promo)` : ''} — pick the part you like below.
                </p>
              )}
              {musicOn && ownTrack && ownTrackSeconds !== null && ownTrackSeconds > duration && (
                <div className="mt-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-white/40">Pick the part</span>
                    <button type="button" onClick={() => setMusicStart(null)} className={chipCls(musicStart === null)}>
                      {hookTrim ? 'Auto — the hook' : 'Auto — the beginning'}
                    </button>
                    {musicStart !== null && (
                      <span className="text-[11px] text-white/40">Drag the gold window — or tap Auto to go back.</span>
                    )}
                  </div>
                  {/* R26 (WS-A3): the shared song-part picker. Until the
                      user drags, it shows the EFFECTIVE start (the hook
                      when hook-trim is on, else 0) — musicStart stays
                      null, so the auto semantic is untouched. Dragging
                      writes plain start seconds into musicStart, the
                      same value applyMusicStart already honours. */}
                  <SongPartPicker
                    durationSeconds={ownTrackSeconds}
                    windowSeconds={duration}
                    value={effectiveStart(musicStart, hookTrim ? (ownTrackHook ?? 0) : 0)}
                    hookSeconds={ownTrackHook}
                    peaks={ownTrackPeaks}
                    modeLabel={musicStart === null ? (hookTrim ? 'Auto — the hook' : 'Auto — from the beginning') : 'Your pick'}
                    onChange={(start) => setMusicStart(promoStartForWindow(start, duration, ownTrackSeconds))}
                  />
                </div>
              )}
              <div className="mt-4 border-t border-white/10 pt-3">
                <button
                  type="button"
                  onClick={() => setFineTuneOpen((v) => !v)}
                  aria-expanded={fineTuneOpen}
                  className="flex w-full min-h-11 items-center justify-between text-left"
                >
                  <span className="text-xs font-bold uppercase tracking-wide text-white/60">Fine-tune (optional)</span>
                  <span aria-hidden="true" className="text-white/40">{fineTuneOpen ? '▾' : '▸'}</span>
                </button>
                {fineTuneOpen && (
                  <div className="space-y-3 pt-2">
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
                  <button key={id} onClick={() => { skinTouchedRef.current = true; setSkin(id); }} className={chipCls(skin === id)}>
                    {PROMO_SKINS[id].label}
                  </button>
                ))}
              </div>
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
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-bold uppercase tracking-wide text-white/40">Caption animation</span>
                <button type="button" onClick={() => setCaptionMode('words')} className={chipCls(captionMode === 'words')}>
                  Viral words — pop on the beat
                </button>
                <button type="button" onClick={() => setCaptionMode('lines')} className={chipCls(captionMode === 'lines')}>
                  Kinetic lines
                </button>
              </div>
              {captionMode === 'words' && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-white/40">Caption size</span>
                  {(Object.keys(CAPTION_SIZE_TIERS) as CaptionSizeTier[]).map((tier) => (
                    <button key={tier} type="button" onClick={() => setCaptionSize(tier)} className={chipCls(captionSize === tier)}>
                      {tier === 'S' ? 'S — subtle' : tier === 'M' ? 'M — standard' : tier === 'L' ? 'L — big' : 'XL — maximum'}
                    </button>
                  ))}
                </div>
              )}
                  </div>
                )}
              </div>
            </div>

            <div className="hidden lg:flex mt-6">
              <button
                onClick={() => void handleBuild()}
                disabled={buildDisabled}
                className="w-full py-3 min-h-[48px] bg-gold hover:bg-gold-bright disabled:opacity-50 rounded-lg text-black text-sm font-black uppercase tracking-wide"
              >
                {buildLabel}
              </button>
            </div>
            <p className="text-xs text-white/40 mt-3 text-center">
              Opens in the editor with the beat already on — fine-tune, then export. Free accounts carry the RiddimRoom mark.
            </p>
            {planPreview && (
              <div className="mt-4 bg-white/5 border border-gold/30 rounded-xl p-4 space-y-3">
                <label className="block text-xs font-bold uppercase tracking-wide text-white/60">
                  Want the full set? Build the campaign
                </label>
                <p className="text-xs text-white/55">
                  One upload, <span className="text-white font-bold">{planPreview.pieces.length} finished promos</span> —{' '}
                  {planPreview.seriesKind === 'countdown'
                    ? 'a master, two alternate hooks, a 7-day / 48-hour / day-of countdown ladder, and square + wide cuts.'
                    : 'a master, two alternate hooks, a newsflash / story / offer ladder, and square + wide cuts.'}{' '}
                  Every piece is saved as its own project, rendered here, and handed to you with its post already written.
                </p>
                <ul className="space-y-1">
                  {planPreview.pieces.map((pc) => (
                    <li key={pc.id} className="text-[11px]">
                      <div className="flex items-center gap-2">
                        <span className="text-white/85 font-bold">{pc.label}</span>
                        <span className="px-1.5 py-0.5 rounded border border-white/15 text-white/45">{pc.formatId}</span>
                        <span className="text-white/40">{pc.scheduleLabel}</span>
                      </div>
                      {(pc.texts.hook1 || pc.texts.hook2) && (
                        <p className="text-white/35 truncate pl-0.5">
                          “{[pc.texts.hook1, pc.texts.hook2].filter(Boolean).join(' ')}”
                          {pc.texts.sub ? ` — ${pc.texts.sub}` : ''}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
                {currentUser && tier !== 'lifetime' && (
                  <p className="text-[11px] text-white/40">
                    Free plan: {exportsRemainingToday(currentUser.uid, tier)} exports left today — the campaign renders what
                    today's limit allows and saves every project, so nothing is lost.
                  </p>
                )}
                {campaignRunning ? (
                  <div className="flex items-center gap-2">
                    <p className="flex-1 text-xs text-gold font-bold">
                      {campaignStatus}
                      {campaignPct > 0 ? ` — ${campaignPct}%` : ''}
                    </p>
                    <button
                      onClick={() => campaignAbortRef.current?.abort()}
                      className="min-h-[40px] px-3 rounded-lg border border-white/20 bg-white/5 hover:bg-white/10 text-[11px] font-bold text-white/70"
                    >
                      Stop
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => void handleCampaign()}
                    disabled={phase === 'building' || !!fileProblem}
                    className="w-full min-h-[48px] py-3 rounded-lg border border-gold bg-gold/15 hover:bg-gold/25 disabled:opacity-50 text-gold text-sm font-black uppercase tracking-wide"
                  >
                    Build the full campaign ({planPreview.pieces.length} promos)
                  </button>
                )}
                {campaignNote && <p className="text-[11px] text-white/50">{campaignNote}</p>}
                <div className="rounded-lg border border-white/10 bg-black/30 p-3 space-y-1.5">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-gold">Posting tip — ride the trending sound</p>
                  {buildSoundGuide().map((step, i) => (
                    <p key={i} className="text-[11px] text-white/55">
                      <span className="text-white/85 font-bold">{i + 1}.</span> {step}
                    </p>
                  ))}
                </div>
                {campaignResults.length > 0 && (
                  <div className="space-y-2 pt-1">
                    {campaignReceipt && (
                      <div
                        className={`rounded-lg border p-3 ${
                          campaignReceipt.clean ? 'border-gold/40 bg-gold/5' : 'border-amber-300/40 bg-amber-300/5'
                        }`}
                      >
                        <p
                          className={`text-xs font-black uppercase tracking-wide ${
                            campaignReceipt.clean ? 'text-gold' : 'text-amber-200'
                          }`}
                        >
                          {campaignReceipt.summaryLine}
                        </p>
                        {campaignReceipt.clean ? (
                          <p className="text-[11px] text-white/50 mt-1">
                            Every price, date and number in this set traces to the website profile you confirmed.
                          </p>
                        ) : (
                          <ul className="mt-1 space-y-0.5">
                            {campaignReceipt.flags.slice(0, 6).map((f, i) => (
                              <li key={i} className="text-[11px] text-amber-100/80">
                                {f.label}: the line “{f.context}” — “{f.token}” couldn't be checked
                                word-for-word against your confirmed website profile — please check it before posting.
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                    {campaignResults.map((r) => {
                      const expanded = expandedPieces.has(r.piece.id);
                      return (
                      <div key={r.piece.id} className="rounded-lg border border-white/10 bg-black/30 p-3 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-black uppercase tracking-wide text-white">{r.piece.label}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded border border-white/15 text-white/45">{r.piece.formatId}</span>
                          <span className="text-[10px] text-white/40">{r.piece.scheduleLabel}</span>
                          <span
                            className={`ml-auto text-[10px] font-bold uppercase ${
                              r.status === 'done' ? 'text-gold' : r.status === 'failed' ? 'text-red-400' : 'text-white/50'
                            }`}
                          >
                            {r.status === 'done' ? 'Rendered' : r.status === 'failed' ? 'Render failed here' : 'Project saved'}
                          </span>
                        </div>
                        {r.error && <p className="text-[11px] text-red-300/80">{r.error}</p>}
                        <div className="flex flex-wrap gap-2">
                          {r.status === 'done' && r.url && (
                            <>
                              <a
                                href={r.url}
                                download={r.fileName}
                                className="min-h-[36px] inline-flex items-center px-3 rounded-lg bg-gold text-black text-[11px] font-black uppercase"
                              >
                                Save MP4
                              </a>
                              <button
                                onClick={() => void shareCampaignPiece(r)}
                                className="min-h-[36px] px-3 rounded-lg border border-white/20 bg-white/5 hover:bg-white/10 text-[11px] font-bold text-white/80"
                              >
                                Share
                              </button>
                            </>
                          )}
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() =>
                              setExpandedPieces((prev) => {
                                const next = new Set(prev);
                                if (next.has(r.piece.id)) next.delete(r.piece.id);
                                else next.add(r.piece.id);
                                return next;
                              })
                            }
                            className="min-h-[36px] px-3 rounded-lg border border-white/20 bg-white/5 hover:bg-white/10 text-[11px] font-bold text-white/80"
                          >
                            Details <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                          </button>
                        </div>
                        {expanded && (
                          <div className="space-y-2">
                            <div className="flex flex-wrap gap-2">
                              <button
                                onClick={() => void copyCampaignPost(r)}
                                className="min-h-[36px] px-3 rounded-lg border border-white/20 bg-white/5 hover:bg-white/10 text-[11px] font-bold text-white/80"
                              >
                                {copiedPieceId === r.piece.id ? 'Post copied ✓' : 'Copy its post'}
                              </button>
                              <button
                                onClick={() => onOpenProject(r.projectId)}
                                className="min-h-[36px] px-3 rounded-lg border border-white/20 bg-white/5 hover:bg-white/10 text-[11px] font-bold text-white/80"
                              >
                                Open in editor
                              </button>
                            </div>
                            {r.musicItemId && r.musicFittedSeconds !== undefined && (
                              <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 space-y-1.5">
                                <p className="text-[10px] font-bold uppercase tracking-wider text-white/40">
                                  Music fade — saved to this piece's project
                                </p>
                                {(
                                  [
                                    ['fadeIn', 'Fade in', r.fadeIn ?? 0],
                                    ['fadeOut', 'Fade out', r.fadeOut ?? 0],
                                  ] as Array<['fadeIn' | 'fadeOut', string, number]>
                                ).map(([field, label, val]) => (
                                  <label key={field} className="flex items-center gap-2 text-[11px] text-white/60">
                                    <span className="w-14 shrink-0">{label}</span>
                                    <input
                                      type="range"
                                      min={0}
                                      max={Math.min(MAX_FADE_SECONDS, r.musicFittedSeconds ?? 0)}
                                      step={0.1}
                                      value={val}
                                      onChange={(e) => handleResultFade(r, field, Number(e.target.value))}
                                      className="flex-1 accent-[#FFD100]"
                                      aria-label={`${r.piece.label} music ${label.toLowerCase()}, seconds`}
                                    />
                                    <span className="w-9 shrink-0 text-right text-white/80">{val.toFixed(1)}s</span>
                                  </label>
                                ))}
                                {r.status === 'done' && (
                                  <p className="text-[10px] text-white/35">
                                    This piece's MP4 above is already rendered — the new fades apply when you open its project and export again.
                                  </p>
                                )}
                              </div>
                            )}
                            {r.posts[0] && (
                              <p className="text-[11px] text-white/45 whitespace-pre-line leading-relaxed">{r.posts[0].text}</p>
                            )}
                          </div>
                        )}
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

          </>
        )}
        {/* R34 (UX-32): the sticky bar renders from first load, not
            only after artwork is picked — in the pick phase it sits
            disabled with the reason on the button ("Add artwork to
            build"), and a recipe file problem becomes the label
            itself, so the reason appears once, prominently. */}
        <div
          className="lg:hidden fixed bottom-0 inset-x-0 z-40 border-t border-white/10 bg-[#0a0a0a]/90 backdrop-blur"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <div className="px-4 py-3">
            <button
              onClick={() => void handleBuild()}
              disabled={buildDisabled}
              className="w-full min-h-[48px] py-3 rounded-lg bg-gold hover:bg-gold-bright disabled:opacity-50 text-black text-sm font-black uppercase tracking-wide"
            >
              {buildLabel}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
