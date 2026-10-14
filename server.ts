/**
 * RiddimRoom Studio — Cloud Run backend.
 *
 * Phase 1, Step 2 (Authentication) adds: Firebase Admin SDK init, a shared
 * token-verification middleware, and /api/user/status (session check +
 * unified user document upsert). Media/admin/quota-enforcement routes are
 * added in their own later build steps, per the approved Phase 1 order.
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { initializeApp, getApps, applicationDefault, cert } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import type { UserProfile } from './src/types/user';
import { getTranscriptionProvider, TranscriptionConfigurationError } from './src/lib/transcription';

dotenv.config();

declare const __dirname: string | undefined;

// Production-hardening addition (not present in either legacy app, so not
// a "port" — a new safeguard). Google's Firestore/Auth Admin client
// libraries can perform internal credential/channel setup outside the
// promise chain your own await/try-catch wraps (observed during Step 2
// verification: a missing-ADC error during gRPC stub creation surfaced as
// an unhandled rejection and crashed the whole process on Node 22, taking
// down every in-flight request, not just the one that triggered it).
// Logging instead of crashing keeps one bad Firestore call from taking
// the whole server down. Route-level try/catch (see /api/user/status)
// remains the primary error path; this is a last-resort net.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// --- Firebase Admin SDK initialization ---------------------------------
// Source pattern: riddimroom-caption's server.ts credential-resolution
// chain (env project id -> local config file -> zero-config). Simplified
// here: caption's version also carried an in-memory-users fallback for
// the AI-Studio sandbox environment where Firestore was sometimes
// unconfigured. That fallback is dropped in the unified app — this
// project's Firestore is always provisioned, so masking a real
// misconfiguration behind a silent in-memory substitute would hide bugs
// rather than help. GOOGLE_APPLICATION_CREDENTIALS (service account key
// path) is also supported here for local/emulator testing, which caption
// did not need since it only ran on real Cloud Run.
function initFirebaseAdmin() {
  if (getApps().length) return getApps()[0];

  const projectId =
    process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'riddimroom-studio';

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    return initializeApp({ credential: cert(serviceAccount), projectId });
  }

  try {
    return initializeApp({ projectId, credential: applicationDefault() });
  } catch {
    // Emulator / zero-config environments (Cloud Run's metadata server,
    // or FIRESTORE_EMULATOR_HOST + FIREBASE_AUTH_EMULATOR_HOST for local
    // testing) don't need explicit credentials.
    return initializeApp({ projectId });
  }
}

const firebaseAdminApp = initFirebaseAdmin();
const authAdmin = getAuth(firebaseAdminApp);
const db = getFirestore(firebaseAdminApp);

// --- Shared Firebase ID token verification middleware -------------------
// Source: the same authAdmin.verifyIdToken(...) call riddimroom-caption
// repeats inline at the top of every privileged route handler (server.ts,
// 10 separate call sites). Extracted into one Express middleware here per
// your explicit Step 2 requirement and the Phase 0 architecture rule
// against duplicated code — behavior (reject missing/invalid/expired
// tokens with 401) is unchanged from caption's per-route checks.
export interface AuthedRequest extends Request {
  decodedToken?: DecodedIdToken;
}

async function verifyFirebaseToken(req: AuthedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Missing or malformed Authorization header' });
  }
  const idToken = authHeader.slice('Bearer '.length);
  try {
    req.decodedToken = await authAdmin.verifyIdToken(idToken);
    next();
  } catch (err: any) {
    // Covers both invalid signatures and expired tokens — verifyIdToken
    // throws for both, and firebase-admin distinguishes them via
    // err.code (auth/id-token-expired vs auth/argument-error etc).
    console.warn('[auth] Token verification failed:', err.code || err.message);
    return res.status(401).json({ success: false, error: 'Invalid or expired authentication token' });
  }
}

const DEFAULT_DAILY_QUOTA = 2;
const LIFETIME_DAILY_QUOTA = 10;

async function getLicenseTier(uid: string): Promise<'free' | 'lifetime'> {
  try {
    const doc = await db.collection('licenses').doc(uid).get();
    if (doc.exists) {
      const data = doc.data() as { tier?: string; active?: boolean };
      if (data.tier === 'lifetime' && data.active !== false) return 'lifetime';
    }
    // Admin/owner grant: `admins/{uid}` is this codebase's existing admin
    // concept (the same collection /api/user/status already consults for
    // the global kill-switch bypass). Admins resolve to the lifetime tier
    // so the studio owner is never bitten by free-tier gates (watermark,
    // export cap, transcription quota) on their own app. This is the
    // single tier choke point — /api/license, /api/user/status,
    // /api/transcribe and /api/checkout all resolve through here, and the
    // client only ever displays/soft-gates on what this returns.
    const adminDoc = await db.collection('admins').doc(uid).get();
    if (adminDoc.exists) return 'lifetime';
    return 'free';
  } catch {
    return 'free';
  }
}

async function isGlobalDisabled(): Promise<boolean> {
  try {
    const doc = await db.collection('config').doc('global').get();
    return doc.exists && (doc.data() as { disabled?: boolean }).disabled === true;
  } catch {
    return false;
  }
}

function toClientUser(data: UserProfile, licenseTier: 'free' | 'lifetime' = 'free') {
  // Server is the single source of truth for role/status/quota — the
  // client never sets these directly (see firestore.rules: users/{uid}
  // is write: if false for clients; all writes go through this backend).
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

async function createServer() {
  const app = express();
  // v1 hardening: CORS allowlist from env (APP_URL + localhost), not open cors().
  const allowedOrigins = new Set(
    (process.env.APP_URL ? [process.env.APP_URL] : [])
      .concat(['http://localhost:5173', 'http://localhost:3000', 'https://studio.riddimroom.com', 'https://riddimroom.com']),
  );
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / curl / server-to-server
      if (allowedOrigins.has(origin)) return cb(null, true);
      return cb(new Error(`Origin not allowed: ${origin}`));
    },
  }));
  // Security headers (lightweight, no extra dependency).
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
    next();
  });
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'riddimroom-studio', timestamp: new Date().toISOString() });
  });

  // Session check + unified user document upsert.
  // v1: global kill-switch — if config/global.disabled is true, non-admin
  // users get 403 here (EventCam's expiry/disabled was dead code; here it
  // is enforced on the server, not the client).
  app.get('/api/user/status', verifyFirebaseToken, async (req: AuthedRequest, res: Response): Promise<any> => {
    const decoded = req.decodedToken!;
    const uid = decoded.uid;
    const email = decoded.email || '';
    const todayStr = new Date().toISOString().split('T')[0];

    // Source: caption's server.ts wraps this entire block (Firestore
    // reads/writes, not just token verification) in a try/catch so a
    // Firestore failure returns a clean error response instead of an
    // unhandled rejection. Express 4 does not auto-catch async route
    // errors, so without this a Firestore outage would hang the request
    // or crash the process. Caught during Step 2 verification (this repo
    // initially wrapped only the token check, not the Firestore calls —
    // a real gap vs. caption, fixed here). Caption also falls back to an
    // in-memory user store on Firestore failure; that fallback is still
    // intentionally dropped per the module-level comment above — this
    // repo's Firestore is always provisioned, so masking an outage would
    // hide real bugs. Returning a proper 500 (rather than silently
    // succeeding with fake data) is the safer behavior for a production
    // app with real user accounts.
    try {
      // Kill-switch check before any profile work.
      const disabled = await isGlobalDisabled();
      const isAdmin = (await db.collection('admins').doc(uid).get()).exists;
      if (disabled && !isAdmin) {
        return res.status(403).json({ success: false, error: 'RiddimRoom Studio is temporarily unavailable.' });
      }
      const userRef = db.collection('users').doc(uid);
      const userDoc = await userRef.get();

      if (!userDoc.exists) {
        const newUser: UserProfile = {
          uid,
          email,
          displayName: decoded.name || email.split('@')[0] || 'User',
          photoURL: decoded.picture || null,
          provider: decoded.firebase?.sign_in_provider || 'password',
          role: 'user',
          // See src/types/user.ts for why this defaults to 'approved' rather
          // than EventCam's original 'pending' in Phase 1.
          status: 'approved',
          createdAt: FieldValue.serverTimestamp(),
          lastLogin: FieldValue.serverTimestamp(),
          lastUpdated: FieldValue.serverTimestamp(),
          dailyCount: 0,
          lastTranscribeDate: todayStr,
          totalTranscribes: 0,
          captureCount: 0,
          photoCount: 0,
          videoCount: 0,
          subscription: 'free',
          plan: 'free',
        };
        await userRef.set(newUser);
        return res.json({ success: true, user: toClientUser(newUser, 'free') });
      }

      const data = userDoc.data() as UserProfile;

      // Daily quota resets when lastTranscribeDate isn't today — same rule
      // as caption's dailyCount reset logic.
      const dailyCount = data.lastTranscribeDate === todayStr ? data.dailyCount || 0 : 0;

      const updates: Partial<UserProfile> & Record<string, unknown> = {
        lastLogin: FieldValue.serverTimestamp(),
        lastUpdated: FieldValue.serverTimestamp(),
      };
      if (dailyCount !== data.dailyCount) {
        updates.dailyCount = dailyCount;
        updates.lastTranscribeDate = todayStr;
      }
      await userRef.update(updates);

      if (data.status === 'suspended' || data.status === 'denied') {
        return res.status(403).json({ success: false, error: 'Account access restricted' });
      }

      const licenseTier = await getLicenseTier(uid);
      return res.json({ success: true, user: toClientUser({ ...data, dailyCount }, licenseTier) });
    } catch (err: any) {
      console.error('[user/status] Firestore operation failed:', err.code || err.message);
      return res.status(500).json({ success: false, error: 'Failed to load user profile' });
    }
  });

  // v1 Licensing: GET /api/license — tier + whether checkout is configured.
  app.get('/api/license', verifyFirebaseToken, async (req: AuthedRequest, res: Response): Promise<any> => {
    const uid = req.decodedToken!.uid;
    const tier = await getLicenseTier(uid);
    return res.json({
      tier,
      watermarkEnabled: tier !== 'lifetime',
      checkoutAvailable: !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID_LIFETIME),
    });
  });

  // v1 Licensing: POST /api/checkout — Stripe Checkout stub.
  // TODO (Stripe): when STRIPE_SECRET_KEY + STRIPE_PRICE_ID_LIFETIME are
  // set, create a real Checkout Session here (mode: 'payment',
  // success_url/cancel_url -> APP_URL) and return { checkoutUrl }.
  // Until then: 503 with a clear message — never invent keys or charge.
  app.post('/api/checkout', verifyFirebaseToken, async (req: AuthedRequest, res: Response): Promise<any> => {
    const uid = req.decodedToken!.uid;
    const tier = await getLicenseTier(uid);
    if (tier === 'lifetime') return res.json({ success: true, tier, message: 'Already lifetime.' });
    if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID_LIFETIME) {
      return res.status(503).json({ success: false, error: 'Checkout is not configured yet (missing STRIPE_SECRET_KEY / STRIPE_PRICE_ID_LIFETIME).' });
    }
    // Stripe keys ARE set but the real Checkout call is not wired yet —
    // return 503 rather than pretending. Wire `stripe` SDK here next.
    return res.status(503).json({ success: false, error: 'Stripe Checkout wiring is pending — keys are set but the session creation is not yet implemented. See server.ts TODO.' });
  });

  // v1 Licensing: POST /api/webhook/stripe — Stripe webhook stub.
  // TODO (Stripe): verify signature with STRIPE_WEBHOOK_SECRET (raw body
  // required — use express.raw for this route), handle
  // checkout.session.completed -> write licenses/{uid} = { tier: 'lifetime', active: true, ... }.
  // Until then: 400 with a clear message.
  app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (_req: Request, res: Response): Promise<any> => {
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(400).json({ success: false, error: 'Stripe webhook not configured (missing STRIPE_WEBHOOK_SECRET).' });
    }
    return res.status(501).json({ success: false, error: 'Stripe webhook verification not yet implemented. See server.ts TODO.' });
  });

  // AI transcription (Phase 1 Step 10) + server-side quota enforcement
  // (Step 13). Source of the quota-reset logic: the same
  // lastTranscribeDate-based daily reset already used by
  // /api/user/status, applied here as the actual gate on the actual
  // quota-consuming operation (dailyCount was previously only ever reset
  // and read, never incremented by anything real).
  //
  // Ownership check: the client sends a Storage download URL, not just an
  // asset id, since transcription needs to fetch the actual media bytes.
  // Storage rules already restrict who can *read* that URL's bytes
  // (users/{uid}/**), but this route also refuses to even attempt a
  // transcription against a URL that doesn't look like it belongs to the
  // authenticated caller, so a client bug can't burn one user's quota
  // transcribing another user's media path.
  app.post('/api/transcribe', verifyFirebaseToken, async (req: AuthedRequest, res: Response): Promise<any> => {
    const decoded = req.decodedToken!;
    const uid = decoded.uid;
    const { storageUrl, mimeType, durationSeconds } = req.body || {};

    if (typeof storageUrl !== 'string' || !storageUrl) {
      return res.status(400).json({ success: false, error: 'storageUrl is required.' });
    }
    if (typeof mimeType !== 'string' || !mimeType) {
      return res.status(400).json({ success: false, error: 'mimeType is required.' });
    }
    const ownedPrefix = `users%2F${uid}%2Fmedia%2F`;
    if (!storageUrl.includes(ownedPrefix)) {
      return res.status(403).json({ success: false, error: 'This media does not belong to the authenticated user.' });
    }

    const todayStr = new Date().toISOString().split('T')[0];

    try {
      const userRef = db.collection('users').doc(uid);
      const userDoc = await userRef.get();
      if (!userDoc.exists) {
        return res.status(404).json({ success: false, error: 'User profile not found — call /api/user/status first.' });
      }
      const data = userDoc.data() as UserProfile;
      const dailyCount = data.lastTranscribeDate === todayStr ? data.dailyCount || 0 : 0;
      // v1: quota by license tier (free 2/day, lifetime 10/day).
      const licenseTier = await getLicenseTier(uid);
      const maxDaily = licenseTier === 'lifetime' ? LIFETIME_DAILY_QUOTA : DEFAULT_DAILY_QUOTA;

      if (dailyCount >= maxDaily) {
        return res.status(429).json({
          success: false,
          error: `Daily transcription quota (${maxDaily}) reached. Try again tomorrow.`,
          dailyCount,
          maxFree: maxDaily,
        });
      }

      const transcriptionRequest = { mediaUrl: storageUrl, mimeType, durationSeconds };
      let result;
      try {
        result = await getTranscriptionProvider('gemini').transcribe(transcriptionRequest);
      } catch (err: any) {
        if (err instanceof TranscriptionConfigurationError) {
          // Explicit fallback attempt, per the Phase 1 requirement — only on
          // a configuration error, not on every Gemini failure.
          try {
            result = await getTranscriptionProvider('whisper').transcribe(transcriptionRequest);
          } catch (fallbackErr: any) {
            if (fallbackErr instanceof TranscriptionConfigurationError) {
              return res.status(503).json({
                success: false,
                error: 'Transcription is not configured on this server (no GEMINI_API_KEY and no WHISPER_API_URL). This is a configuration issue, not a code failure.',
              });
            }
            throw fallbackErr;
          }
        } else {
          throw err;
        }
      }

      const newDailyCount = dailyCount + 1;
      await userRef.update({
        dailyCount: newDailyCount,
        lastTranscribeDate: todayStr,
        totalTranscribes: FieldValue.increment(1),
        lastUpdated: FieldValue.serverTimestamp(),
      });

      return res.json({ success: true, words: result.words, provider: result.provider, dailyCount: newDailyCount, maxFree: maxDaily });
    } catch (err: any) {
      console.error('[transcribe] failed:', err?.message || err);
      return res.status(500).json({ success: false, error: err?.message || 'Transcription failed.' });
    }
  });

  const isProd = process.env.NODE_ENV === 'production';
  // Dev runs this file directly as ESM (tsx); prod runs the esbuild CJS
  // bundle, where __dirname is a native CJS global and import.meta.url is
  // unavailable. Resolve whichever is actually present.
  const currentDir =
    typeof __dirname !== 'undefined'
      ? __dirname
      : path.dirname(new URL(import.meta.url).pathname);

  if (isProd) {
    const distPath = currentDir;
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`[riddimroom-studio] listening on port ${PORT} (${isProd ? 'production' : 'development'})`);
  });
}

createServer();
