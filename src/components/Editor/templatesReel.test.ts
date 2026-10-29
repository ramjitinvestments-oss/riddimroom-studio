/**
 * R37 Phase 1 — the TemplatesPanel chooser is ONE reel strip: all 20
 * templates render as cards inside a single strip node (the structural
 * proxy for the 1,750px → 236px footprint cut), behind one chip row —
 * no vertical sections, no category <select>. Plus the structural
 * guard that EditorShell mounts the same panel in Step 2 as well as
 * Step 1 (source-level, in the house style of cameraSmoothness).
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultProject } from '../../lib/projects/persistence';
import { STUDIO_TEMPLATES } from '../../lib/templates';
import type { Project } from '../../types/timeline';

const projectRef = vi.hoisted(() => ({ current: null as Project | null }));

vi.mock('../../context/ProjectContext', () => ({
  useProject: () => ({ project: projectRef.current, mutate: () => undefined }),
}));

import { TemplatesPanel } from './TemplatesPanel';

const HERE = dirname(fileURLToPath(import.meta.url));

function renderPanel(): string {
  projectRef.current = createDefaultProject('u1');
  return renderToStaticMarkup(React.createElement(TemplatesPanel, { currentTime: 0, uid: 'u1' }));
}

describe('R37 TemplatesPanel — reel strip chooser', () => {
  it('renders ONE strip containing all 20 template cards', () => {
    const markup = renderPanel();
    expect((markup.match(/data-reel-strip/g) ?? []).length).toBe(1);
    expect((markup.match(/data-reel-card=/g) ?? []).length).toBe(20);
    for (const t of STUDIO_TEMPLATES) {
      expect(markup).toContain(`data-reel-card="${t.id}"`);
      expect(markup).toContain(t.name);
    }
  });

  it('the chip row carries All · Hooks · Full edits · the categories', () => {
    const markup = renderPanel();
    expect(markup).toContain('>All<');
    expect(markup).toContain('>Hooks<');
    expect(markup).toContain('>Full edits<');
    expect(markup).toContain('>Viral Social<');
    expect(markup).toContain('>Store Service<');
  });

  it('the old chooser is gone: no sections, no category dropdown', () => {
    const markup = renderPanel();
    expect(markup).not.toContain('Hooks · 1.5–4s');
    expect(markup).not.toContain('Full Edits · 15–45s');
    expect(markup).not.toContain('<select');
    expect(markup).not.toContain('Template category');
  });

  it('focused-card detail + the switching disclosure sit under the strip', () => {
    const markup = renderPanel();
    const stripAt = markup.indexOf('data-reel-strip');
    const detailAt = markup.indexOf('A gold title smash with a punch-zoom');
    const disclosureAt = markup.indexOf('Hooks drop in at the playhead and stack.');
    expect(stripAt).toBeGreaterThan(-1);
    // Default focus = first catalog template (Gold Smash Intro).
    expect(detailAt).toBeGreaterThan(stripAt);
    expect(disclosureAt).toBeGreaterThan(detailAt);
    expect(markup).toContain('Applying another full edit re-packs from your current clips.');
  });

  it('cards carry their facts: duration chips, kind labels, slot counts, frame chips', () => {
    const markup = renderPanel();
    expect(markup).toContain('>2.5s<');
    expect(markup).toContain('>30s<');
    expect(markup).toContain('Full edit');
    expect(markup).toContain('5 clips');
    expect(markup).toContain('>16:9<');
    // The focused (first) card carries the Apply affordance.
    expect(markup).toContain('>Apply<');
  });

  it('no-project fallback keeps its explanatory paragraph', () => {
    projectRef.current = null;
    const markup = renderToStaticMarkup(React.createElement(TemplatesPanel, { currentTime: 0, uid: 'u1' }));
    expect(markup).toContain('Open a project first');
    expect(markup).not.toContain('data-reel-strip');
  });
});

describe('R37 EditorShell — Step-2 Templates mount', () => {
  const shell = readFileSync(join(HERE, 'EditorShell.tsx'), 'utf8');

  it('mounts TemplatesPanel twice: Step 1 aside + Step 2 panel group', () => {
    expect((shell.match(/<TemplatesPanel/g) ?? []).length).toBe(2);
    expect(shell).toContain("groupProps('templates')");
    expect(shell).toContain('<PanelGroup title="Templates"');
  });
});
