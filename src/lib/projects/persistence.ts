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
import { db } from '../firebase';
import { serializeProject, parseProject } from '../timeline/serialization';
import { createEmptyProject, createTrack, addTrack } from '../timeline/utils';
import { assertValidProject } from '../timeline/validation';
import type { Project } from '../../types/timeline';

const PROJECTS_COLLECTION = 'projects';

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
  createdAt: number;
  canvasWidth: number;
  canvasHeight: number;
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
export function createDefaultProject(ownerUid: string, name?: string, canvasWidth?: number, canvasHeight?: number): Project {
  let project = createEmptyProject({ ownerUid, name, canvasWidth, canvasHeight });
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

export async function createProject(ownerUid: string, name?: string, canvasWidth?: number, canvasHeight?: number): Promise<Project> {
  const project = createDefaultProject(ownerUid, name, canvasWidth, canvasHeight);
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
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProject(projectId: string): Promise<void> {
  await deleteDoc(doc(db, PROJECTS_COLLECTION, projectId));
}
