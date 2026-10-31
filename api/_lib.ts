/**
 * RiddimRoom Studio — shared helpers for the Vercel serverless API.
 *
 * AUTH/DATA MODEL (changed 2026-10-21): these functions deliberately do
 * NOT use the Firebase Admin SDK. There is no service-account key to
 * configure — an earlier rollout stalled for days because the key's value
 * could not be pasted into the Vercel dashboard reliably. Instead:
 *
 *  - ID tokens are verified with the Identity Toolkit REST API
 *    (accounts:lookup), authorized by the project's public web API key —
 *    the same key that ships in the client bundle (firebase-applet-config.json).
 *  - All Firestore access goes through the Firestore REST API *as the
 *    calling user* (the request's own ID token is the credential), so
 *    firestore.rules is the enforcement layer: users can only read/write
 *    their own users/{uid} document, and privileged fields on it (role,
 *    status, subscription, plan) are frozen by rule. License/admin checks
 *    read licenses/{uid} and admins/{uid}, both owner-readable, never
 *    client-writable.
 *
 * Trade-offs vs the Admin model, accepted for the personal-first v1:
 *  - Quota counters are read-modify-write (not atomic increments) and a
 *    determined user could reset their own counter with a hand-crafted
 *    client write; the daily limit is a soft gate until the sellable
 *    phase hardens it (server-held credential / App Check).
 *  - server.ts (the Express backend) still uses the Admin SDK and remains
 *    the reference for self-hosting with a service account; behavior of
 *    the /api/* surface (routes, status codes, response shapes, quota
 *    constants) is kept identical to it.
 *
 * Files prefixed with "_" are not routes on Vercel.
 */
import type { UserProfile } from '../src/types/user.js';

// The project's PUBLIC web config (the same values ship in the client
// bundle from firebase-applet-config.json — a web API key is an
// identifier, not a secret). Inlined rather than imported: the Vercel
// Node ESM runtime refuses a bare JSON module import and the function
// crashed at load. Keep in sync with firebase-applet-config.json; either
// value can be overridden by env var.
const FIREBASE_WEB_CONFIG = {
  projectId: 'riddimroom-studio',
  apiKey: 'AIzaSyAhayje6Rz_ZZZArhgqBw8ejX-8qZ6oxpU',
};

const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || FIREBASE_WEB_CONFIG.projectId;
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || FIREBASE_WEB_CONFIG.apiKey;
// Service base URLs default to the production Google endpoints. They can
// be overridden wholesale by env var (full base URL, same shape as the
// default) — used only to point local test harnesses at the Firebase
// emulators; production never sets these.
const FIRESTORE_BASE =
  process.env.FIREBASE_FIRESTORE_BASE ||
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const IDENTITY_BASE = process.env.FIREBASE_IDENTITY_BASE || 'https://identitytoolkit.googleapis.com/v1';

/** Minimal request/response shapes (Vercel Node runtime provides these). */
export interface ApiRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}
export interface ApiResponse {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
}

/** The verified caller, resolved from their Firebase ID token. */
export interface AuthedUser {
  uid: string;
  email: string;
  name?: string;
  picture?: string;
  provider: string;
  /** The caller's ID token — the credential for all Firestore REST calls. */
  idToken: string;
}

/**
 * Verify the Firebase ID token from the Authorization header: on failure
 * this writes the same 401 responses server.ts's middleware writes and
 * returns null.
 */
export async function verifyRequest(req: ApiRequest, res: ApiResponse): Promise<AuthedUser | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Missing or malformed Authorization header' });
    return null;
  }
  const idToken = authHeader.slice('Bearer '.length);
  try {
    const resp = await fetch(`${IDENTITY_BASE}/accounts:lookup?key=${WEB_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    if (!resp.ok) {
      const detail = (await resp.json().catch(() => null)) as { error?: { message?: string } } | null;
      console.warn('[auth] Token verification failed:', detail?.error?.message || resp.status);
      res.status(401).json({ success: false, error: 'Invalid or expired authentication token' });
      return null;
    }
    const data = (await resp.json()) as {
      users?: Array<{
        localId: string;
        email?: string;
        displayName?: string;
        photoUrl?: string;
        providerUserInfo?: Array<{ providerId?: string }>;
      }>;
    };
    const user = data.users?.[0];
    if (!user?.localId) {
      res.status(401).json({ success: false, error: 'Invalid or expired authentication token' });
      return null;
    }
    return {
      uid: user.localId,
      email: user.email || '',
      name: user.displayName,
      picture: user.photoUrl,
      provider: user.providerUserInfo?.[0]?.providerId || 'password',
      idToken,
    };
  } catch (err: any) {
    console.warn('[auth] Token verification failed:', err?.message || err);
    res.status(401).json({ success: false, error: 'Invalid or expired authentication token' });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Firestore REST access, always as the calling user.
// ---------------------------------------------------------------------------

type FirestoreValue =
  | { nullValue: null }
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { timestampValue: string }
  | { arrayValue: { values: FirestoreValue[] } }
  | { mapValue: { fields: Record<string, FirestoreValue> } };

/** Marker: write the current time as a Firestore timestamp. */
export const SERVER_TIMESTAMP = '__SERVER_TIMESTAMP__';

function toFirestoreValue(value: unknown): FirestoreValue {
  if (value === SERVER_TIMESTAMP) return { timestampValue: new Date().toISOString() };
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (typeof value === 'object') {
    const fields: Record<string, FirestoreValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) fields[k] = toFirestoreValue(v);
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function fromFirestoreValue(value: FirestoreValue): unknown {
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in value) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value.mapValue.fields || {})) out[k] = fromFirestoreValue(v);
    return out;
  }
  return null;
}

export interface FsDoc {
  exists: boolean;
  data: Record<string, unknown>;
}

/** Read one document as the calling user. 404 → { exists: false }. */
export async function fsGetDoc(path: string, idToken: string): Promise<FsDoc> {
  const resp = await fetch(`${FIRESTORE_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (resp.status === 404) return { exists: false, data: {} };
  if (!resp.ok) {
    throw new Error(`Firestore GET ${path} failed: ${resp.status} ${(await resp.text().catch(() => '')).slice(0, 200)}`);
  }
  const doc = (await resp.json()) as { fields?: Record<string, FirestoreValue> };
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc.fields || {})) data[k] = fromFirestoreValue(v);
  return { exists: true, data };
}

/**
 * Create-or-update selected fields of one document as the calling user
 * (Firestore REST PATCH upserts when the document does not exist yet).
 */
export async function fsPatchDoc(
  path: string,
  fields: Record<string, unknown>,
  idToken: string,
): Promise<void> {
  const mask = Object.keys(fields)
    .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
    .join('&');
  const body = {
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toFirestoreValue(v)])),
  };
  const resp = await fetch(`${FIRESTORE_BASE}/${path}?${mask}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Firestore PATCH ${path} failed: ${resp.status} ${(await resp.text().catch(() => '')).slice(0, 200)}`);
  }
}

export interface FsListedDoc extends FsDoc {
  id: string;
}

/**
 * List every document in a collection as the calling user (Firestore REST
 * list, following nextPageToken to the end). Used by the admin endpoints —
 * firestore.rules is what actually lets an admin read other users' docs;
 * a non-admin caller simply gets a rules-denied error from Firestore.
 */
export async function fsListDocs(collection: string, idToken: string): Promise<FsListedDoc[]> {
  const out: FsListedDoc[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ pageSize: '300' });
    if (pageToken) params.set('pageToken', pageToken);
    const resp = await fetch(`${FIRESTORE_BASE}/${collection}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!resp.ok) {
      throw new Error(`Firestore LIST ${collection} failed: ${resp.status} ${(await resp.text().catch(() => '')).slice(0, 200)}`);
    }
    const page = (await resp.json()) as {
      documents?: Array<{ name: string; fields?: Record<string, FirestoreValue> }>;
      nextPageToken?: string;
    };
    for (const doc of page.documents || []) {
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(doc.fields || {})) data[k] = fromFirestoreValue(v);
      out.push({ id: doc.name.split('/').pop() || '', exists: true, data });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/** Create a document with a Firestore-generated id; returns the new id. */
export async function fsCreateDoc(
  collection: string,
  fields: Record<string, unknown>,
  idToken: string,
): Promise<string> {
  const body = {
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toFirestoreValue(v)])),
  };
  const resp = await fetch(`${FIRESTORE_BASE}/${collection}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Firestore POST ${collection} failed: ${resp.status} ${(await resp.text().catch(() => '')).slice(0, 200)}`);
  }
  const doc = (await resp.json()) as { name?: string };
  return (doc.name || '').split('/').pop() || '';
}

// ---------------------------------------------------------------------------
// License tier + kill-switch (same semantics as the Admin implementation).
// ---------------------------------------------------------------------------

export const DEFAULT_DAILY_QUOTA = 2;
export const LIFETIME_DAILY_QUOTA = 10;

/** Daily transcription quota for a license tier (lifetime 10, otherwise 2). */
export function dailyTranscribeQuota(tier: 'free' | 'lifetime'): number {
  return tier === 'lifetime' ? LIFETIME_DAILY_QUOTA : DEFAULT_DAILY_QUOTA;
}

/**
 * Transcription access gate (pure): null when the caller may transcribe
 * (admins are never gated by status; approved accounts pass), otherwise
 * the exact error message the transcribe handler returns with a 403.
 */
export function transcribeGateError(status: string, isAdmin: boolean): string | null {
  if (isAdmin || status === 'approved') return null;
  if (status === 'pending') {
    return "Your access isn't switched on yet — transcription is available once the owner approves your account.";
  }
  return 'Account access restricted';
}

export async function getLicenseTier(uid: string, idToken: string): Promise<'free' | 'lifetime'> {
  try {
    const license = await fsGetDoc(`licenses/${uid}`, idToken);
    if (license.exists) {
      const data = license.data as { tier?: string; active?: boolean };
      if (data.tier === 'lifetime' && data.active !== false) return 'lifetime';
    }
    // Admin/owner grant: admins/{uid} resolves to the lifetime tier so the
    // studio owner is never bitten by free-tier gates.
    const adminDoc = await fsGetDoc(`admins/${uid}`, idToken);
    if (adminDoc.exists) return 'lifetime';
    return 'free';
  } catch {
    return 'free';
  }
}

export async function isGlobalDisabled(idToken: string): Promise<boolean> {
  try {
    const doc = await fsGetDoc('config/global', idToken);
    return doc.exists && (doc.data as { disabled?: boolean }).disabled === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Phase 2 (Plan v5) — owner toggle access, split by R28 into three states:
// 'pending' (status pending, license inactive), 'basic' (status approved,
// license tier 'free' active) and 'premium' (status approved, license tier
// 'lifetime' active — the original Phase 2 approve behaviour, writing the
// SAME entitlement records a Stripe webhook writes later). Every state
// change writes licenses/{uid}, the users/{uid} status flag and an
// approvals log entry, so manual access and paid access are
// indistinguishable to the app.
// ---------------------------------------------------------------------------

/** True when admins/{uid} exists for this caller. */
export async function isAdminUser(uid: string, idToken: string): Promise<boolean> {
  try {
    return (await fsGetDoc(`admins/${uid}`, idToken)).exists;
  } catch {
    return false;
  }
}

export class AccessToggleError extends Error {
  code: 'NOT_ADMIN' | 'USER_NOT_FOUND';
  constructor(code: 'NOT_ADMIN' | 'USER_NOT_FOUND', message: string) {
    super(message);
    this.code = code;
  }
}

/** R28: the three access states — access is split from tier. */
export type AccessState = 'pending' | 'basic' | 'premium';

/**
 * The ONE canonical derivation of access state: 'pending' unless the
 * user status is 'approved'; then 'premium' for a lifetime license,
 * otherwise 'basic' (approved on the free tier).
 */
export function accessStateFor(status: string, licenseTier: 'free' | 'lifetime'): AccessState {
  if (status !== 'approved') return 'pending';
  return licenseTier === 'lifetime' ? 'premium' : 'basic';
}

export interface AccessToggleWrites {
  licensePath: string;
  licenseFields: Record<string, unknown>;
  userPath: string;
  userFields: Record<string, unknown>;
  logCollection: string;
  logFields: Record<string, unknown>;
}

/**
 * The exact writes a toggle performs (pure — unit-tested in
 * src/lib/adminAccess.test.ts). 'basic' grants an active free license,
 * 'premium' grants an active lifetime license (both approve the user);
 * 'pending' only deactivates the license (the document and its tier
 * stay, so a later re-grant is a flag flip, and the record of the grant
 * survives) and returns the user to 'pending'.
 */
export function buildAccessToggleWrites(
  targetUid: string,
  targetEmail: string,
  state: AccessState,
  callerUid: string,
): AccessToggleWrites {
  if (state === 'basic') {
    return {
      licensePath: `licenses/${targetUid}`,
      licenseFields: {
        tier: 'free',
        active: true,
        source: 'tester-basic',
        grantedBy: callerUid,
        updatedAt: SERVER_TIMESTAMP,
      },
      userPath: `users/${targetUid}`,
      userFields: { status: 'approved' },
      logCollection: 'approvals',
      logFields: {
        uid: targetUid,
        email: targetEmail,
        action: 'basic',
        source: 'tester-basic',
        by: callerUid,
        at: SERVER_TIMESTAMP,
      },
    };
  }
  if (state === 'premium') {
    return {
      licensePath: `licenses/${targetUid}`,
      licenseFields: {
        tier: 'lifetime',
        active: true,
        source: 'tester-premium',
        grantedBy: callerUid,
        updatedAt: SERVER_TIMESTAMP,
      },
      userPath: `users/${targetUid}`,
      userFields: { status: 'approved' },
      logCollection: 'approvals',
      logFields: {
        uid: targetUid,
        email: targetEmail,
        action: 'premium',
        source: 'tester-premium',
        by: callerUid,
        at: SERVER_TIMESTAMP,
      },
    };
  }
  return {
    licensePath: `licenses/${targetUid}`,
    licenseFields: {
      active: false,
      source: 'manual-toggle',
      updatedAt: SERVER_TIMESTAMP,
    },
    userPath: `users/${targetUid}`,
    userFields: { status: 'pending' },
    logCollection: 'approvals',
    logFields: {
      uid: targetUid,
      email: targetEmail,
      action: 'revoked',
      by: callerUid,
      at: SERVER_TIMESTAMP,
    },
  };
}

export interface AdminUserSummary {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string | null;
  createdAt: string | null;
  status: string;
  plan: string;
  subscription: string;
  marketingOptIn: boolean;
  licenseTier: 'free' | 'lifetime';
  accessState: AccessState;
}

function toAdminUserSummary(data: Record<string, unknown>, licenseTier: 'free' | 'lifetime'): AdminUserSummary {
  return {
    uid: String(data.uid || ''),
    email: String(data.email || ''),
    displayName: String(data.displayName || ''),
    photoURL: (data.photoURL as string | null) ?? null,
    createdAt: (data.createdAt as string | null) ?? null,
    status: String(data.status || ''),
    plan: String(data.plan || ''),
    subscription: String(data.subscription || ''),
    marketingOptIn: data.marketingOptIn === true,
    licenseTier,
    accessState: accessStateFor(String(data.status || ''), licenseTier),
  };
}

/**
 * Every signup, newest first, with each user's license tier resolved from
 * licenses/{uid} (and the admins grant). Admin-gated: throws
 * AccessToggleError('NOT_ADMIN') before reading anything when the caller
 * has no admins/{uid} doc.
 */
export async function fetchAdminUsers(callerUid: string, idToken: string): Promise<AdminUserSummary[]> {
  if (!(await isAdminUser(callerUid, idToken))) {
    throw new AccessToggleError('NOT_ADMIN', 'Admin access required.');
  }
  const [userDocs, licenseDocs, adminDocs] = await Promise.all([
    fsListDocs('users', idToken),
    fsListDocs('licenses', idToken),
    fsListDocs('admins', idToken),
  ]);
  const licenseByUid = new Map(licenseDocs.map((d) => [d.id, d.data]));
  const adminIds = new Set(adminDocs.map((d) => d.id));
  const summaries = userDocs.map((doc) => {
    const license = licenseByUid.get(doc.id) as { tier?: string; active?: boolean } | undefined;
    const tier: 'free' | 'lifetime' =
      (license && license.tier === 'lifetime' && license.active !== false) || adminIds.has(doc.id)
        ? 'lifetime'
        : 'free';
    return toAdminUserSummary({ ...doc.data, uid: doc.data.uid || doc.id }, tier);
  });
  // Newest signup first; undated docs (pre-schema) sink to the end.
  summaries.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return summaries;
}

/**
 * Perform one toggle: verify the caller is an admin (throws NOT_ADMIN and
 * writes NOTHING otherwise), resolve the target's email for the approvals
 * log, then license write → status write → log entry, in that order.
 * Returns the target's post-toggle summary.
 */
export async function applyAccessToggle(
  callerUid: string,
  targetUid: string,
  state: AccessState,
  idToken: string,
): Promise<AdminUserSummary> {
  if (!(await isAdminUser(callerUid, idToken))) {
    throw new AccessToggleError('NOT_ADMIN', 'Admin access required.');
  }
  const target = await fsGetDoc(`users/${targetUid}`, idToken);
  if (!target.exists) {
    throw new AccessToggleError('USER_NOT_FOUND', 'User not found.');
  }
  const writes = buildAccessToggleWrites(targetUid, String(target.data.email || ''), state, callerUid);
  await fsPatchDoc(writes.licensePath, writes.licenseFields, idToken);
  await fsPatchDoc(writes.userPath, writes.userFields, idToken);
  await fsCreateDoc(writes.logCollection, writes.logFields, idToken);
  const licenseTier = await getLicenseTier(targetUid, idToken);
  return toAdminUserSummary(
    { ...target.data, uid: targetUid, status: writes.userFields.status },
    licenseTier,
  );
}

export function toClientUser(data: UserProfile, licenseTier: 'free' | 'lifetime' = 'free', isAdmin = false) {
  // Server is the single source of truth for role/status/quota — the client
  // never sets these directly (firestore.rules freezes the privileged
  // fields on users/{uid}).
  return {
    uid: data.uid,
    email: data.email,
    displayName: data.displayName,
    photoURL: data.photoURL,
    provider: data.provider,
    role: data.role,
    status: data.status,
    dailyCount: data.dailyCount,
    maxFree: licenseTier === 'lifetime' ? LIFETIME_DAILY_QUOTA : DEFAULT_DAILY_QUOTA,
    totalTranscribes: data.totalTranscribes,
    captureCount: data.captureCount,
    photoCount: data.photoCount,
    videoCount: data.videoCount,
    subscription: data.subscription,
    plan: data.plan,
    licenseTier,
    isAdmin,
    marketingOptIn: data.marketingOptIn === true,
  };
}

// ---------------------------------------------------------------------------
// R40 P-28 — first-party failure counts.
//
// The app records COUNTS ONLY of final failures — how many exports,
// saves and caption jobs failed per day — in failureCounts/{day}
// documents shaped { export, save, transcribe } (plain numbers). No
// user content, no project data, no uid: a count cannot be traced
// back to a person or a project. The write mirrors the transcription
// quota's read-modify-write-as-the-calling-user pattern above.
//
// RULES NOTE: the published firestore.rules currently have no branch
// for this collection (default-deny), so until the release session
// publishes a branch for it, writes are refused by Firestore and the
// endpoint answers "recorded: false" — the client is fire-and-forget
// and silent either way, and counts simply begin flowing when the
// rules land. Nothing here invents a way around the rules.
// ---------------------------------------------------------------------------

export type FailureKind = 'export' | 'save' | 'transcribe';

export const FAILURE_COUNT_KINDS: readonly FailureKind[] = ['export', 'save', 'transcribe'];

export function isFailureKind(value: unknown): value is FailureKind {
  return value === 'export' || value === 'save' || value === 'transcribe';
}

/** The storage day for a moment: its UTC calendar day, YYYY-MM-DD. */
export function failureDayKey(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export interface FailureDayCounts {
  day: string;
  export: number;
  save: number;
  transcribe: number;
  total: number;
}

function countOf(data: Record<string, unknown>, kind: FailureKind): number {
  const v = data[kind];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Pure: the full field set to write after one more `kind` failure, given the stored fields. */
export function buildFailureIncrement(
  existing: Record<string, unknown>,
  kind: FailureKind,
): { export: number; save: number; transcribe: number } {
  return {
    export: countOf(existing, 'export') + (kind === 'export' ? 1 : 0),
    save: countOf(existing, 'save') + (kind === 'save' ? 1 : 0),
    transcribe: countOf(existing, 'transcribe') + (kind === 'transcribe' ? 1 : 0),
  };
}

export interface FailureCountsSummary {
  today: FailureDayCounts;
  last7Days: { export: number; save: number; transcribe: number; total: number };
  days: FailureDayCounts[];
}

/** Pure: fold stored day documents into today + last-7-days totals (newest day first). */
export function summarizeFailureCounts(
  docs: Array<Record<string, unknown> & { day: string }>,
  now: Date = new Date(),
): FailureCountsSummary {
  const todayKey = failureDayKey(now);
  const windowStart = failureDayKey(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000));
  const byDay = new Map<string, FailureDayCounts>();
  for (const doc of docs) {
    if (typeof doc.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.day)) continue;
    const row: FailureDayCounts = {
      day: doc.day,
      export: countOf(doc, 'export'),
      save: countOf(doc, 'save'),
      transcribe: countOf(doc, 'transcribe'),
      total: 0,
    };
    row.total = row.export + row.save + row.transcribe;
    byDay.set(doc.day, row);
  }
  const days = [...byDay.values()]
    .filter((d) => d.day >= windowStart && d.day <= todayKey)
    .sort((a, b) => b.day.localeCompare(a.day));
  const last7Days = { export: 0, save: 0, transcribe: 0, total: 0 };
  for (const d of days) {
    last7Days.export += d.export;
    last7Days.save += d.save;
    last7Days.transcribe += d.transcribe;
    last7Days.total += d.total;
  }
  const today = byDay.get(todayKey) ?? { day: todayKey, export: 0, save: 0, transcribe: 0, total: 0 };
  return { today, last7Days, days };
}

/**
 * Record one failure as the calling user (read-modify-write, the
 * quota pattern). Throws when Firestore refuses — the endpoint turns
 * that into a quiet "recorded: false", never a user-facing error.
 */
export async function recordFailureCount(kind: FailureKind, idToken: string, now: Date = new Date()): Promise<void> {
  const day = failureDayKey(now);
  const path = `failureCounts/${day}`;
  const existing = await fsGetDoc(path, idToken);
  await fsPatchDoc(path, buildFailureIncrement(existing.data, kind), idToken);
}

/** Admin readout: every stored day, summarized. Refuses non-admins before listing anything. */
export async function fetchFailureCounts(callerUid: string, idToken: string): Promise<FailureCountsSummary> {
  if (!(await isAdminUser(callerUid, idToken))) {
    throw new AccessToggleError('NOT_ADMIN', 'Admin access required.');
  }
  const docs = await fsListDocs('failureCounts', idToken);
  return summarizeFailureCounts(docs.map((d) => ({ ...d.data, day: d.id })));
}
