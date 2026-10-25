import { describe, it, expect } from 'vitest';
import * as loops from './loops';

describe('built-in loops (R20)', () => {
  it('stay removed — the module exports nothing', () => {
    expect(Object.keys(loops)).toHaveLength(0);
  });
});
