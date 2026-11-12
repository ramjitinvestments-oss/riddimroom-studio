/**
 * R42 Phase B — Back & safety (source-level guards, house style):
 * the history-aware Back wiring (steps in EditorShell, sheets via
 * BottomSheet, the editor's three modal pickers), the bulk-edit undo
 * announcements, and the Dashboard recycle bin (trash not erase,
 * restore, permanent erase behind its own confirm, recovery named
 * in the delete confirm copy).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, rel), 'utf8');
const shell = read('EditorShell.tsx');
const sheet = read('BottomSheet.tsx');
const trimModal = read('TrimSelectModal.tsx');
const slotPicker = read('SlotTrimPicker.tsx');
const reframePicker = read('ReframePicker.tsx');
const templatesPanel = read('TemplatesPanel.tsx');
const transcribePanel = read('TranscribePanel.tsx');
const dashboard = read('../Dashboard.tsx');
const persistence = read('../../lib/projects/persistence.ts');

describe('R42 B — Back walks inside the editor first', () => {
  it('EditorShell owns one popstate listener feeding the layer stack', () => {
    expect(shell).toContain("window.addEventListener('popstate', handler);");
    expect(shell).toContain('handleBackPop();');
    expect(shell).toContain("window.removeEventListener('popstate', handler);");
  });

  it('step changes register a Back layer back to the previous step', () => {
    expect(shell).toContain('unregister = pushBackLayer(() => {');
    expect(shell).toContain('setStep(prev);');
    // …and unmounting drops the session’s step layers (no leaks).
    expect(shell).toContain('unregisters.forEach((u) => u());');
  });

  it('sheets and the editor’s modal pickers own a Back layer while open', () => {
    expect(sheet).toContain('useBackLayer(open, onClose);');
    expect(trimModal).toContain('useBackLayer(true, onCancel);');
    expect(slotPicker).toContain('useBackLayer(true, onCancel);');
    expect(reframePicker).toContain('useBackLayer(true, onCancel);');
  });
});

describe('R42 B — bulk edits announce their Undo', () => {
  it('template applies (full + hook) dispatch the undo toast', () => {
    expect(templatesPanel).toContain("detail: { message: 'Template applied' }");
    expect(templatesPanel).toContain("detail: { message: 'Hook applied' }");
  });

  it('a landed transcription dispatches the undo toast', () => {
    expect(transcribePanel).toContain("detail: { message: 'Captions added' }");
  });
});

describe('R42 B — Dashboard delete is a move to Recently deleted', () => {
  it('the confirm path trashes, never erases; only the bin erases', () => {
    expect(dashboard).toContain('await trashProjects(ids);');
    expect(dashboard).toContain('await deleteProjects(ids);');
    expect(dashboard).toContain('handleConfirmPermanent');
  });

  it('the delete confirm names the recovery', () => {
    expect(dashboard).toContain('you can restore it from there for 30 days');
    expect(dashboard).not.toContain('This can&rsquo;t be undone.</p>\n            <div className="flex gap-2">\n              <button\n                onClick={() => setConfirmDelete(null)}');
  });

  it('the bin renders with Restore and a separately-confirmed Delete forever', () => {
    expect(dashboard).toContain('Recently deleted ({deletedProjects.length})');
    expect(dashboard).toContain('daysLeft');
    expect(dashboard).toContain('Delete forever');
    expect(dashboard).toContain('aria-label="Confirm permanent deletion"');
  });

  it('persistence: live lists exclude trashed projects; the bin lists, restores and purges', () => {
    expect(persistence).toContain("typeof (docSnap.data() as Project).deletedAt !== 'number'");
    expect(persistence).toContain('export async function trashProjects');
    expect(persistence).toContain('export async function restoreProjects');
    expect(persistence).toContain('export async function listDeletedProjects');
    expect(persistence).toContain('await deleteProjects(expiredIds);');
  });
});
