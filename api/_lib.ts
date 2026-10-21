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
import firebaseConfig from '../firebase-applet-config.json';
import type { UserProfile } from '../src/types/user.js';

const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || firebaseConfig.projectId;
const WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY || firebaseConfig.apiKey;
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const IDENTITY_BASE = 'https://identitytoolkit.googleapis.com/v1';

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

// ---------------------------------------------------------------------------
// License tier + kill-switch (same semantics as the Admin implementation).
// ---------------------------------------------------------------------------

export const DEFAULT_DAILY_QUOTA = 2;
export const LIFETIME_DAILY_QUOTA = 10;

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

export function toClientUser(data: UserProfile, licenseTier: 'free' | 'lifetime' = 'free') {
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
  };
}
