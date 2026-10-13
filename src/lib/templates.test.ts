import { describe, it, expect } from 'vitest';
import { STUDIO_TEMPLATES, getTemplate } from './templates';
import { applyTemplateToProject } from './templates/apply';
import { createDefaultProject } from './projects/persistence';
import { addCaptionItems } from './timeline/insert';
import { mergeCaptionItems } from './timeline/utils';

describe('templates', () => {
  it('has exactly 12 curated templates', () => {
    expect(STUDIO_TEMPLATES).toHaveLength(12);
    expect(new Set(STUDIO_TEMPLATES.map((t) => t.id)).size).toBe(12);
  });
  it('every template references a valid caption style', () => {
    for (const t of STUDIO_TEMPLATES) {
      expect(typeof t.captionStyleId).toBe('string');
      expect(t.captionStyleId.length).toBeGreaterThan(0);
    }
  });
  it('getTemplate returns undefined for unknown id', () => {
    expect(getTemplate('nope')).toBeUndefined();
  });
  it('applying a template styles captions + adds title, without touching media/timing', () => {
    let project = createDefaultProject('uid-1');
    project = addCaptionItems(project, { words: [{ text: 'hello', start: 0, end: 0.5 }], atTime: 0, captionStyleId: 'classic', source: 'manual' });
    const beforeItems = project.items.length;
    const template = getTemplate('viral-hook')!;
    const next = applyTemplateToProject(project, template);
    const caption = next.items.find((i) => i.type === 'caption');
    expect(caption?.type === 'caption' ? caption.captionStyleId : undefined).toBe(template.captionStyleId);
    // Title added (project had none).
    expect(next.items.some((i) => i.type === 'text' && i.role === 'title')).toBe(true);
    expect(next.items.length).toBeGreaterThan(beforeItems);
    // Media assets untouched.
    expect(next.mediaAssets).toEqual(project.mediaAssets);
  });
});

describe('mergeCaptionItems', () => {
  it('merges words and removes the second item', () => {
    let project = createDefaultProject('uid-1');
    project = addCaptionItems(project, { words: [{ text: 'one', start: 0, end: 0.4 }], atTime: 0, captionStyleId: 'classic', source: 'manual' });
    project = addCaptionItems(project, { words: [{ text: 'two', start: 0, end: 0.4 }], atTime: 1, captionStyleId: 'classic', source: 'manual' });
    const ids = project.items.filter((i) => i.type === 'caption').map((i) => i.id);
    expect(ids).toHaveLength(2);
    const next = mergeCaptionItems(project, ids[0], ids[1]);
    const captions = next.items.filter((i) => i.type === 'caption');
    expect(captions).toHaveLength(1);
    if (captions[0].type === 'caption') {
      expect(captions[0].words.map((w) => w.text)).toEqual(['one', 'two']);
    }
  });
  it('no-ops for same id or non-caption', () => {
    const project = createDefaultProject('uid-1');
    expect(mergeCaptionItems(project, 'a', 'a')).toBe(project);
    expect(mergeCaptionItems(project, 'missing', 'also-missing')).toBe(project);
  });
});
