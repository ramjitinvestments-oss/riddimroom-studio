/**
 * RiddimRoom Studio — timeline serialization.
 *
 * Converts between a `Project` (the TypeScript shape the app works with)
 * and a Firestore-safe plain-object shape (what actually gets written to /
 * read from a `projects/{projectId}` document). Kept separate from
 * `validation.ts` on purpose: serialization is about shape safety
 * (Firestore rejects `undefined`, disallows raw nested arrays, etc.),
 * validation is about business-rule correctness. A caller typically wants
 * both — see `parseProject` below — but they're independently testable and
 * independently reusable (e.g. the future storage layer will serialize on
 * every save, but only needs to validate on load or on explicit user save).
 *
 * No Firebase SDK import here deliberately: this module produces/consumes
 * plain JSON-serializable objects, so it has zero dependency on whether the
 * caller is the Firebase client SDK, the Admin SDK (server.ts), or a plain
 * test script. Wiring this into an actual `projects/{id}` Firestore read/
 * write path is Step 3 (Shared storage) work, not part of this foundation.
 */

import type { Project } from '../../types/timeline';
import { validateProject, type ValidationResult } from './validation';

/** The plain-object shape written to/read from Firestore. Structurally identical to Project. */
export type FirestoreProjectData = Project;

/**
 * Project -> Firestore-safe plain object. Round-tripping through
 * `JSON.stringify`/`JSON.parse` does two things Firestore needs in one
 * step: it produces a fresh deep clone (no shared references back to the
 * input, so later mutating the input can't corrupt an already-"saved"
 * snapshot), and it drops every key whose value is `undefined` (JSON has no
 * `undefined` type, so `JSON.stringify` omits such keys entirely) — which
 * is exactly the shape Firestore requires, since it rejects a field that is
 * explicitly `undefined` but is fine with the key simply being absent.
 * Updates `updatedAt` to `now` unless the caller passes one explicitly
 * (tests pass a fixed value for determinism).
 */
export function serializeProject(project: Project, now: number = Date.now()): FirestoreProjectData {
  const withTimestamp: Project = { ...project, updatedAt: now };
  return JSON.parse(JSON.stringify(withTimestamp)) as Project;
}

export interface DeserializeResult {
  project: Project | null;
  errors: string[];
}

/**
 * Firestore document data -> Project, with structural sanity checks before
 * the cast — this is the boundary where "data of unknown provenance" (a
 * document that could have been hand-edited in the Firebase console, or
 * written by a future buggy client) becomes a value the rest of the app
 * trusts to have the right shape. It intentionally does NOT run full
 * `validateProject` business-rule validation — callers that need that
 * should call `parseProject` instead, which runs both stages.
 */
export function deserializeProject(data: unknown): DeserializeResult {
  const errors: string[] = [];

  if (data === null || typeof data !== 'object') {
    return { project: null, errors: ['Document data must be an object.'] };
  }
  const record = data as Record<string, unknown>;

  const requiredStringFields = ['id', 'ownerUid', 'name'] as const;
  for (const field of requiredStringFields) {
    if (typeof record[field] !== 'string') errors.push(`Missing or non-string required field "${field}".`);
  }
  const requiredNumberFields = ['schemaVersion', 'canvasWidth', 'canvasHeight', 'frameRate', 'createdAt', 'updatedAt'] as const;
  for (const field of requiredNumberFields) {
    if (typeof record[field] !== 'number' || !Number.isFinite(record[field] as number)) {
      errors.push(`Missing or non-numeric required field "${field}".`);
    }
  }
  if (!Array.isArray(record.tracks)) errors.push('Missing or non-array field "tracks".');
  if (!Array.isArray(record.items)) errors.push('Missing or non-array field "items".');
  if (record.mediaAssets === undefined || record.mediaAssets === null || typeof record.mediaAssets !== 'object') {
    errors.push('Missing or non-object field "mediaAssets".');
  }

  if (errors.length > 0) {
    return { project: null, errors };
  }

  return { project: record as unknown as Project, errors: [] };
}

export interface ParseProjectResult {
  project: Project | null;
  /** Structural (shape) errors from deserialization, if any. */
  structuralErrors: string[];
  /** Business-rule errors from validateProject, if the document was at least structurally sound. */
  validation: ValidationResult | null;
}

/**
 * Full boundary check: deserialize, then validate. This is what a future
 * "load project" code path should call — structural errors and business-
 * rule errors are kept in separate fields so a caller can tell "this isn't
 * even shaped like a Project" apart from "this is shaped right but has bad
 * data in it" (e.g. for different user-facing error messages).
 */
export function parseProject(data: unknown): ParseProjectResult {
  const { project, errors: structuralErrors } = deserializeProject(data);
  if (!project) {
    return { project: null, structuralErrors, validation: null };
  }
  const validation = validateProject(project);
  return {
    project: validation.valid ? project : null,
    structuralErrors: [],
    validation,
  };
}
