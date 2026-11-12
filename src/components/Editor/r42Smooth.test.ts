/**
 * R42 Phase A — Smooth first (source-level guards, house style).
 *
 * S1 (closes R41 F11): the preview canvas backing store is set ONLY
 * on a dimension change — the old per-tick assignment wiped the
 * buffer every frame. drawFrame fully repaints each tick, so paused
 * edits still repaint instantly (pinned here + in the compositor's
 * own clear/fill behaviour).
 * S2 (closes the TemplatesPanel half of R41 F12): the focused card's
 * own-media preview freezes at the playback-start playhead while
 * playing; EditorShell passes isPlaying to both panel mounts.
 * S3: paused seeks follow one scrub-aware policy — loose
 * (0.35s/fastSeek) inside a scrub stream, exact (0.05s) otherwise,
 * with the exact settle left to the always-running tick.
 * E5: the stepper guidance names the overlay the way the panel does
 * and stops pointing Step 1 users only at Step 1 for templates.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const previewSource = readFileSync(join(HERE, 'PreviewPane.tsx'), 'utf8');
const panelSource = readFileSync(join(HERE, 'TemplatesPanel.tsx'), 'utf8');
const shellSource = readFileSync(join(HERE, 'EditorShell.tsx'), 'utf8');
const compositorSource = readFileSync(join(HERE, '../../lib/render/compositor.ts'), 'utf8');

describe('R42 S1 — canvas size is set only on dimension change (F11)', () => {
  it('the tick guards the size assignment behind a dimension check', () => {
    // R44 Phase A (SF-1) supersedes the size being guarded: the guard
    // now compares against the DISPLAY-SCALE backing size (box × DPR
    // via previewBackingSize), not the full project resolution — the
    // S1 discipline (assign only on change, exactly one site) is
    // unchanged; the full-res assignment is gone entirely.
    expect(previewSource).toContain(
      'if (canvas.width !== backing.width || canvas.height !== backing.height) {',
    );
    expect(previewSource.split('canvas.width = backing.width;').length - 1).toBe(1);
    expect(previewSource.split('canvas.height = backing.height;').length - 1).toBe(1);
    expect(previewSource).not.toContain('canvas.width = proj.canvasWidth;');
    expect(previewSource).not.toContain('canvas.height = proj.canvasHeight;');
  });

  it('paused edits still repaint instantly: drawFrame fully repaints every frame', () => {
    const drawFrameAt = compositorSource.indexOf('export function drawFrame');
    const head = compositorSource.slice(drawFrameAt, drawFrameAt + 400);
    expect(head).toContain('ctx.clearRect(0, 0, canvasWidth, canvasHeight);');
    expect(head).toContain('ctx.fillRect(0, 0, canvasWidth, canvasHeight);');
    // R44 SF-2 refines "draws on every pass": the draw is gated by
    // previewDrawDecision, whose rules (pinned in previewScale.test.ts)
    // force a draw on ANY project change — a paused edit is a project
    // change, so paused edits still repaint on the very next tick.
    // R44 Phase C: draws drawProj — identical to proj outside a canvas
    // drag; during one it is the drag-preview project (still a project
    // change per tick, so the repaint-on-edit rule is untouched).
    expect(previewSource).toContain('drawFrame(ctx, drawProj, t, frameAssets);');
    expect(previewSource).toContain('const shouldDraw = previewDrawDecision({');
  });
});

describe('R42 S2 — TemplatesPanel preview freezes during playback (F12)', () => {
  it('the panel derives a frozen preview time while playing', () => {
    expect(panelSource).toContain('const previewTime = isPlaying ? previewTimeRef.current : currentTime;');
    expect(panelSource).toContain('if (!isPlaying) previewTimeRef.current = currentTime;');
  });

  it('preview jobs, signatures and effect deps key on the frozen time — hook applies keep the live playhead', () => {
    expect(panelSource).toContain('const key = previewSignature(project, template, previewTime);');
    expect(panelSource).toContain('getPreviewJobs().set(key, { project, template, currentTime: previewTime });');
    expect(panelSource).toContain('}, [focusedId, project, previewTime]);');
    // The apply path is untouched: hooks still land at the live playhead.
    expect(panelSource).toContain('applyHookToProject(p, t, currentTime)');
  });

  it('EditorShell passes isPlaying to both TemplatesPanel mounts', () => {
    expect(shellSource.split('isPlaying={isPlaying} />').length - 1).toBeGreaterThanOrEqual(2);
    expect(shellSource).toContain('<TemplatesPanel currentTime={currentTime} uid={uid} isPlaying={isPlaying} />');
  });
});

describe('R42 S3 — scrub-aware paused seeks', () => {
  it('one seekPaused policy: 0.35s loose inside a scrub stream, 0.05s exact otherwise, fastSeek while scrubbing', () => {
    expect(previewSource).toContain('const seekPaused = (el: HTMLMediaElement, target: number) => {');
    expect(previewSource).toContain("const tolerance = scrubbing ? 0.35 : 0.05;");
    expect(previewSource).toContain('fastSeek.call(el, target)');
    // The tick routes its paused video + audio seeks through the policy.
    expect(previewSource).toContain('seekPaused(el, target);');
    expect(previewSource).toContain('seekPaused(audioEl, targetSourceTime);');
  });

  it('external seeks mark the scrub window only when they arrive in a stream; a lone seek stays exact', () => {
    expect(previewSource).toContain('const inScrubStream = seekNow - lastExternalSeekAtRef.current < 250;');
    expect(previewSource).toContain('scrubbingUntilRef.current = inScrubStream ? seekNow + 250 : 0;');
    expect(previewSource).toContain('if (!inScrubStream) {');
  });
});

describe('R42 E5 — guidance copy traps fixed', () => {
  it('step guidance names the overlay the way its panel does — no bare PiP', () => {
    expect(shellSource).toContain("'Edit, transitions, effects, captions, overlay'");
    expect(shellSource).not.toContain('captions, PiP');
    expect(shellSource).toContain('title="Overlay — picture in picture"');
  });

  it('step 1 guidance says templates live in Edit too (the auto-advance destination)', () => {
    expect(shellSource).toContain("'Upload or record — templates are here and in Edit'");
    expect(shellSource).not.toContain('Upload, record, or pick a template');
  });
});
