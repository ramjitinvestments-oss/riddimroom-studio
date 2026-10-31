import { describe, expect, it } from 'vitest';
import { cleanedProjectName, filterProjectsByName } from './library';

const projects = [
  { id: '1', name: 'Summer Jam Promo' },
  { id: '2', name: 'church service' },
  { id: '3', name: 'SUMMER Sale' },
];

describe('R40 P-53 — Dashboard project search', () => {
  it('filters by name, case-insensitively and partially', () => {
    expect(filterProjectsByName(projects, 'summer').map((p) => p.id)).toEqual(['1', '3']);
    expect(filterProjectsByName(projects, 'CHURCH').map((p) => p.id)).toEqual(['2']);
    expect(filterProjectsByName(projects, ' jam ').map((p) => p.id)).toEqual(['1']);
  });

  it('an empty or blank search returns the whole list', () => {
    expect(filterProjectsByName(projects, '')).toBe(projects);
    expect(filterProjectsByName(projects, '   ')).toBe(projects);
  });

  it('a search with no match returns an empty list', () => {
    expect(filterProjectsByName(projects, 'birthday')).toEqual([]);
  });
});

describe('R40 P-53 — rename name rule', () => {
  it('trims the typed name', () => {
    expect(cleanedProjectName('  My Film  ')).toBe('My Film');
  });

  it('a blank name is not saveable', () => {
    expect(cleanedProjectName('   ')).toBeNull();
    expect(cleanedProjectName('')).toBeNull();
  });
});
