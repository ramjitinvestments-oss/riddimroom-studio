import { describe, it, expect } from 'vitest';
import { buildSoundGuide } from './socialPosts';

describe('buildSoundGuide (R17)', () => {
  it('gives the native-sound workflow honestly', () => {
    const steps = buildSoundGuide();
    expect(steps.length).toBeGreaterThanOrEqual(3);
    const all = steps.join(' ');
    expect(all).toContain('Add sound');
    expect(all).toMatch(/rights/);
  });
});
