/**
 * R36 WS-1 — MediaImportPanel surface: the Record PiP / Upload PiP
 * pair sits alongside the existing actions, and the main flow's quiet
 * camera entry ("Record with camera instead") is unchanged.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MediaImportPanel } from './MediaImportPanel';

const panelSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'MediaImportPanel.tsx'), 'utf8');

describe('WS-1 MediaImportPanel PiP actions', () => {
  it('shows Record PiP and Upload PiP as a pair, and keeps the main camera entry', () => {
    const markup = renderToStaticMarkup(
      React.createElement(MediaImportPanel, {
        uid: 'u1',
        canvasWidth: 1080,
        canvasHeight: 1920,
        onAssetUploaded: () => undefined,
        onOverlayAssetUploaded: () => undefined,
      }),
    );
    expect(markup).toContain('Record PiP');
    expect(markup).toContain('Upload PiP');
    expect(markup).toContain('Record with camera instead');
    expect(markup).toContain('Add Video / Image');
    expect(markup).toContain('Add Overlay');
  });

  it('R40 P-31: no pair gate renders before an upload — the offer exists only in the post-import state', () => {
    const markup = renderToStaticMarkup(
      React.createElement(MediaImportPanel, {
        uid: 'u1',
        canvasWidth: 1080,
        canvasHeight: 1920,
        onAssetUploaded: () => undefined,
        onOverlayAssetUploaded: () => undefined,
        onPairAssetUploaded: () => undefined,
      }),
    );
    // Nothing pair-shaped blocks or precedes a fresh upload.
    expect(markup).not.toContain('Use these two as a pair?');
    expect(markup).not.toContain('Add these two as a pair?');
    expect(markup).not.toContain('Add separately instead');
    // The source carries the inverted flow: files land first, the
    // quiet offer is tracked from landed assets.
    expect(panelSource).toContain('pairOfferBatchesRef');
    expect(panelSource).toContain('Use these two as a pair?');
    expect(panelSource).not.toContain('pairCandidate');
    expect(panelSource).not.toContain('Add separately instead');
  });

  it('R40 P-45: the pair layout choice is [Corner PiP, Split 50/50] with Corner PiP the default', () => {
    const pipIdx = panelSource.indexOf("{ id: 'pip', label: 'Corner PiP' }");
    const splitIdx = panelSource.indexOf("{ id: 'split', label: 'Split 50/50' }");
    expect(pipIdx).toBeGreaterThan(-1);
    expect(splitIdx).toBeGreaterThan(pipIdx);
    expect(panelSource).toContain("useState<'pip' | 'split'>('pip')");
  });

  it('R40 P-42: the PiP listener claims with its instance token, answers, and releases on unmount', () => {
    expect(panelSource).toContain('claimPipRequest(e, instance)');
    expect(panelSource).toContain('answerPipRequest(e, instance)');
    expect(panelSource).toContain('releasePipRequestClaim(held.event, instance)');
    expect(panelSource).toContain('markPipRequestRedispatched(held.event)');
  });
});
