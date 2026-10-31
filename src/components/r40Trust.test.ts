import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * R40 Phase 1 — trust surface + quick wins (standing source audit).
 * Each assertion names the finding it pins, so a future restyle
 * cannot silently bring back a dead wall, a raw error, a nonsense
 * count, or a missing door.
 */
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SRC_DIR, '..', '..');

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

describe('R40 P-03 — one shared support link on every stuck surface', () => {
  it('the address lives in exactly one component', () => {
    const support = read('src/components/SupportLink.tsx');
    expect(support).toContain('riddimroom.com@gmail.com');
    expect(support).toContain('Questions? Email us');
    expect(support).toContain('mailto:');
  });

  it.each([
    'src/components/LoginPage.tsx',
    'src/components/PendingScreen.tsx',
    'src/components/Dashboard.tsx',
    'src/components/Editor/LicensingPanel.tsx',
  ])('%s renders the shared SupportLink', (rel) => {
    expect(read(rel)).toContain('SupportLink');
  });
});

describe('R40 P-04 — Privacy and Terms are public pages with the real data story', () => {
  it('App routes /privacy and /terms before the sign-in redirect', () => {
    const app = read('src/App.tsx');
    expect(app).toContain("currentPath === '/privacy'");
    expect(app).toContain("currentPath === '/terms'");
    expect(app).toContain('LegalPage');
  });

  it('the copy covers sign-in, storage, on-device editing, captions on request, opt-in, and failure counts', () => {
    const legal = read('src/lib/legalCopy.ts');
    expect(legal).toContain('Firebase');
    expect(legal).toContain('on your phone or computer');
    expect(legal).toContain('when you tap to transcribe');
    expect(legal).toContain('Counts only');
    expect(legal).toContain('never sell your personal information');
    expect(legal).toContain('switched on by the owner');
  });

  it('login and dashboard footers link both pages', () => {
    for (const rel of ['src/components/LoginPage.tsx', 'src/components/Dashboard.tsx']) {
      const src = read(rel);
      expect(src).toContain('Privacy');
      expect(src).toContain('Terms');
      expect(src).toContain('onOpenLegal');
    }
  });
});

describe('R40 P-20/P-26/P-33 — the plan surface tells the truth', () => {
  const panel = read('src/components/Editor/LicensingPanel.tsx');

  it('uses the shared remaining label and never formats a raw count', () => {
    expect(panel).toContain('exportsRemainingLabel');
    expect(panel).not.toContain('exportsRemainingToday');
    expect(panel).not.toContain('Infinity');
  });

  it('the Lifetime action is a gold email button under the owner-granted model', () => {
    expect(panel).toContain('bg-gold');
    expect(panel).toContain('Email us about Lifetime');
    expect(panel).toContain('Lifetime is switched on by the owner for now');
    expect(panel).not.toContain('Starting checkout');
    expect(panel).not.toContain("Checkout isn't available");
    expect(panel).not.toContain('handleCheckout');
  });

  it('the watermark toggle names the words actually drawn', () => {
    expect(panel).toContain('Show the');
    expect(panel).toContain('Made with RiddimRoom Studio');
    expect(panel).toContain('watermark');
  });

  it('ExportPanel and the Step-3 summary name the setting, not the plan', () => {
    const exportPanel = read('src/components/Editor/ExportPanel.tsx');
    expect(exportPanel).toContain('Watermark: on');
    expect(exportPanel).not.toContain('Watermark on (free)');
    const shell = read('src/components/Editor/EditorShell.tsx');
    expect(shell).toContain('Watermark:');
    expect(shell).not.toContain('On (free)');
    expect(shell).not.toContain('Off (lifetime)');
  });
});

describe('R40 P-19 — every wall has a real gold button to the plan surface', () => {
  it('EditorShell listens for the plan event and reads the dashboard flag', () => {
    const shell = read('src/components/Editor/EditorShell.tsx');
    expect(shell).toContain('OPEN_PLAN_EVENT');
    expect(shell).toContain('OPEN_PLAN_SESSION_KEY');
    expect(shell).toContain('goToStep(3)');
  });

  it('ExportPanel quota and duration walls dispatch it', () => {
    const src = read('src/components/Editor/ExportPanel.tsx');
    expect(src).toContain('requestOpenPlan');
    expect(src).toContain('Upgrade to Lifetime');
    expect(src).toContain('bg-gold');
  });

  it('TranscribePanel quota wall is a real button, not directions in text', () => {
    const src = read('src/components/Editor/TranscribePanel.tsx');
    expect(src).toContain('requestOpenPlan');
    expect(src).toContain('Upgrade to Lifetime');
    expect(src).not.toContain('Open Step 3 — Export — to upgrade');
  });

  it('the Dashboard plan strip carries the button for Free users', () => {
    const src = read('src/components/Dashboard.tsx');
    expect(src).toContain('Upgrade to Lifetime');
    expect(src).toContain('OPEN_PLAN_SESSION_KEY');
  });
});

describe('R40 P-21/P-29 — admin confirms, exports the promised list, filters the waiting', () => {
  const admin = read('src/components/AdminPanel.tsx');

  it('access switches open a confirm that names the person and the change', () => {
    expect(admin).toContain('setConfirmAccess');
    expect(admin).toContain('Switch {confirmAccess.row.displayName || confirmAccess.row.email} to');
    expect(admin).toContain('Confirm access change');
  });

  it('the CSV is the filtered, opted-in list with name and email only', () => {
    expect(admin).toContain('visible.filter((u) => u.marketingOptIn)');
    expect(admin).toContain("'name,email'");
    expect(admin).toContain('who said yes to marketing emails');
  });

  it('there is a waiting-only filter', () => {
    expect(admin).toContain('Waiting for access');
    expect(admin).toContain('waitingOnly');
    expect(admin).toContain("u.status === 'pending'");
  });

  it('admin switches and the export button are 44px tall', () => {
    expect(admin).toContain('w-14 h-11');
    expect(admin).not.toContain('w-14 h-8');
    expect(admin).not.toContain('min-h-[36px]');
  });
});

describe('R40 P-40/P-34 — the reel chooser explains itself and meets 44px', () => {
  it('the two-tap hint sits under the strip', () => {
    expect(read('src/components/Editor/TemplatesPanel.tsx')).toContain(
      'Tap a card to preview it with your clips — tap again to use it.',
    );
  });

  it('template apply buttons are min-h-11, never min-h-10', () => {
    const src = read('src/components/Editor/TemplatesPanel.tsx');
    expect(src).not.toContain('min-h-10');
    expect(src).toContain('min-h-11');
  });

  it('PiP shape toggles are min-h-11, never min-h-9', () => {
    const src = read('src/components/Editor/PipShapeControls.tsx');
    expect(src).not.toContain('min-h-9');
    expect(src).toContain('min-h-11');
  });
});

describe('R40 P-43/P-44 — camera words at the decision points', () => {
  it('the countdown says recording has not started yet', () => {
    const cam = read('src/components/Editor/CameraCapture.tsx');
    expect(cam).toContain('Recording hasn');
    expect(cam).toContain('begins on its own');
    expect(cam).not.toContain('Hold still — recording starts when you are steady');
  });

  it('the earbud tip renders at two-step entry', () => {
    const cam = read('src/components/Editor/CameraCapture.tsx');
    expect(cam).toContain('TWO_PASS_ENTRY_TIP');
    const twoPass = read('src/lib/camera/twoPass.ts');
    expect(twoPass).toContain(
      'In step 2 your main video plays out loud — earbuds keep its sound out of your recording, and let you react in time.',
    );
  });
});

describe('R40 P-24 — suggestions never overwrite the user\u2019s own words', () => {
  const promo = read('src/components/PromoPage.tsx');

  it('cycleField guards on the Your-words provenance tag', () => {
    expect(promo).toContain("fieldSources[field] === 'yours'");
    expect(promo).toContain("That's your own line — left as is");
  });

  it('cyclePosterField guards on typed provenance', () => {
    expect(promo).toContain('posterTypedRef');
    expect(promo).toContain('posterTypedRef.current.has(field)');
  });

  it('both cycle buttons are 44px targets', () => {
    expect(promo).toContain('w-11 h-11');
    expect(promo).not.toContain('w-8 h-8 flex items-center justify-center rounded-md');
  });
});

describe('R40 P-25/P-30/P-14/P-17 — feedback, placement, plain failures, readable help', () => {
  it('PipPanel balance presets derive their pressed state from real volumes', () => {
    const src = read('src/components/Editor/PipPanel.tsx');
    expect(src).toContain('matchingPairBalancePreset');
    expect(src).toContain('aria-pressed={isActivePreset}');
  });

  it('CaptionsExportPanel is mounted in Step 3 as well as Step 2', () => {
    const shell = read('src/components/Editor/EditorShell.tsx');
    expect(shell.split('<CaptionsExportPanel').length - 1).toBe(2);
    const panel = read('src/components/Editor/CaptionsExportPanel.tsx');
    expect(panel).toContain('Download captions (SRT)');
    expect(panel).toContain('Download captions (VTT)');
  });

  it('MediaImportPanel shows only plain upload sentences', () => {
    const src = read('src/components/Editor/MediaImportPanel.tsx');
    expect(src).toContain('humanizeUploadError');
    expect(src).not.toContain('err?.message');
  });

  it('the save-status line is readable (white/60, not white/30)', () => {
    const shell = read('src/components/Editor/EditorShell.tsx');
    expect(shell).toContain('<span className="text-white/60">');
    expect(shell).not.toContain('<span className="text-white/30">');
  });
});
