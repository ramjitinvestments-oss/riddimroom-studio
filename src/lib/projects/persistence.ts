/**
 * RiddimRoom Studio — project persistence (Step 6, Shared editor shell).
 *
 * Reads/writes `projects/{projectId}` directly through the Firebase client
 * SDK, using `serializeProject`/`parseProject` from the timeline foundation
 * for the actual shape conversion + validation. `firestore.rules` already
 * scopes this collection to `resource.data.ownerUid == request.auth.uid`
 * (read/write) and `request.resource.data.ownerUid == request.auth.uid`
 * (create) — scaffolded in Step 1, unused until now.
 *
 * Documented deviation from the roadmap's tentative suggestion of routing
 * project saves through the Express/Admin SDK backend (mirroring how
 * `/api/user/status` works): `users/{uid}` needed server-mediation because
 * role/status/quota must never be client-writable. `projects/{projectId}`
 * has no such privileged field — every field on a Project is the owning
 * user's own editorial data — so the security rule's per-document
 * ownership check is sufficient on its own, the same trust model Firestore
 * client SDKs use for any user-owned collection. Going through a server
 * route here would add a network hop and a bespoke API surface for no
 * additional security. Revisit only if a future phase adds
 * server-computed fields (e.g. moderation status) to Project.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  query,
  where,
  limit as fsLimit,
} from 'firebase/firestore';
import { ref as storageRef, deleteObject } from 'firebase/storage';
import { db, storage } from '../firebase';
import { serializeProject, parseProject } from '../timeline/serialization';
import { createEmptyProject, createTrack, addTrack } from '../timeline/utils';
import { assertValidProject } from '../timeline/validation';
import { collectProjectStoragePaths, computePathsToDelete } from './storagePaths';
import type { Project } from '../../types/timeline';

const PROJECTS_COLLECTION = 'projects';

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
  createdAt: number;
  canvasWidth: number;
  canvasHeight: number;
  /** Dashboard card cover (see `Project.posterDataUrl`) — absent on older projects. */
  posterDataUrl?: string;
}

/**
 * Builds a new Project with one track per track type already present, per
 * the roadmap's Step 6 guidance: Capture/Upload/overlay/caption steps
 * should slot items onto existing tracks via the timeline foundation's
 * utils rather than each inventing its own track-creation logic.
 *
 * `canvasWidth`/`canvasHeight` default to `createEmptyProject`'s own
 * 1080x1920 (9:16) default when omitted — callers that don't care about
 * aspect ratio (tests, older call sites) keep working unchanged. The
 * "final production" pass's aspect-ratio picker (`Dashboard.tsx`) is the
 * one real caller that now always passes an explicit size, chosen once at
 * creation from the 4 marketing-standard ratios.
 */
export function createDefaultProject(ownerUid: string, name?: string, canvasWidth?: number, canvasHeight?: number, opts?: { watermarkEnabled?: boolean }): Project {
  let project = createEmptyProject({ ownerUid, name, canvasWidth, canvasHeight });
  // v1 free default: watermark on. Lifetime users can toggle it off per project,
  // and callers that know the creator's tier (Dashboard) pass it so paid/owner
  // projects start with the watermark OFF instead of needing a manual toggle.
  project = { ...project, watermarkEnabled: opts?.watermarkEnabled ?? true };
  const trackSpecs: Array<[Project['tracks'][number]['type'], string]> = [
    ['video', 'Main Video'],
    ['image', 'Watermark'],
    ['text', 'Text'],
    ['caption', 'Captions'],
    ['audio', 'Original Audio'],
  ];
  trackSpecs.forEach(([type, trackName], index) => {
    project = addTrack(project, createTrack(type, trackName, index));
  });
  return project;
}

export async function createProject(ownerUid: string, name?: string, canvasWidth?: number, canvasHeight?: number, opts?: { watermarkEnabled?: boolean }): Promise<Project> {
  const project = createDefaultProject(ownerUid, name, canvasWidth, canvasHeight, opts);
  assertValidProject(project);
  await setDoc(doc(db, PROJECTS_COLLECTION, project.id), serializeProject(project));
  return project;
}

export async function saveProject(project: Project): Promise<Project> {
  assertValidProject(project);
  const serialized = serializeProject(project);
  await setDoc(doc(db, PROJECTS_COLLECTION, project.id), serialized);
  return { ...project, updatedAt: serialized.updatedAt };
}

export interface LoadProjectResult {
  project: Project | null;
  error?: string;
}

/** Loads a project and enforces ownership client-side too (defense in depth on top of the Firestore rule). */
export async function loadProject(projectId: string, ownerUid: string): Promise<LoadProjectResult> {
  const snapshot = await getDoc(doc(db, PROJECTS_COLLECTION, projectId));
  if (!snapshot.exists()) {
    return { project: null, error: 'Project not found.' };
  }
  const { project, structuralErrors, validation } = parseProject(snapshot.data());
  if (!project) {
    return { project: null, error: `Project data is corrupted: ${structuralErrors.join('; ')}` };
  }
  if (project.ownerUid !== ownerUid) {
    // The Firestore rule already blocks this at the network level; this is
    // a second, explicit check so a UI bug can never even attempt to render
    // another user's project data.
    return { project: null, error: 'You do not have access to this project.' };
  }
  if (validation && !validation.valid) {
    return { project: null, error: `Project failed validation: ${validation.errors.map((e) => e.message).join('; ')}` };
  }
  return { project };
}

export async function listProjects(ownerUid: string, max = 50): Promise<ProjectSummary[]> {
  // Deliberately no `orderBy('updatedAt')` in the query itself: combined
  // with `where('ownerUid', '==', ...)` on a different field, Firestore
  // would require a composite index to be created in the console before
  // this query works at all — an extra manual deployment step outside this
  // codebase. Sorting the (capped at `max`) result client-side avoids that
  // dependency; revisit if a user's project count ever makes client-side
  // sort impractical.
  const q = query(collection(db, PROJECTS_COLLECTION), where('ownerUid', '==', ownerUid), fsLimit(max));
  const snapshot = await getDocs(q);
  return snapshot.docs
    .map((docSnap) => {
      const data = docSnap.data() as Project;
      return {
        id: data.id,
        name: data.name,
        updatedAt: data.updatedAt,
        createdAt: data.createdAt,
        canvasWidth: data.canvasWidth,
        canvasHeight: data.canvasHeight,
        posterDataUrl: typeof data.posterDataUrl === 'string' ? data.posterDataUrl : undefined,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(projectId: string): Promise<void> {
  await deleteProjects([projectId]);
}

/**
 * Deletes one or more projects owned by the same user, with best-effort
 * Firebase Storage cleanup of the media only those projects referenced.
 *
 * Duplicated projects can share a single storage object (duplicate = same
 * `storageUrl`, same underlying path), so a path is deleted only when NO
 * project outside the batch references it — see
 * `computePathsToDelete` in `./storagePaths`.
 *
 * Correctness contract (storage cleanup must never break deletion or
 * another project):
 * - The Firestore documents are always deleted, even if every storage
 *   step fails.
 * - Loading the owner's other projects failing — or any one of them
 *   failing to parse — skips storage cleanup ENTIRELY: with an incomplete
 *   picture of what surviving projects reference, deleting bytes is a
 *   risk we don't take.
 * - Individual storage deletes are swallowed (`object-not-found` on media
 *   the rules/another client already removed is expected, not an error).
 */
export async function deleteProjects(projectIds: string[]): Promise<void> {
  const ids = [...new Set(projectIds)].filter(Boolean);
  if (ids.length === 0) return;
  const batch = new Set(ids);

  // 1. Load the target documents: collect their storage paths and find
  //    the owner (needed to enumerate the surviving projects). A target
  //    that fails to load contributes no paths — its bytes are orphaned,
  //    but the document is still deleted below.
  const batchPaths: string[] = [];
  let ownerUid: string | undefined;
  for (const id of ids) {
    try {
      const snapshot = await getDoc(doc(db, PROJECTS_COLLECTION, id));
      if (!snapshot.exists()) continue;
      const data = snapshot.data() as Record<string, unknown>;
      batchPaths.push(...collectProjectStoragePaths(data));
      if (!ownerUid && typeof data.ownerUid === 'string') ownerUid = data.ownerUid;
    } catch {
      // Best-effort — proceed to document deletion regardless.
    }
  }

  // 2. Load every OTHER project the owner has and compute which of the
  //    batch's paths are exclusive to the batch. Any failure here means
  //    "skip cleanup", per the contract above.
  let pathsToDelete: string[] = [];
  if (ownerUid && batchPaths.length > 0) {
    try {
      const q = query(collection(db, PROJECTS_COLLECTION), where('ownerUid', '==', ownerUid));
      const snapshot = await getDocs(q);
      const retainedPaths: string[] = [];
      for (const docSnap of snapshot.docs) {
        if (batch.has(docSnap.id)) continue;
        const { project, structuralErrors } = parseProject(docSnap.data());
        if (!project || structuralErrors.length > 0) {
          // Can't account for this surviving project's references — the
          // safe move is to keep every storage object.
          throw new Error('A surviving project could not be read; skipping storage cleanup.');
        }
        retainedPaths.push(...collectProjectStoragePaths(project));
      }
      pathsToDelete = computePathsToDelete(batchPaths, retainedPaths);
    } catch {
      pathsToDelete = [];
    }
  }

  // 3. Delete the exclusive storage objects, swallowing individual
  //    failures — the documents go next no matter what happened here.
  for (const path of pathsToDelete) {
    try {
      await deleteObject(storageRef(storage, path));
    } catch {
      // Expected for already-missing objects; never blocks deletion.
    }
  }

  // 4. Delete the documents themselves.
  for (const id of ids) {
    await deleteDoc(doc(db, PROJECTS_COLLECTION, id));
  }
}
