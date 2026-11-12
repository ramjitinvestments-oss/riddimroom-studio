import { describe, it, expect } from 'vitest';
import { getTemplate } from '../templates';
import { applyFullTemplate, applyHookToProject } from './apply';
import {
  activeCaptionStyleId,
  contractTemplate,
  fitAddedItem,
  newTemplateContract,
  releaseTemplate,
  templateDrift,
} from './contract';
import { createDefaultProject } from '../projects/persistence';
import { addCaptionItems, addTextItem, appendMediaToTimeline } from '../timeline/insert';
import { removeItem, updateItem } from '../timeline/utils';
import { addPipOverlay } from '../pip';
import type { MediaAsset, Project } from '../../types/timeline';

let assetSeq = 0;
function videoAsset(durationSeconds: number): MediaAsset {
  assetSeq += 1;
  return {
    id: `asset-v-${assetSeq}`,
    kind: 'video',
    storageUrl: 'https://example.com/video.mp4',
    fileName: `clip-${assetSeq}.mp4`,
    sizeBytes: 1_000_000,
    mimeType: 'video/mp4',
    durationSeconds,
    width: 1080,
    height: 1920,
    createdAt: 0,
  };
}
function imageAsset(): MediaAsset {
  assetSeq += 1;
  return {
    id: `asset-i-${assetSeq}`,
    kind: 'image',
    storageUrl: 'https://example.com/image.jpg',
    fileName: `photo-${assetSeq}.jpg`,
    sizeBytes: 100_000,
    mimeType: 'image/jpeg',
    durationSeconds: 0,
    width: 1080,
    height: 1920,
    createdAt: 0,
  };
}

function projectWithClips(count: number, seconds = 30): Project {
  let project = createDefaultProject('uid-1');
  for (let k = 0; k < count; k++) project = appendMediaToTimeline(project, videoAsset(seconds));
  return project;
}
function slottableIds(project: Project): string[] {
  return project.items.filter((i) => i.type === 'video' || i.type === 'image').map((i) => i.id);
}
function byId(project: Project, id: string) {
  return project.items.find((i) => i.id === id)!;
}

describe('R42 Phase D — apply records the contract', () => {
  it('applyFullTemplate records appliedTemplate with the slot map', () => {
    const project = projectWithClips(3);
    const ids = slottableIds(project);
    const { project: next } = applyFullTemplate(project, getTemplate('commercial-30')!, { nowMs: 1234 });
    expect(next.appliedTemplate?.templateId).toBe('commercial-30');
    expect(next.appliedTemplate?.appliedAt).toBe(1234);
    // Runs [3,3,2] over 8 slots → run heads 0, 3, 6.
    expect(next.appliedTemplate?.slotByItemId).toEqual({ [ids[0]]: 0, [ids[1]]: 3, [ids[2]]: 6 });
    expect(contractTemplate(next)?.id).toBe('commercial-30');
  });

  it('slot-merge: fewer clips than slots still lands the reel on the template total', () => {
    const project = projectWithClips(3);
    const { project: next, reelEndSeconds } = applyFullTemplate(project, getTemplate('commercial-30')!);
    expect(reelEndSeconds).toBeCloseTo(21, 6);
    const durations = slottableIds(next).map((id) => {
      const item = byId(next, id);
      return Math.round((item.endTime - item.startTime) * 100) / 100;
    });
    expect(durations).toEqual([9, 8, 4]); // runs [3,3,2] of 3,3,3,3,2,3,2,2
    expect(next.items.length).toBeGreaterThan(0);
  });

  it('re-apply replaces the previous template’s texts; user texts survive', () => {
    let project = projectWithClips(2);
    project = addTextItem(project, { text: 'My own title', atTime: 0, durationSeconds: 3 });
    const first = applyFullTemplate(project, getTemplate('viral-hook-story')!).project;
    expect(first.items.some((i) => i.type === 'text' && i.text === 'WATCH THIS')).toBe(true);
    const second = applyFullTemplate(first, getTemplate('product-ad-15')!).project;
    const texts = second.items.filter((i) => i.type === 'text');
    // Viral's owned texts are gone; Product Ad's are in, marked as its own.
    expect(texts.some((i) => i.type === 'text' && i.text === 'WATCH THIS')).toBe(false);
    expect(texts.some((i) => i.type === 'text' && i.text === 'FOLLOW FOR MORE')).toBe(false);
    const owned = texts.filter((i) => i.type === 'text' && i.templateId === 'product-ad-15');
    expect(owned.length).toBeGreaterThan(0);
    expect(owned.some((i) => i.type === 'text' && i.text === 'NEW DROP')).toBe(true);
    // The user's own text is untouched by the swap.
    expect(texts.some((i) => i.type === 'text' && i.text === 'My own title' && i.templateId === undefined)).toBe(true);
    expect(second.appliedTemplate?.templateId).toBe('product-ad-15');
  });

  it('shortClips reports a source shorter than its slot, in seconds', () => {
    let project = createDefaultProject('uid-1');
    project = appendMediaToTimeline(project, videoAsset(1)); // 1s into slot 0 (2s)
    project = appendMediaToTimeline(project, videoAsset(20));
    const short = project.items.find((i) => i.type === 'video')!;
    const result = applyFullTemplate(project, getTemplate('product-ad-15')!);
    expect(result.shortClips).toHaveLength(1);
    expect(result.shortClips[0].itemId).toBe(short.id);
    expect(result.shortClips[0].clipSeconds).toBe(1);
    // 2 clips → runs [3,3]: the first clip's merged slot is 2+3+3 = 8s.
    expect(result.shortClips[0].slotSeconds).toBe(8);
    expect(result.reelEndSeconds).toBeCloseTo(1 + 7, 6); // second run 3+2+2 = 7
  });
});

describe('R42 Phase D — contract fit for later adds', () => {
  it('no contract → no-op', () => {
    const project = projectWithClips(1);
    const item = project.items[0];
    const fit = fitAddedItem(project, item.id);
    expect(fit.fitted).toBe(false);
    expect(fit.project).toBe(project);
  });

  it('a video added after apply is trimmed to its run slot and announced', () => {
    const applied = applyFullTemplate(projectWithClips(2), getTemplate('commercial-30')!).project;
    const withExtra = appendMediaToTimeline(applied, videoAsset(30));
    const extra = withExtra.items.find((i) => i.type === 'video' && !applied.items.some((p) => p.id === i.id))!;
    const fit = fitAddedItem(withExtra, extra.id);
    expect(fit.fitted).toBe(true);
    // 3 clips → runs [3,3,2]; the new clip heads run 3 (slots 6–7 = 4s).
    expect(fit.slotIndex).toBe(6);
    expect(fit.slotSeconds).toBe(4);
    const item = byId(fit.project, extra.id);
    expect(item.endTime - item.startTime).toBeCloseTo(4, 6);
    // Snapped to the end of the previous slottable item (the reel end).
    expect(item.startTime).toBeCloseTo(21, 6);
    expect(fit.shortened).toBe(true);
    expect(fit.announcement).toContain('Added to your template');
    expect(fit.announcement).toContain('trimmed to the 4s slot');
    expect(fit.project.appliedTemplate?.slotByItemId[extra.id]).toBe(6);
    // Fit and drift use the SAME mapping: the fitted item itself is
    // never flagged as unmapped or moved. (The pre-existing clips'
    // run heads DO shift when the partition changes — that is the
    // honest drift the badge offers Re-apply for.)
    const drift = templateDrift(fit.project);
    expect(drift.unmappedItemIds).not.toContain(extra.id);
    expect(drift.movedItemIds).not.toContain(extra.id);
  });

  it('an image added beyond the slot count takes the last slot’s length', () => {
    const applied = applyFullTemplate(projectWithClips(6), getTemplate('viral-hook-story')!).project;
    let withImage = appendMediaToTimeline(applied, imageAsset());
    const img0 = withImage.items.find((i) => i.type === 'image')!;
    // appendMediaToTimeline lands a photo at the start of its own
    // (empty) track; slot order is startTime-first, so place it at
    // the reel end — the position this test is about.
    withImage = updateItem(withImage, img0.id, { startTime: 16, endTime: 21 });
    const img = withImage.items.find((i) => i.type === 'image')!;
    const fit = fitAddedItem(withImage, img.id);
    expect(fit.fitted).toBe(true);
    expect(fit.slotIndex).toBe(5); // last slot (CTA, 2s)
    const item = byId(fit.project, img.id);
    expect(item.endTime - item.startTime).toBeCloseTo(2, 6);
    expect(fit.announcement).toContain('set to the 2s slot');
  });

  it('a source shorter than its slot stays whole and says so', () => {
    const applied = applyFullTemplate(projectWithClips(6), getTemplate('viral-hook-story')!).project;
    const withShort = appendMediaToTimeline(applied, videoAsset(1));
    const short = withShort.items.find((i) => i.type === 'video' && !applied.items.some((p) => p.id === i.id))!;
    const fit = fitAddedItem(withShort, short.id);
    expect(fit.fitted).toBe(true);
    expect(fit.shortSource).toBe(true);
    expect(fit.shortened).toBe(false);
    const item = byId(fit.project, short.id);
    expect(item.endTime - item.startTime).toBeCloseTo(1, 6);
    expect(fit.announcement).toContain('shorter than the 2s slot, so it stays whole');
  });

  it('PiP items are exempt from the fit', () => {
    let project = projectWithClips(1);
    project = { ...project, appliedTemplate: newTemplateContract('viral-hook-story', 7) };
    project = addPipOverlay(project, videoAsset(10), { atTime: 2 });
    const pip = project.items.find((i) => i.type === 'video' && i.pip)!;
    const fit = fitAddedItem(project, pip.id);
    expect(fit.fitted).toBe(false);
    expect(fit.project).toBe(project);
  });

  it('a start-from-template project (contract, no apply) fits its first clip to the merged run', () => {
    let project = createDefaultProject('uid-1');
    project = { ...project, appliedTemplate: newTemplateContract('viral-hook-story', 7) };
    project = appendMediaToTimeline(project, videoAsset(30));
    const clip = project.items.find((i) => i.type === 'video')!;
    const fit = fitAddedItem(project, clip.id);
    expect(fit.fitted).toBe(true);
    const item = byId(fit.project, clip.id);
    expect(item.endTime - item.startTime).toBeCloseTo(16, 6); // lone clip = whole template
  });
});

describe('R42 Phase D — drift is derived from the slot map', () => {
  it('a freshly applied project has no drift', () => {
    const applied = applyFullTemplate(projectWithClips(3), getTemplate('commercial-30')!).project;
    expect(templateDrift(applied)).toEqual({
      active: true,
      drifted: false,
      missingItemIds: [],
      unmappedItemIds: [],
      movedItemIds: [],
    });
  });

  it('deleting a slotted clip flags drift (missing), with no silent re-pack', () => {
    const applied = applyFullTemplate(projectWithClips(3), getTemplate('commercial-30')!).project;
    const victim = slottableIds(applied)[1];
    const after = removeItem(applied, victim);
    const drift = templateDrift(after);
    expect(drift.drifted).toBe(true);
    expect(drift.missingItemIds).toEqual([victim]);
    // The survivors keep their applied timings — nothing re-packed.
    const survivor = byId(after, slottableIds(applied)[0]);
    expect(survivor.endTime - survivor.startTime).toBeCloseTo(9, 6);
  });

  it('a clip added WITHOUT the fit is unmapped drift', () => {
    const applied = applyFullTemplate(projectWithClips(2), getTemplate('commercial-30')!).project;
    const withExtra = appendMediaToTimeline(applied, videoAsset(30));
    const drift = templateDrift(withExtra);
    expect(drift.drifted).toBe(true);
    expect(drift.unmappedItemIds).toHaveLength(1);
  });

  it('release clears the contract', () => {
    const applied = applyFullTemplate(projectWithClips(2), getTemplate('commercial-30')!).project;
    const released = releaseTemplate(applied);
    expect(released.appliedTemplate).toBeUndefined();
    expect(contractTemplate(released)).toBeNull();
    expect(templateDrift(released).drifted).toBe(false);
  });
});

describe('R42 Phase D — activeCaptionStyleId', () => {
  it('the contract template’s style wins while a contract is live', () => {
    const applied = applyFullTemplate(projectWithClips(1), getTemplate('music-video')!).project;
    expect(activeCaptionStyleId(applied)).toBe('karaoke-gold');
  });

  it('without a contract, the prevailing cue style wins', () => {
    let project = projectWithClips(1);
    project = addCaptionItems(project, {
      words: [{ text: 'hey', start: 0, end: 0.5 }],
      atTime: 0,
      captionStyleId: 'bold-outline',
      source: 'manual',
    });
    expect(activeCaptionStyleId(project)).toBe('bold-outline');
  });

  it('with neither, it falls back to classic', () => {
    expect(activeCaptionStyleId(projectWithClips(1))).toBe('classic');
  });
});

describe('R42 Phase D — hook restyle is scoped to the hook window', () => {
  it('cues overlapping the window restyle; cues outside keep their style', () => {
    let project = projectWithClips(1);
    project = addCaptionItems(project, {
      words: [{ text: 'inside', start: 0, end: 0.5 }],
      atTime: 0,
      captionStyleId: 'classic',
      source: 'manual',
    });
    project = addCaptionItems(project, {
      words: [{ text: 'outside', start: 0, end: 0.5 }],
      atTime: 20,
      captionStyleId: 'classic',
      source: 'manual',
    });
    const next = applyHookToProject(project, getTemplate('gold-smash-intro')!, 0); // window [0, 2.5)
    const cues = next.items.filter((i) => i.type === 'caption');
    const inside = cues.find((c) => c.type === 'caption' && c.startTime < 2.5)!;
    const outside = cues.find((c) => c.type === 'caption' && c.startTime >= 2.5)!;
    expect(inside.type === 'caption' ? inside.captionStyleId : undefined).toBe('gold-premium');
    expect(outside.type === 'caption' ? outside.captionStyleId : undefined).toBe('classic');
  });
});
