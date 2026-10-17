/**
 * RiddimRoom Studio — shared helpers for the Vercel serverless API.
 *
 * These functions mirror server.ts (the Express backend) exactly — same
 * Firebase Admin initialization, same token verification behavior, same
 * license-tier resolution and quota constants — so the /api/* surface
 * behaves identically whether it is served by the Express app (Cloud Run /
 * Render) or by these Vercel functions. server.ts remains the reference
 * implementation; keep the two in sync when route logic changes.
 *
 * Files prefixed with "_" are not routes on Vercel.
 */
import { initializeApp, getApps, applicationDefault, cert, type App } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import type { UserProfile } from '../src/types/user.js';

let cachedApp: App | null = null;
let cachedDb: Firestore | null = null;

/**
 * Parse the service-account credential from the env var, tolerating the
 * forms it can realistically arrive in: the raw JSON document, the whole
 * JSON base64-encoded, or a larger pasted blob (e.g. an IAM API response)
 * that contains the base64-encoded document as its longest base64 run
 * (the `privateKeyData` field). Falls back to a plain JSON.parse so a
 * genuinely malformed value throws the original parse error.
 */
function parseServiceAccount(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const looksLikeServiceAccount = (v: unknown): v is Record<string, unknown> =>
    !!v &&
    typeof v === 'object' &&
    typeof (v as Record<string, unknown>).private_key === 'string' &&
    typeof (v as Record<string, unknown>).client_email === 'string';

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = undefined;
  }
  if (looksLikeServiceAccount(parsed)) return parsed;
  // A pasted IAM API response: the document is in its privateKeyData field.
  if (parsed && typeof parsed === 'object') {
    const keyData = (parsed as Record<string, unknown>).privateKeyData;
    if (typeof keyData === 'string') {
      try {
        const inner = JSON.parse(Buffer.from(keyData, 'base64').toString('utf8'));
        if (looksLikeServiceAccount(inner)) return inner;
      } catch {
        // fall through
      }
    }
  }
  const candidates = [trimmed, ...(trimmed.match(/[A-Za-z0-9+/=]{100,}/g) ?? [])];
  for (const candidate of candidates) {
    try {
      const decoded = JSON.parse(Buffer.from(candidate, 'base64').toString('utf8'));
      if (looksLikeServiceAccount(decoded)) return decoded;
    } catch {
      // try the next candidate
    }
  }
  // Nothing matched: re-run the plain parse so a malformed value throws
  // the original error (or returns whatever it parsed to).
  return JSON.parse(trimmed);
}

function initFirebaseAdmin(): App {
  if (getApps().length) return getApps()[0];

  const projectId =
    process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'riddimroom-studio';

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    return initializeApp({ credential: cert(serviceAccount), projectId });
  }

  try {
    return initializeApp({ projectId, credential: applicationDefault() });
  } catch {
    return initializeApp({ projectId });
  }
}

export function getDb(): Firestore {
  if (!cachedDb) {
    cachedApp = initFirebaseAdmin();
    cachedDb = getFirestore(cachedApp);
  }
  return cachedDb;
}

export function getAuthAdmin() {
  if (!cachedApp) {
    cachedApp = initFirebaseAdmin();
  }
  return getAuth(cachedApp);
}

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

/**
 * Verify the Firebase ID token from the Authorization header, mirroring
 * server.ts's verifyFirebaseToken middleware: on failure this writes the
 * same 401 response and returns null.
 */
export async function verifyRequest(req: ApiRequest, res: ApiResponse): Promise<DecodedIdToken | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Missing or malformed Authorization header' });
    return null;
  }
  const idToken = authHeader.slice('Bearer '.length);
  try {
    return await getAuthAdmin().verifyIdToken(idToken);
  } catch (err: any) {
    console.warn('[auth] Token verification failed:', err?.code || err?.message);
    res.status(401).json({ success: false, error: 'Invalid or expired authentication token' });
    return null;
  }
}

export const DEFAULT_DAILY_QUOTA = 2;
export const LIFETIME_DAILY_QUOTA = 10;

export async function getLicenseTier(uid: string): Promise<'free' | 'lifetime'> {
  try {
    const db = getDb();
    const doc = await db.collection('licenses').doc(uid).get();
    if (doc.exists) {
      const data = doc.data() as { tier?: string; active?: boolean };
      if (data.tier === 'lifetime' && data.active !== false) return 'lifetime';
    }
    // Admin/owner grant: admins/{uid} resolves to the lifetime tier so the
    // studio owner is never bitten by free-tier gates.
    const adminDoc = await db.collection('admins').doc(uid).get();
    if (adminDoc.exists) return 'lifetime';
    return 'free';
  } catch {
    return 'free';
  }
}

export async function isGlobalDisabled(): Promise<boolean> {
  try {
    const doc = await getDb().collection('config').doc('global').get();
    return doc.exists && (doc.data() as { disabled?: boolean }).disabled === true;
  } catch {
    return false;
  }
}

export function toClientUser(data: UserProfile, licenseTier: 'free' | 'lifetime' = 'free') {
  // Server is the single source of truth for role/status/quota — the client
  // never sets these directly (firestore.rules: users/{uid} is not
  // client-writable).
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
