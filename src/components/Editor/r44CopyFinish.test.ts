/**
 * R44 Phase E — copy & surface finish (source-level guards).
 *
 * PL-5: PiP naming unified to the Overlay family on every user-facing
 * label (camera, import, panel, inspector, shell group); the mobile
 * Tools button no longer wears a gear (Settings) icon.
 * PL-7: exports hold a screen WakeLock and say "Keep this screen open
 * while it renders."
 * PL-8: the Share pack is demoted behind the export actions in Step 3;
 * loading states carry friendly words.
 *
 * Assertions target the LABEL forms (JSX text / label literals), not
 * the word "PiP" itself — code identifiers (pip.isPip) and historical
 * comments keep the technical term.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, rel), 'utf8');

const shell = read('EditorShell.tsx');
const camera = read('CameraCapture.tsx');
const importer = read('MediaImportPanel.tsx');
const pipPanel = read('PipPanel.tsx');
const pipButtons = read('PipAddButtons.tsx');
const inspector = read('ItemInspector.tsx');
const exporter = read('ExportPanel.tsx');
const dashboard = read('../Dashboard.tsx');
const app = read('../../App.tsx');

describe('R44 PL-5 — one name for the overlay clip, everywhere a user reads it', () => {
  it('the add actions all say Overlay', () => {
    expect(pipButtons).toContain('Record overlay');
    expect(pipButtons).toContain('Upload overlay');
    expect(pipButtons).not.toContain('Record PiP');
    expect(pipButtons).not.toContain('Upload PiP');
    expect(camera).toContain('/> Add as overlay');
    expect(camera).toContain('/> Use as overlay');
    expect(pipPanel).toContain('+ Add as overlay');
  });

  it('the layout choice is Corner overlay in all three surfaces', () => {
    for (const src of [camera, importer, pipPanel]) {
      expect(src).toContain("{ id: 'pip', label: 'Corner overlay' }");
      expect(src).not.toContain("{ id: 'pip', label: 'Corner PiP' }");
    }
  });

  it('the inspector and panel headings say Overlay clip; the toggle matches', () => {
    expect(inspector).toContain('>Overlay clip</span>');
    expect(inspector).toContain("'Make overlay clip'");
    expect(inspector).toContain('Is overlay clip');
    expect(inspector).not.toContain('Make PiP overlay');
    expect(inspector).not.toContain('Picture in picture (PiP)');
    expect(inspector).not.toContain('Remove PiP');
    expect(pipPanel).toContain('>Overlay clip</h3>');
    expect(pipPanel).toContain('Select an overlay clip on the timeline');
    expect(shell).toContain('title="Overlay clip"');
    expect(shell).not.toContain('title="Overlay — picture in picture"');
    expect(dashboard).toContain('overlay clips, text.');
    expect(dashboard).not.toContain('PiP overlay');
  });

  it('the mobile Tools button wears a sliders icon, not the Settings gear', () => {
    expect(shell).toContain('<SlidersHorizontal size={18} />');
    expect(shell).not.toContain('<Settings size={18} />');
  });
});

describe('R44 PL-7 — exports keep the screen awake and say so', () => {
  it('a WakeLock is requested while busy and released after, guarded as optional', () => {
    expect(exporter).toContain("wakeLock\n      ?.request('screen')");
    expect(exporter).toContain('void lock?.release().catch(() => {});');
  });

  it('both progress states carry the keep-open line', () => {
    const lines = exporter.match(/Keep this screen open while it renders\./g) ?? [];
    expect(lines.length).toBe(2);
  });
});

describe('R44 PL-8 — Share pack demoted; loading states worded', () => {
  it('the save action and its confirmation lead the done block, ahead of every share extra', () => {
    const saveAt = exporter.indexOf('Save MP4 to this device');
    const savedAt = exporter.indexOf('Saved ✓');
    const shareVideoAt = exporter.indexOf('Share video…');
    const sharePackAt = exporter.indexOf('Share pack — your posts');
    expect(saveAt).toBeGreaterThan(-1);
    expect(savedAt).toBeGreaterThan(saveAt);
    expect(shareVideoAt).toBeGreaterThan(savedAt);
    // The Share pack name now heads the posts block, below everything.
    expect(sharePackAt).toBeGreaterThan(shareVideoAt);
    expect(exporter).not.toContain('text-gold">Share pack</span>');
    // The feature itself is intact.
    expect(exporter).toContain('Copy caption + hashtags');
    expect(exporter).toContain('Copy post');
  });

  it('cold-open and Dashboard loading states carry friendly words', () => {
    expect(app).toContain('Loading RiddimRoom Studio…');
    expect(dashboard).toContain('Loading your projects…');
    expect(dashboard).toContain('animate-pulse');
  });
});
