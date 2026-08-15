# Changelog

All notable changes to RiddimRoom Studio are documented here, in order, per the approved build process (small logical commits, changelog updated continuously).

## [Unreleased] — Phase 1

### Timeline architecture foundation

- Added the multi-track timeline data model, approved as the underlying architecture for the future multi-track editor: `Project` → `Track`s + `TimelineItem`s, where video, image, text, caption, and audio overlays are all independent timeline items with their own track, timing, and z-order — never a property attached to a "main clip" (the exact anti-pattern identified in BoltVideoApp's global, non-timeline `BrandingSettings`).
- `src/types/timeline.ts` — `Track`, `TimelineItemBase`, `VideoTimelineItem`, `ImageTimelineItem`, `TextTimelineItem`, `CaptionTimelineItem`, `AudioTimelineItem`, `MediaAsset`, `Project`. `TIMELINE_SCHEMA_VERSION` added for future migrations.
- `src/lib/timeline/utils.ts` — id generation, project/track/item/media-asset construction helpers, timing/overlap queries (`getItemDuration`, `getProjectDuration`, `itemsOverlapInTime`, `getItemsAtTime`, `getItemsByTrackType`).
- `src/lib/timeline/validation.ts` — `validateProject`/`assertValidProject`. Rejects (does not silently coerce) malformed timing, an item placed on a track of the wrong type, a dangling `trackId`/`mediaAssetId` reference, out-of-range transform values, caption word timings beyond their item's own duration, and duplicate ids.
- `src/lib/timeline/serialization.ts` — `serializeProject`/`deserializeProject`/`parseProject`, producing the Firestore-safe document shape (undefined-valued fields dropped via the JSON round-trip, matching what Firestore requires) that Step 3 (Shared storage) will read/write. No Firestore SDK call is wired up yet — this module only defines the shape and the pure conversion functions.
- `test-timeline-foundation.mts` — 33 automated checks, including a sample project exercising every track type at once (2 simultaneous video layers, an image watermark, a title, AI-sourced word-level captions, and 3 independent audio tracks — original/music/voiceover — all overlapping in time), plus explicit invalid-data rejection cases. 33/33 passed.

**Source of inherited functionality** (per the project's source-of-feature rule):
- Track/z-index/independent-timing concept: generalizes the `track: number` field already proven on **BoltVideoApp**'s `TextOverlay`/`CaptionTrack`, from text-only to all five media types.
- `CaptionTimelineItem.words` shape: **BoltVideoApp**'s `WordTiming` (itself sourced from **riddimroom-caption**'s `WordCaption`), reused as-is — word times are relative to the caption item's own `startTime`, matching BoltVideoApp's convention.
- `ImageTimelineItem` position/opacity/role fields: **EventCam**'s percentage-based `WatermarkSettings`/`TextOverlaySettings`, generalized so a watermark is an ordinary `ImageTimelineItem`, never a special-cased global setting.
- `VideoTimelineItem` trim/speed/reverse/crop/colorGrade fields: **BoltVideoApp**'s `VideoClipSettings`, moved from "attached to a clip" to "fields on an independent timeline item".

**Deviation, documented:** `duration` is intentionally not a stored field (only `startTime`/`endTime` are) — storing both invites drift between them on an edit that updates one but not the other. `getItemDuration()` derives it on demand. The original requirements list named `duration` as a field explicitly; flagging the substitution here per the project's documentation rule.

**Explicitly out of scope for this change** (belongs to later Phase 1 steps, not built now): the multi-track editor UI, the render/export engine, and the actual Firestore `projects/{id}` read/write endpoints. This change is the data-model foundation only.

**Repository maintenance:** re-verified the working tree has no residual CRLF/LF churn from the earlier line-ending cleanup (local `core.autocrlf=false` still in effect); all new files were authored with LF line endings from the start.

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
