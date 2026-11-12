/**
 * R44 Phase D — rich timeline media (source-level guards).
 *
 * PL-2: video clips render a filmstrip of sampled frames (trim-aligned
 * by CSS geometry) instead of one stretched poster; PL-3: audio clips
 * render a waveform canvas from the decoded peaks. The pure math is
 * pinned in lib/media/waveform.test.ts + thumbnails.test.ts; these
 * guards pin the panel wiring.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(HERE, 'TimelinePanel.tsx'), 'utf8');
const thumbnails = readFileSync(join(HERE, '../../lib/media/thumbnails.ts'), 'utf8');
const waveform = readFileSync(join(HERE, '../../lib/media/waveform.ts'), 'utf8');

describe('R44 PL-2 — filmstrip frames along video clips', () => {
  it('the panel requests filmstrips for video assets and passes them to rows', () => {
    expect(panel).toContain("import { getAssetFilmstrip, getAssetPoster } from '../../lib/media/thumbnails';");
    expect(panel).toContain('getAssetFilmstrip(asset)');
    expect(panel).toContain('filmstripUrls={filmstripUrls}');
    expect(panel).toContain('filmstripDuration={filmstripDuration}');
  });

  it('the strip is trim-aligned by geometry, with the single poster as the fallback', () => {
    expect(panel).toContain('filmstripUrls && filmstripUrls.length > 0 ? (');
    expect(panel).toContain('(filmstripDuration / windowSeconds) * 100');
    expect(panel).toContain('-(trimStart / windowSeconds) * 100');
    // Poster still renders when no strip exists.
    expect(panel).toContain(') : posterUrl ? (');
  });

  it('the sampler is session-cached and video-only', () => {
    expect(thumbnails).toContain('export function getAssetFilmstrip');
    expect(thumbnails).toContain("if (asset.kind !== 'video') return Promise.resolve(null);");
    expect(thumbnails).toContain('filmstripCache');
  });
});

describe('R44 PL-3 — audio waveforms', () => {
  it('the panel requests waveforms for audio assets and renders the canvas only when peaks exist', () => {
    expect(panel).toContain("import { getAssetWaveform, waveformBarHeights } from '../../lib/media/waveform';");
    expect(panel).toContain('getAssetWaveform(asset)');
    expect(panel).toContain('waveformPeaks={waveformPeaks}');
    expect(panel).toContain("item.type === 'audio' && waveformPeaks ? (");
    expect(panel).toContain('<WaveformCanvas');
  });

  it('the canvas draws the trim window slice of the peaks', () => {
    expect(panel).toContain('waveformBarHeights(peaks, startFrac, endFrac, columns)');
    expect(panel).toContain('trimStart / duration');
  });

  it('the decoder is cached, audio-only, duration-capped and failure-null', () => {
    expect(waveform).toContain('export function getAssetWaveform');
    expect(waveform).toContain("if (asset.kind !== 'audio') return Promise.resolve(null);");
    expect(waveform).toContain('MAX_WAVEFORM_SECONDS');
    expect(waveform).toContain('waveformCache');
    expect(waveform).toContain('.catch(() => null)');
  });
});
