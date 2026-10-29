/**
 * R36 WS-1 — MediaImportPanel surface: the Record PiP / Upload PiP
 * pair sits alongside the existing actions, and the main flow's quiet
 * camera entry ("Record with camera instead") is unchanged.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MediaImportPanel } from './MediaImportPanel';

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
});
