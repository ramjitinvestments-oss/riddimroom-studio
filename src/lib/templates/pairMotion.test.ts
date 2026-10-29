import { describe, it, expect } from 'vitest';
import {
  PAIR_SAFE_MOTION,
  cameraPairItemIds,
  isCameraPairItem,
  isCameraPipItem,
  pairSafeMotion,
  pairSafeMotionForType,
  pairSafeTransition,
} from './pairMotion';
import { applyFullTemplate, applyHookToProject } from './apply';
import { getTemplate } from '../templates';
import { createDefaultProject } from '../projects/persistence';
import { appendDualCaptureToTimeline, appendMediaToTimeline } from '../timeline/insert';
import { updateItem } from '../timeline/utils';
import { addPipOverlay } from '../pip';
import type { MediaAsset, Project, VideoTimelineItem } from '../../types/timeline';

function videoAsset(id: string, durationSeconds = 12): MediaAsset {
  return {
    id,
    kind: 'video',
    storageUrl: `https://example.com/${id}.mp4`,
    fileName: `${id}.mp4`,
    sizeBytes: 1_000_000,
    mimeType: 'video/mp4',
    durationSeconds,
    width: 1920,
    height: 1080,
    createdAt: 0,
  };
}

/** A project holding one real camera pair, placed exactly as the camera's "Add both" places it. */
function projectWithPair(): Project {
  let project = createDefaultProject('uid-1');
  project = appendDualCaptureToTimeline(project, videoAsset('asset-main'), videoAsset('asset-front'), {
    startDeltaMs: 0,
  });
  return project;
}

function videoItem(project: Project, assetId: string): VideoTimelineItem {
  const item = project.items.find((i) => i.type === 'video' && i.mediaAssetId === assetId);
  if (!item || item.type !== 'video') throw new Error(`expected a video item for ${assetId}`);
  return item;
}

describe('pair identification', () => {
  it('the pair placement persists the camera flag on the PiP', () => {
    const project = projectWithPair();
    const pip = videoItem(project, 'asset-front');
    expect(pip.pip?.fromCamera).toBe(true);
    expect(pip.pip?.fit).toBe('source');
    expect(isCameraPipItem(pip)).toBe(true);
  });

  it('identifies BOTH pair members: the camera PiP and the main clip it sits on', () => {
    const project = projectWithPair();
    const main = videoItem(project, 'asset-main');
    const pip = videoItem(project, 'asset-front');
    const ids = cameraPairItemIds(project);
    expect(ids.has(pip.id)).toBe(true);
    expect(ids.has(main.id)).toBe(true);
    expect(isCameraPairItem(project, main)).toBe(true);
    expect(isCameraPairItem(project, pip)).toBe(true);
  });

  it('recognises a legacy camera PiP that carries only the source-fit signal', () => {
    let project = projectWithPair();
    const pip = videoItem(project, 'asset-front');
    // Simulate a pre-R32-Phase-3 project: strip the persisted flag.
    project = updateItem(project, pip.id, { pip: { ...pip.pip!, fromCamera: undefined } });
    const legacyPip = videoItem(project, 'asset-front');
    expect(legacyPip.pip?.fromCamera).toBeUndefined();
    expect(isCameraPipItem(legacyPip)).toBe(true);
    expect(cameraPairItemIds(project).has(legacyPip.id)).toBe(true);
  });

  it('does not flag an uploaded PiP or the unrelated clip under it', () => {
    let project = createDefaultProject('uid-1');
    project = appendMediaToTimeline(project, videoAsset('asset-main'));
    project = addPipOverlay(project, videoAsset('asset-upload'), { atTime: 0 });
    const main = videoItem(project, 'asset-main');
    const pip = videoItem(project, 'asset-upload');
    expect(pip.pip?.fromCamera).toBeUndefined();
    expect(isCameraPipItem(pip)).toBe(false);
    expect(cameraPairItemIds(project).size).toBe(0);
    expect(isCameraPairItem(project, main)).toBe(false);
  });
});

describe('pair-safe motion mapping', () => {
  it('maps every aggressive motion to the gentle product-focus cap', () => {
    for (const type of ['punch-zoom', 'dynamic-zoom', 'subtle-shake', 'flash', 'parallax', 'ken-burns', 'orbit-drift'] as const) {
      expect(pairSafeMotion({ type, intensity: 2 })).toEqual(PAIR_SAFE_MOTION);
      expect(pairSafeMotionForType(type)).toEqual(PAIR_SAFE_MOTION);
    }
    expect(PAIR_SAFE_MOTION).toEqual({ type: 'product-focus', intensity: 0.5 });
  });

  it('keeps none as none', () => {
    expect(pairSafeMotion({ type: 'none' })).toEqual({ type: 'none' });
    expect(pairSafeMotion(undefined)).toEqual({ type: 'none' });
    expect(pairSafeMotionForType('none')).toEqual({ type: 'none' });
    expect(pairSafeMotionForType(undefined)).toEqual({ type: 'none' });
  });

  it('keeps fade-class transitions and turns everything else into a fade', () => {
    for (const gentle of ['none', 'fade', 'film-dissolve', 'luma-fade', 'dip-to-black', 'dip-to-white', 'dip-to-gold']) {
      expect(pairSafeTransition(gentle)).toBe(gentle);
    }
    for (const aggressive of ['whip-pan', 'snap-zoom', 'smooth-spin', 'glitch', 'pop', 'slide-left', 'cross-zoom', 'heartbeat', 'flash']) {
      expect(pairSafeTransition(aggressive)).toBe('fade');
    }
  });
});

describe('template application caps the pair (and only the pair)', () => {
  it('full template: pair main + pair PiP get gentle motion and fade transitions; a later clip is untouched by the cap', () => {
    let project = projectWithPair();
    // A third, unrelated clip after the pair — slotted by the same template.
    project = appendMediaToTimeline(project, videoAsset('asset-extra', 30));
    const template = getTemplate('viral-hook-story')!; // transition cross-zoom, slots punch-zoom/dynamic-zoom/…
    const { project: next } = applyFullTemplate(project, template);

    const main = videoItem(next, 'asset-main');
    expect(main.motion).toEqual(PAIR_SAFE_MOTION);
    expect(main.animation?.entrance).toBe('fade');
    expect(main.animation?.exit).toBe('fade');

    const pip = videoItem(next, 'asset-front');
    expect(pip.motion).toEqual(PAIR_SAFE_MOTION);
    expect(pip.animation?.entrance).toBe('fade');

    const extra = videoItem(next, 'asset-extra');
    expect(extra.motion).not.toEqual(PAIR_SAFE_MOTION);
    expect(extra.animation?.entrance).toBe('cross-zoom');
  });

  it('hook: motion under the hook is capped on pair items only', () => {
    const project = projectWithPair();
    const template = getTemplate('gold-smash-intro')!; // motion punch-zoom
    const next = applyHookToProject(project, template, 0);
    expect(videoItem(next, 'asset-main').motion).toEqual(PAIR_SAFE_MOTION);
    expect(videoItem(next, 'asset-front').motion).toEqual(PAIR_SAFE_MOTION);
  });

  it('hook: the PiP end-transform glide is skipped for a camera pair PiP but still applies to an uploaded PiP', () => {
    const template = getTemplate('split-reveal')!; // carries pipEndTransform
    const pairProject = projectWithPair();
    const afterPair = applyHookToProject(pairProject, template, 0);
    expect(videoItem(afterPair, 'asset-front').endTransform).toBeUndefined();

    let uploadProject = createDefaultProject('uid-1');
    uploadProject = appendMediaToTimeline(uploadProject, videoAsset('asset-main'));
    uploadProject = addPipOverlay(uploadProject, videoAsset('asset-upload'), { atTime: 0 });
    const afterUpload = applyHookToProject(uploadProject, template, 0);
    expect(videoItem(afterUpload, 'asset-upload').endTransform).toEqual(template.pipEndTransform);
  });
});
