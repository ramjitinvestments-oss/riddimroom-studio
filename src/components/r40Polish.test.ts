/**
 * R40 Phase 4b — the polish batch, pinned at source level where the
 * surface cannot be mounted under vitest (the same pattern as
 * cameraSmoothness.test.ts and r40Trust.test.ts). Behavioural halves
 * live in the lib tests (pipRequests, reelPreview, campaignPrecheck,
 * projects/library, producer, copyBlocklist).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('R40 P-45 — one word per thing', () => {
  it('the timeline clip-cut button is "Cut at Playhead"; "Split 50/50" keeps its name', () => {
    const timeline = read('components/Editor/TimelinePanel.tsx');
    expect(timeline).toContain('Cut at Playhead');
    expect(timeline).not.toContain('Split at Playhead');
  });

  it('"Add both" survives nowhere in the source tree surfaces checked here', () => {
    for (const rel of [
      'components/Editor/CameraCapture.tsx',
      'components/Editor/MediaImportPanel.tsx',
      'lib/timeline/insert.ts',
    ]) {
      expect(read(rel)).not.toContain('Add both');
    }
  });
});

describe('R40 P-46 — undo-toast coverage', () => {
  it('every delete path dispatches the one "Deleted" message', () => {
    const shell = read('components/Editor/EditorShell.tsx');
    const inspector = read('components/Editor/ItemInspector.tsx');
    // Keyboard clip delete (EditorShell) + inspector item delete +
    // caption-word delete (ItemInspector) — three dispatch sites, one
    // message; the old per-path strings are gone.
    expect(shell).toContain("detail: { message: 'Deleted' }");
    expect(shell).not.toContain('Clip deleted');
    expect(inspector).not.toContain('Item deleted');
    const wordDelete = inspector.slice(inspector.indexOf('const deleteWord'));
    expect(wordDelete.slice(0, 900)).toContain("detail: { message: 'Deleted' }");
    expect(wordDelete.slice(0, 900)).toContain('rr:undo-toast');
  });
});

describe('R40 P-37 — campaign pre-check wiring', () => {
  it('PromoPage pre-checks all pieces and skips refused ones in the render loop', () => {
    const promo = read('components/PromoPage.tsx');
    expect(promo).toContain('campaignGatePrecheck');
    expect(promo).toContain('if (precheck.refused[index]) continue;');
    expect(promo).toContain('precheck.note');
  });

  it('P-49e: campaign notes name real places — no "saved above", no "written under it"', () => {
    const promo = read('components/PromoPage.tsx');
    expect(promo).not.toContain('saved above');
    expect(promo).not.toContain('written under it');
    expect(promo).toContain('your projects list');
    expect(promo).toContain('results below');
  });
});

describe('R40 P-47 — poster flow', () => {
  const promo = read('components/PromoPage.tsx');

  it('purpose chips come before the poster photo picker', () => {
    const posterStart = promo.indexOf('Headline Poster');
    const chipsIdx = promo.indexOf("What's it for?", posterStart);
    const pickerIdx = promo.indexOf('void handlePosterFile(f)', posterStart);
    expect(chipsIdx).toBeGreaterThan(-1);
    expect(pickerIdx).toBeGreaterThan(chipsIdx);
  });

  it('poster fields keep persistent labels and downloads name their file', () => {
    expect(promo).toContain("{field === 'headline' ? 'Headline' : 'Sub line'}");
    expect(promo).toContain('Download poster (PNG)');
    expect(promo).toContain('Download {formatId} (PNG)');
    expect(promo).not.toContain('Download {formatId}\n');
  });

  it('picking a photo fills fields only when a purpose was already chosen', () => {
    expect(promo).toContain('if (posterPurpose) applyPosterSuggestion(next, a, posterPurpose);');
  });
});

describe('R40 P-48 — loading states name what is loading', () => {
  it('Dashboard header, ProtectedRoute, PreviewPane and RouteLoading', () => {
    expect(read('components/Dashboard.tsx')).toContain('Checking plan…');
    expect(read('components/ProtectedRoute.tsx')).toContain('Loading RiddimRoom Studio…');
    expect(read('components/Editor/PreviewPane.tsx')).toContain('Loading your video…');
    const app = read('App.tsx');
    const routeLoading = app.slice(app.indexOf('function RouteLoading'), app.indexOf('function RouteLoading') + 700);
    expect(routeLoading).toContain('animate-spin');
    expect(routeLoading).toContain('Loading…');
  });
});

describe('R40 P-49 — copy residue', () => {
  it('one password message, single-sourced', () => {
    const auth = read('context/AuthContext.tsx');
    expect(auth).toContain("export const PASSWORD_RULE_MESSAGE = 'Password must be at least 6 characters.'");
    expect(auth).toContain('return PASSWORD_RULE_MESSAGE;');
    expect(auth).not.toContain('Password should be');
    const login = read('components/LoginPage.tsx');
    expect(login).toContain('PASSWORD_RULE_MESSAGE');
    expect(login).not.toContain('Password must be at least 6 characters.');
  });

  it('ReframePicker says "Loading photo…"; the fps select keeps its visible "Frame rate" label', () => {
    expect(read('components/Editor/ReframePicker.tsx')).toContain('Loading photo…');
    expect(read('components/Editor/ReframePicker.tsx')).not.toContain('Loading still…');
    const exportPanel = read('components/Editor/ExportPanel.tsx');
    expect(exportPanel).toContain('>Frame rate</span>');
    expect(exportPanel).toContain('aria-label="Export frame rate"');
  });

  it('the ease-check survey sits below the Producer\'s report', () => {
    const exportPanel = read('components/Editor/ExportPanel.tsx');
    expect(exportPanel.indexOf('Quick check — 10 seconds')).toBeGreaterThan(exportPanel.indexOf("Producer's report"));
  });

  it('the promo build shows an indeterminate bar while building — no invented percentage', () => {
    const promo = read('components/PromoPage.tsx');
    expect(promo).toContain('role="progressbar"');
    expect(promo).toContain('aria-label="Building your promo"');
  });
});

describe('R40 P-50 — visual residues', () => {
  it('ItemInspector primaries are gold, BackgroundRemovalButton selected state is gold', () => {
    const inspector = read('components/Editor/ItemInspector.tsx');
    expect(inspector).not.toContain('bg-indigo-600');
    expect(inspector).toContain('bg-gold hover:bg-gold-bright text-black');
    const bg = read('components/Editor/BackgroundRemovalButton.tsx');
    expect(bg).not.toContain('purple');
    expect(bg).toContain('bg-gold/25 text-gold');
  });

  it('timeline type coding is the restrained gold/white/neutral set', () => {
    const timeline = read('components/Editor/TimelinePanel.tsx');
    const colors = timeline.slice(timeline.indexOf('const TRACK_COLORS'), timeline.indexOf('const TRACK_COLORS') + 500);
    expect(colors).toContain("video: 'bg-gold/70'");
    expect(colors).not.toContain('bg-blue-500');
    expect(colors).not.toContain('bg-purple-500');
    expect(colors).not.toContain('bg-pink-500');
    expect(colors).not.toContain('bg-emerald-500');
  });

  it('no reel-card or timeline-label type below 10px remains in the checked surfaces', () => {
    expect(read('components/Editor/TemplatesPanel.tsx')).not.toContain('text-[9px]');
    expect(read('components/Editor/TemplatesPanel.tsx')).not.toContain('text-[8.5px]');
    expect(read('components/Editor/TimelinePanel.tsx')).not.toContain('text-[9px]');
  });

  it('the templates empty filter state offers a way out, and motion tokens exist + drive the reel fade', () => {
    const templates = read('components/Editor/TemplatesPanel.tsx');
    expect(templates).toContain('Clear the filter');
    expect(templates).toContain("selectChip('all')");
    const css = read('index.css');
    expect(css).toContain('--motion-fast: 150ms');
    expect(css).toContain('--motion-standard: 300ms');
    expect(css).toContain('--motion-slow: 500ms');
    expect(templates).toContain('opacity var(--motion-slow, 500ms) ease');
  });
});

describe('R40 P-52 — phone guidance parity', () => {
  it('the step guidance line and "How it works" are not hidden on phones; the empty timeline names real buttons', () => {
    const shell = read('components/Editor/EditorShell.tsx');
    expect(shell).not.toContain('ml-auto hidden sm:inline');
    expect(shell).not.toContain('hidden lg:block bg-white/5');
    expect(read('components/Editor/TimelinePanel.tsx')).toContain('Tap Add Video / Image to add your first clip');
    expect(read('components/Editor/TimelinePanel.tsx')).not.toContain('Tap Upload to add your first clip');
  });
});

describe('R40 P-53 — Dashboard search + rename wiring', () => {
  it('search filters the rendered list and rename goes through renameProject', () => {
    const dash = read('components/Dashboard.tsx');
    expect(dash).toContain('Search projects');
    expect(dash).toContain('filterProjectsByName(projects, searchQuery)');
    expect(dash).toContain('visibleProjects.map');
    expect(dash).toContain('renameProject(renameTarget.id, currentUser.uid, name)');
    expect(dash).toContain('Rename project');
    expect(dash).toContain('Save name');
  });
});

describe('R40 P-31 — EditorShell pair offer replaces the singles, never duplicates', () => {
  it('the pair handler removes the two assets\' landed items in the same mutate as placeImportPair', () => {
    const shell = read('components/Editor/EditorShell.tsx');
    const handler = shell.slice(shell.indexOf('const handlePairAssetUploaded'), shell.indexOf('const handlePairAssetUploaded') + 1600);
    expect(handler).toContain('removeItem(next, item.id)');
    expect(handler).toContain('placeImportPair(next, assetA, assetB');
    expect(handler).toContain('item.mediaAssetId === assetA.id || item.mediaAssetId === assetB.id');
  });
});
