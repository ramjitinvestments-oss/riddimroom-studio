/**
 * R40 P-53 — Dashboard project library helpers (pure).
 *
 * Search filters the project list by name (case-insensitive, partial
 * match, surrounding spaces ignored); an empty search returns the
 * list untouched. Rename goes through the same name rule the editor
 * header uses in practice: the name is trimmed, and a blank name is
 * not a name — the Dashboard's rename dialog keeps the old name
 * instead of saving a blank one.
 */

export function filterProjectsByName<T extends { name: string }>(projects: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return projects;
  return projects.filter((project) => project.name.toLowerCase().includes(needle));
}

/** The name a rename would save, or null when the typed name is blank. */
export function cleanedProjectName(raw: string): string | null {
  const name = raw.trim();
  return name ? name : null;
}
