/**
 * R42 Phase B — the project recycle bin's pure contracts: the 30-day
 * retention math and the deletedAt field's round-trip through the
 * same serialization every save/load uses (a trashed project must
 * stay a valid Project document, and restoring must remove the
 * stamp cleanly — serializeProject drops undefined keys).
 */
import { describe, it, expect } from 'vitest';
import { createDefaultProject, isTrashExpired, PROJECT_TRASH_RETENTION_MS } from './persistence';
import { serializeProject, parseProject } from '../timeline/serialization';

const DAY = 24 * 60 * 60 * 1000;

describe('R42 recycle bin — retention', () => {
  it('retention is exactly 30 days', () => {
    expect(PROJECT_TRASH_RETENTION_MS).toBe(30 * DAY);
  });

  it('a project is restorable through day 30 and expired after it', () => {
    const deletedAt = 1_000_000_000;
    expect(isTrashExpired(deletedAt, deletedAt + 29 * DAY)).toBe(false);
    expect(isTrashExpired(deletedAt, deletedAt + 30 * DAY)).toBe(false);
    expect(isTrashExpired(deletedAt, deletedAt + 30 * DAY + 1)).toBe(true);
  });
});

describe('R42 recycle bin — deletedAt round-trips as project data', () => {
  it('a trashed project serializes with its stamp and parses back with it', () => {
    const project = { ...createDefaultProject('owner-1', 'Trashed'), deletedAt: 123456789 };
    const roundTripped = parseProject(serializeProject(project, 999));
    expect(roundTripped.project?.deletedAt).toBe(123456789);
    expect(roundTripped.structuralErrors).toEqual([]);
    expect(roundTripped.validation?.valid).toBe(true);
  });

  it('a live project has no stamp, and clearing the stamp restores cleanly', () => {
    const live = createDefaultProject('owner-1', 'Live');
    expect('deletedAt' in serializeProject(live, 999)).toBe(false);
    const restored = { ...live, deletedAt: undefined };
    expect('deletedAt' in serializeProject(restored, 999)).toBe(false);
  });
});
