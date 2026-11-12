/**
 * R44 Phase B — timeline feel: source guards + zoom-memory logic pins.
 * (Behaviour of magnetism itself is pinned in lib/timeline/magnetic.test.ts;
 * drag commit discipline stays pinned by timelinePerf.test.ts.)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadTimelineZoom, saveTimelineZoom } from './timelinePanelLogic';

const panel = () => readFileSync(resolve(process.cwd(), 'src/components/Editor/TimelinePanel.tsx'), 'utf8');
const shell = () => readFileSync(resolve(process.cwd(), 'src/components/Editor/EditorShell.tsx'), 'utf8');
const inspector = () => readFileSync(resolve(process.cwd(), 'src/components/Editor/ItemInspector.tsx'), 'utf8');

describe('R44 Phase B — TimelinePanel', () => {
  it('SF-5: the "px/s" readout is dead — a plain level bar + Fit button instead', () => {
    const src = panel();
    expect(src).not.toContain('{Math.round(pxPerSec)} px/s'); // the old rendered readout
    expect(src).toContain('Fit the whole project in view');
    expect(src).toContain('fitZoom');
  });

  it('SF-5: zoom is remembered per project', () => {
    const src = panel();
    expect(src).toContain('loadTimelineZoom(project.id)');
    expect(src).toContain('saveTimelineZoom(project.id, pxPerSec)');
  });

  it('SF-5: pinch + ctrl-wheel zoom are wired', () => {
    const src = panel();
    expect(src).toContain('handleContainerTouch');
    expect(src).toContain('pinchRef');
    expect(src).toContain("addEventListener('wheel'");
    expect(src).toContain('e.ctrlKey || e.metaKey');
  });

  it('SF-4: playback follow exists with the manual-scroll suspension rule', () => {
    const src = panel();
    expect(src).toContain('followSuspendedRef');
    expect(src).toContain('lastProgrammaticScrollRef');
    expect(src).toContain('isPlaying');
    expect(shell()).toContain('isPlaying={isPlaying}');
  });

  it('SF-6: touch scrub starts from the track background; the column is touch-none', () => {
    const src = panel();
    expect(src).toContain("beginScrub(touch.clientX, { move: 'touchmove', up: 'touchend' })");
    expect(src).toContain('touch-none');
  });

  it('SF-7: move drags commit through the magnetic entry point; deletes close gaps', () => {
    expect(panel()).toContain('moveItemMagnetic(p, itemId, target.startTime)');
    expect(shell()).toContain('removeItemClosingGap(p, selectedItemId)');
    expect(inspector()).toContain('removeItemClosingGap(project, item.id)');
  });

  it('PL-4 + PL-6: snap haptics fire from the drag path; the mute hit area is 44px', () => {
    const src = panel();
    expect(src).toContain('snapHaptic()');
    expect(src).toContain('w-11 h-11');
    expect(src).not.toContain('w-8 h-8 shrink-0 flex items-center justify-center rounded bg-black/50');
  });
});

describe('R44 SF-5 — zoom memory storage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubStorage() {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
    return store;
  }

  it('round-trips per project and keeps projects separate', () => {
    stubStorage();
    expect(loadTimelineZoom('p1')).toBeNull();
    saveTimelineZoom('p1', 42);
    saveTimelineZoom('p2', 17);
    expect(loadTimelineZoom('p1')).toBe(42);
    expect(loadTimelineZoom('p2')).toBe(17);
  });

  it('garbage in storage reads as no memory, never a crash', () => {
    const store = stubStorage();
    store.set('riddimroom.timeline.zoom.v1', '{not json');
    expect(loadTimelineZoom('p1')).toBeNull();
    store.set('riddimroom.timeline.zoom.v1', '{"p1":"wide"}');
    expect(loadTimelineZoom('p1')).toBeNull();
  });
});
