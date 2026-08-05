# Changelog

All notable changes to RiddimRoom Studio are documented here, in order, per the approved build process (small logical commits, changelog updated continuously).

## [Unreleased] — Phase 1

### Step 1 — Project foundation
- Initialized repository (`ramjitinvestments-oss/riddimroom-studio`, private).
- Provisioned new Firebase project `riddimroom-studio` (Blaze plan): Authentication (Email/Password + Google), Firestore (default database, nam5), Cloud Storage (`riddimroom-studio.firebasestorage.app`, US-EAST1), web app registered.
- Scaffolded React 19 + Vite 6 + TypeScript + Tailwind 4 frontend and Express + esbuild backend, matching the proven pattern from `riddimroom-caption` / `riddimroom-app`.
- Added `firestore.rules` and `storage.rules` implementing the unified user schema from the approved Phase 0 architecture (default-deny, merged role/status fields).
- Added `/api/health` endpoint.

### Step 2 — Authentication
- Firebase Authentication wired end-to-end: Google Sign-In (popup), Email/Password registration, Email/Password login, password reset, sign-out, persistent sessions (remember-me toggle -> `browserLocalPersistence` vs `browserSessionPersistence`).
- Added `src/context/AuthContext.tsx` — shared `AuthProvider`/`useAuth()` React context. Source: riddimroom-caption's inline `App.tsx` auth state (`onAuthStateChanged`, `handleGoogleLogin`, `handleEmailAuthDirect`, `handleForgotPasswordDirect`) and `ProtectedRoute.tsx`. Deviation: extracted from a single-component pattern into a shared context, per your explicit Step 2 requirement (needed by multiple entry points in the unified app) — underlying Firebase calls and error handling unchanged.
- Rewrote `src/components/ProtectedRoute.tsx` to read from `useAuth()` instead of props. Same redirect/role-check behavior as caption's version.
- Added `src/components/LoginPage.tsx` — login/signup/forgot-password UI, ported from caption's `LoginPage.tsx` with identical validation rules (password >= 6 chars, required fields per mode).
- Added `src/lib/router.ts` — minimal `useRouter()` hook, extracted from caption's inline `window.history` pattern in `App.tsx`.
- Added `src/types/user.ts` — unified `UserProfile` schema merging caption's quota fields (`dailyCount`, `totalTranscribes`, `subscription`, `plan`) with EventCam's status/usage fields (`status`, `captureCount`, `photoCount`, `videoCount`). Documented deviation: `status` defaults to `'approved'` in Phase 1, not EventCam's original `'pending'` (no admin approval queue exists yet to clear a pending state — building a dead-end gate isn't a feature, so it's deferred to the full admin-panel phase where it belongs).
- Rewrote `server.ts`:
  - Firebase Admin SDK init (`initFirebaseAdmin`) supporting service-account-JSON env var (new, for local/emulator testing — caption never needed this since it only ran on real Cloud Run), `applicationDefault()`, and zero-config fallback.
  - Extracted `verifyFirebaseToken` middleware — source: caption's repeated inline `authAdmin.verifyIdToken(...)` check at ~10 route handlers, consolidated into one Express middleware per your requirement and the Phase 0 no-duplicated-code rule.
  - `GET /api/user/status` — session check + unified user document upsert. Source: caption's `/api/user/status` (server.ts ~line 487). Deviation: caption also falls back to an in-memory user store if Firestore fails; intentionally dropped here (documented in-code) since this app's Firestore is always provisioned and a silent fallback would mask real outages rather than surface them.
- Revised `firestore.rules`: `users/{userId}` writes are now backend-only (client reads own doc, all writes go through the Admin SDK). Security tightening vs. caption's original client-writable-fields approach, per the Phase 0 security finding (no client-side administrative actions).

**Bugs found and fixed during Step 2 verification (before commit, per your process rules):**
- `/api/user/status` only wrapped token verification in try/catch, not the Firestore reads/writes that follow — unlike caption, which wraps the entire handler body. Express 4 doesn't auto-catch async rejections, so a Firestore failure would have hung the request or, worse, crashed the whole process. Fixed by wrapping the Firestore operations in try/catch, returning a clean 500 on failure.
- Confirmed via live testing (see verification notes) that Firestore's Node client can raise an unhandled promise rejection during internal gRPC/credential setup, outside the awaited call site's try/catch, which crashed the process on Node 22 in this sandbox. Added a process-level `unhandledRejection` handler (log, don't crash) as a last-resort safety net — a new hardening measure, not present in either legacy app, added because Step 2 was the first time this codebase made a real Firestore call.
