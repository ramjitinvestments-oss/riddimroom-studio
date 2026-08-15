# Changelog

All notable changes to RiddimRoom Studio are documented here, in order, per the approved build process (small logical commits, changelog updated continuously).

## [Unreleased] — CORS + broken-canvas-image fix

Fixes a live bug: an existing Firebase-Storage-backed image failed to load
in the browser (missing Storage CORS configuration) and then crashed the
canvas render loop (`InvalidStateError` from calling `drawImage()` on a
broken `<img>`).

- `storage.cors.json` — rewritten to restrict `origin` to
  `http://localhost:3000` (no bare `*`), methods `GET, HEAD, OPTIONS`,
  response headers `Content-Type, Authorization`. **Not yet applied to the
  real bucket** — no GCP-authenticated CLI is reachable from this sandbox
  or the device environment; the exact command to run is documented in
  PROGRESS.md.
- `src/lib/render/compositor.ts` — added an `isImageReady()` guard
  (`complete && naturalWidth > 0 && naturalHeight > 0`) before drawing any
  `image` timeline item, plus a defensive try/catch around the
  `drawImage()` call itself (mirroring the existing video-draw pattern).
  Render-loop safety net only; does not address the CORS root cause.
- `src/components/Editor/PreviewPane.tsx` — `getImageEl` now logs a
  `console.warn` on image load failure, for diagnostics only.
- `storage.rules` reviewed and confirmed unchanged — the bug is a CORS
  configuration gap, not an authorization problem; security was not
  weakened to work around it.
- Full existing test suite (77 checks across 5 suites) plus the
  `test-export-browser/` Playwright smoke test re-run: all passing, no
  regressions.

## [Unreleased] — Phase 1

### Phase 1 completion pass (Steps 3–15: Shared storage, Capture, Upload, Shared editor shell, Background removal, Watermark overlay, Text overlay, AI transcription, Caption engine, Export engine, Quota enforcement, UI refinement, Final Phase 1 verification)

Implements the remaining Phase 1 build order in one continuous pass, on the existing flat repo / React+Vite+TS / Express / Firebase architecture, consuming the timeline foundation as the single source of truth throughout (no parallel data model introduced anywhere in this change).

- **Capture + Upload** — `src/components/Editor/CameraCapture.tsx` (getUserMedia + MediaRecorder, front/back toggle, photo + video), `src/components/Editor/MediaImportPanel.tsx` (drag/drop + file picker, validation, progress, retry), `src/lib/media/{probe,validate,upload}.ts`. Uploads go to real Firebase Storage at `users/{uid}/media/{assetId}/{filename}` — the path `storage.rules` was already scoped to in Step 1, exercised end-to-end for the first time — and produce a real `MediaAsset` (Storage download URL, probed duration/dimensions), never media held only in React state.
- **Shared editor shell + persistence** — `src/lib/projects/persistence.ts` (`projects/{projectId}` create/load/save/list/delete via the Firestore client SDK, using the timeline foundation's `serializeProject`/`parseProject`), `src/context/ProjectContext.tsx`, `src/components/Dashboard.tsx`, `src/components/Editor/EditorShell.tsx` + `PreviewPane.tsx` + `TimelinePanel.tsx` + `ItemInspector.tsx`. Projects persist to Firestore, not just React state, so a project survives a full page refresh.
- **Watermark + Text overlays** — `src/lib/timeline/insert.ts` (`addTextItem`, `addWatermarkItem`, plus `appendMediaToTimeline` for general media), `src/components/Editor/{AddTextPanel,WatermarkPanel}.tsx`. Both are real `TimelineItem`s (`TextTimelineItem`, `ImageTimelineItem` with `role: 'watermark'`) — position/scale/opacity/timing all editable via `ItemInspector.tsx`, all persisted through the `Project`, never a temporary overlay state.
- **AI transcription + Caption engine** — `POST /api/transcribe` in `server.ts`; `src/lib/transcription/{types,gemini,whisper,index}.ts` (Gemini primary via `@google/genai`'s Files API + structured-JSON `generateContent`, Whisper kept as a real fallback provider abstraction gated on `WHISPER_API_URL`); `src/lib/timeline/insert.ts`'s `addCaptionItems` (chunks a transcript into readable multi-second cues, each a real `CaptionTimelineItem`); `src/components/Editor/TranscribePanel.tsx`; `src/lib/captions/styles.ts` (3-style catalog). `GEMINI_API_KEY`/`WHISPER_API_URL` are read server-side only from `process.env`, never sent to or hardcoded in client code; both providers throw a typed `TranscriptionConfigurationError` (mapped to HTTP 503) rather than fabricating a transcript when unconfigured.
- **Background removal** — `src/lib/backgroundRemoval/index.ts` (provider abstraction around `@imgly/background-removal`, a client-side WASM model requiring no API credential), `src/components/Editor/BackgroundRemovalButton.tsx`. Dynamically `import()`-ed so the multi-MB model is never in the main bundle; result is registered as an ordinary new `MediaAsset` in the same project media pool.
- **Export engine** — `src/lib/export/{renderer,canvas2dRenderer,validate}.ts`, `src/components/Editor/ExportPanel.tsx`, `src/lib/render/compositor.ts` (shared by both `PreviewPane` and the exporter, so preview and export can't drift apart). `Renderer` is an explicit interface so the current Canvas2D/MediaRecorder/WebAudio implementation (the same fundamental technique all three legacy apps used) can be swapped for a server-side renderer later without touching callers. Consumes base video, text, watermark, captions, and timing together via `drawFrame` + a Web Audio mix graph. `validateRenderResult` refuses to report success on an empty or suspiciously small (likely CORS-tainted-canvas) output.
- **Quota enforcement** — `/api/transcribe` reuses `/api/user/status`'s `dailyCount`/`lastTranscribeDate` daily-reset logic, now actually gating and incrementing it server-side (429 when exhausted) for the first real quota-consuming operation in this codebase. Client reads/displays quota from the existing `ClientUserProfile` shape (added to `src/types/user.ts` — see "Bugs found and fixed" below) in `Dashboard.tsx`/`TranscribePanel.tsx`.
- **UI refinement** — `src/App.tsx` no longer shows the Step 2 placeholder; routes to `Dashboard` (`/`) or `EditorShell` (`/editor/:projectId`) via a small extension of the existing `useRouter()` path-matching, not a new routing library. Loading/error/empty states added throughout (project list, project load, uploads, export, transcription, quota).
- **Bundle-size pass** — `vite.config.ts` now splits `firebase`/`react` into their own vendor chunks; confirmed `@imgly/background-removal`'s ONNX runtime is already its own on-demand chunk (dynamic `import()`), not part of the initial bundle.
- `storage.cors.json` (new, repo root) — required for canvas-based preview/export to read cross-origin Storage media; a real operational step (`gsutil cors set`) outside this repo's own tooling, documented in PROGRESS.md Risks.
- `test-editor-foundation.mts` (25 checks), `test-transcription-providers.mts` (4 checks), `test-transcribe-endpoint.mjs` (6 live checks against the dev server + Auth emulator), `test-export-browser/` (6 live Playwright/Chromium checks proving the exporter produces a real, valid, correctly-sized video file) — all new, all passing. Full regression: `test-timeline-foundation.mts` still 33/33, `test-auth-integration.mjs` still 9/9 (unchanged behavior; timeout raised for this sandbox's Firestore-unreachable latency, see PROGRESS.md).

**Bugs found and fixed during this pass (before commit, per your process rules):**
- `AuthContext`'s `userProfile` was typed as `UserProfile` (the raw Firestore document shape), but `/api/user/status` actually returns `toClientUser()`'s shape — a subset plus `maxFree`, which isn't a Firestore field at all. This only surfaced once new code (`Dashboard.tsx`) actually read `.maxFree`. Fixed by adding the correct `ClientUserProfile` type to `src/types/user.ts` and retyping `AuthContext` to it, rather than loosening the type or duplicating `maxFree` onto `UserProfile` where it doesn't belong.
- `listProjects`'s first draft used `where('ownerUid','==',uid)` combined with `orderBy('updatedAt')` — Firestore requires a composite index for that combination, which is a manual Firebase-console step outside this repo. Changed to sort the (capped) result client-side instead, so the feature doesn't depend on an undeployed index.

**Explicitly deviates from the pre-implementation roadmap's tentative suggestion:** `projects/{projectId}` reads/writes go directly through the Firestore client SDK rather than being server-mediated like `/api/user/status`. Reasoning and the specific security rule this relies on are documented in `src/lib/projects/persistence.ts`'s header comment.

**Explicitly reduced from the legacy apps' full scope, documented rather than hidden:** the caption style catalog ships 3 real styles (`src/lib/captions/styles.ts`), not caption's original 17 — each of the 3 is fully working, rather than shipping 17 entries that don't render distinctly.

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
