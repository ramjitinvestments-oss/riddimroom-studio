/**
 * R36 WS-1 — PipPanel empty state: with no PiP selected, "Record PiP"
 * and "Upload PiP" are the equal primary actions; with a PiP selected
 * the panel is that PiP's controls and the add pair steps aside.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createDefaultProject } from '../../lib/projects/persistence';
import { addPipOverlay } from '../../lib/pip';
import type { MediaAsset, Project } from '../../types/timeline';

const projectRef = vi.hoisted(() => ({ current: null as Project | null }));

vi.mock('../../context/ProjectContext', () => ({
  useProject: () => ({ project: projectRef.current, mutate: () => undefined }),
}));

import { PipPanel } from './PipPanel';

function videoAsset(id: string): MediaAsset {
  return {
    id,
    kind: 'video',
    storageUrl: `https://example.com/${id}.mp4`,
    fileName: `${id}.mp4`,
    sizeBytes: 1_000_000,
    mimeType: 'video/mp4',
    durationSeconds: 10,
    width: 1920,
    height: 1080,
    createdAt: 0,
  };
}

describe('WS-1 PipPanel add actions', () => {
  it('no PiP selected or existing: Record PiP and Upload PiP are both shown as the add actions', () => {
    projectRef.current = createDefaultProject('u1');
    const markup = renderToStaticMarkup(React.createElement(PipPanel, { item: null }));
    expect(markup).toContain('Record PiP');
    expect(markup).toContain('Upload PiP');
  });

  it('a PiP selected: the panel shows that PiP’s controls and the empty-state add pair steps aside', () => {
    let project = createDefaultProject('u1');
    project = addPipOverlay(project, videoAsset('asset-pip'));
    projectRef.current = project;
    const pip = project.items[0];
    const markup = renderToStaticMarkup(React.createElement(PipPanel, { item: pip }));
    expect(markup).not.toContain('Record PiP');
    expect(markup).toContain('Overlay size');
    expect(markup).toContain('Overlay audio');
  });
});
