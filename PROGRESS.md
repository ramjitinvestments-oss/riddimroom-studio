# Progress

Tracks completion status of each Phase 1 build-order step (see `riddimroom-studio-phase1-plan.md`). Updated continuously, per step, not just at phase end.

| # | Step | Status |
|---|------|--------|
| 1 | Project foundation | **Complete** — repo, Firebase project, codebase scaffold, all verified (tsc clean, dev + prod builds boot and serve correctly) |
| 2 | Authentication | **Complete** — Google + email/password auth, shared context, ProtectedRoute, Admin SDK middleware, unified user doc upsert; verified live against Firebase Auth emulator + real dev/prod server, plus code review for browser-only flows (see Step 2 completion report) |
| 3 | Shared storage | **Complete** — `projects/{projectId}` read/write via client SDK direct to Firestore (see "Phase 1 completion pass" below for why this deviates from server-mediated) |
| 4 | Capture | **Complete** — `CameraCapture.tsx`, getUserMedia + MediaRecorder, front/back toggle, photo + video |
| 5 | Upload | **Complete** — `MediaImportPanel.tsx` + `lib/media/*`, validation, progress, retry, real Storage upload, `MediaAsset` creation |
| 6 | Shared editor shell | **Complete** — `EditorShell.tsx`, `ProjectContext`, `PreviewPane`, `TimelinePanel`, project survives refresh (Firestore-backed) |
| 7 | Background removal | **Complete** — `@imgly/background-removal` (client-side WASM, no credential needed), provider abstraction, dynamically imported |
| 8 | Watermark overlay | **Complete** — `WatermarkPanel.tsx`, real `ImageTimelineItem` with `role: 'watermark'` |
| 9 | Text overlay | **Complete** — `AddTextPanel.tsx` + `ItemInspector.tsx`, real `TextTimelineItem` |
| 10 | AI transcription | **Complete (Gemini configured), config-gated (Whisper)** — `POST /api/transcribe`, Gemini primary via `@google/genai`, Whisper fallback abstraction; no real `GEMINI_API_KEY` available in the build sandbox (see Risks) |
| 11 | Caption engine | **Complete** — `addCaptionItems` (chunking), `TranscribePanel.tsx`, 3-style catalog (`captions/styles.ts`), editable in `ItemInspector` |
| 12 | Export engine | **Complete** — `Renderer` abstraction + `Canvas2DRenderer` (real Canvas2D/MediaRecorder/WebAudio pipeline), verified to produce a real, valid output file (see verification notes) |
| 13 | Quota enforcement | **Complete** — server-side `dailyCount` check + increment in `/api/transcribe`, 429 when exhausted, `QuotaBadge`-equivalent status shown in `Dashboard`/`TranscribePanel` |
| 14 | UI refinement | **Complete** — `App.tsx` placeholder replaced with `Dashboard` + `EditorShell`, loading/error/empty states throughout, vendor bundle chunking |
| 15 | Final Phase 1 verification | **Complete** — see "Phase 1 completion pass" verification notes below |

## Timeline architecture foundation

Not one of the 15 numbered steps above — this is cross-cutting data-model
infrastructure, added now so Steps 6–12 (editor shell, overlays, captions,
export) don't have to be built on a single-track assumption that would
later need a rewrite. Per the approved architecture, every overlay (video,
image, text, caption, audio) is an independent timeline item with its own
track, timing, and z-order — never a property attached to a "main clip".

**Status: Complete (foundation only — no editor UI, no render engine).**

- Added `src/types/timeline.ts` — `Project` / `Track` / `TimelineItem`
  (discriminated union: `VideoTimelineItem`, `ImageTimelineItem`,
  `TextTimelineItem`, `CaptionTimelineItem`, `AudioTimelineItem`) /
  `MediaAsset` types, with `TIMELINE_SCHEMA_VERSION` for future migrations.
- Added `src/lib/timeline/utils.ts` — project/track/item construction,
  timing queries (`getItemDuration`, `getProjectDuration`,
  `itemsOverlapInTime`, `getItemsAtTime`, `getItemsByTrackType`).
- Added `src/lib/timeline/validation.ts` — `validateProject` /
  `assertValidProject`, rejecting malformed data (bad timing, wrong
  track-type placement, dangling track/media references, out-of-range
  values, duplicate ids) rather than silently accepting or coercing it.
- Added `src/lib/timeline/serialization.ts` — `serializeProject` /
  `deserializeProject` / `parseProject`, producing the Firestore-safe
  plain-object shape a `projects/{id}` document will use once Step 3
  (Shared storage) wires up the actual read/write path.
- Added `test-timeline-foundation.mts` — 33 automated checks covering
  construction, timing queries, validation (both accept and reject cases),
  and serialization round-trips, including a sample project that exercises
  every track type simultaneously (2 independent video layers, a watermark
  image, a title, AI captions, and 3 independent audio tracks — original,
  music, voiceover — all overlapping in time). 33/33 passed.

**Explicitly not built yet (belongs to later steps):** the multi-track
editor UI, the render/export engine, and the actual Firestore
`projects/{id}` read/write endpoints on `server.ts`. Those are Step 3
onward, not part of this foundation.

**Deviation from a literal reading of the spec:** `duration` is not a
stored field on `TimelineItem` (only `startTime`/`endTime` are). Storing
both would let them drift out of sync on an edit that updates one but not
the other; `getItemDuration()` derives it on demand instead. Flagging this
since the original list of required fields named `duration` explicitly.

## Source-of-feature log

Per the approval rules, every ported feature must document its origin app. Logged here as steps complete:

- **Step 1 (foundation):** boilerplate pattern sourced from `riddimroom-caption`'s `server.ts`/`vite.config.ts`/`tsconfig.json` (near-identical AI-Studio scaffold shared by both legacy apps).
- **Step 2 (authentication):** auth state machine, LoginPage, ProtectedRoute, and `/api/user/status` sourced from `riddimroom-caption`'s `App.tsx` + `ProtectedRoute.tsx` + `server.ts`. Extracted into a shared context/middleware per your requirement; in-memory Firestore fallback intentionally dropped (documented reasons in `server.ts` and `CHANGELOG.md`); `status` field default deviates from EventCam's `'pending'` to `'approved'` (documented reason in `src/types/user.ts`).
- **Timeline foundation:** track/z-index concept generalizes the `track: number` field already proven on BoltVideoApp's `TextOverlay`/`CaptionTrack` from text-only to all five media types. `CaptionTimelineItem.words` reuses BoltVideoApp's `WordTiming` shape (itself sourced from `riddimroom-caption`'s `WordCaption`). `ImageTimelineItem` position/opacity fields reuse EventCam's percentage-based `WatermarkSettings`/`TextOverlaySettings` shape. `VideoTimelineItem` trim/speed/crop/colorGrade fields reuse BoltVideoApp's `VideoClipSettings`, moved from "attached to a clip" to "fields on an independent timeline item" per the approved architecture. Full detail in code comments at the top of `src/types/timeline.ts`.

## Step 2 verification notes

- **Live-tested** against a real Firebase Auth Emulator (Java 21 + firebase-tools, both provisioned locally since the sandbox lacked them) and the actual dev + production server builds: email registration, email login (correct + wrong password), password reset request, missing/invalid/tampered token rejection, valid-token acceptance, freshly-registered-token acceptance (session persistence proxy). 9/9 automated checks passed (`test-auth-integration.mjs`, kept in the repo for reuse in later steps).
- **Found and fixed two real bugs during this testing** (see CHANGELOG Step 2 "Bugs found and fixed"): missing try/catch around Firestore ops in `/api/user/status`, and a missing process-level `unhandledRejection` handler — both would have caused a crash or hang under real Firestore load, not just in testing.
- **Verified by code review, not live execution:** Google Sign-In popup flow, browser session persistence across reloads, and ProtectedRoute's redirect behavior. These require a real browser executing against the live Firebase project; the sandbox environment used for this build has no way to drive a real OAuth popup or reload a live page against `localhost`. All three are unmodified ports of caption's exact, already-proven-working Firebase SDK calls (`signInWithPopup`, `setPersistence`, `onAuthStateChanged`-driven redirect) — traced line-by-line against caption's working source. Recommend a manual smoke test against the deployed app once Step 2 ships to Vercel, or before Phase 1 sign-off at the latest.
- **Not tested (needs real Firestore credentials):** the exact shape of newly-created/updated Firestore documents (schema defaults, quota reset). The Firestore emulator's binary could not be downloaded in this sandbox (`storage.googleapis.com` is blocked by the network allowlist, and no alternate mirror exists). Verified instead by direct code trace of `/api/user/status` against the required field list — all 15 `UserProfile` fields are set with the specified defaults on creation, and only `lastLogin`/`lastUpdated`/`dailyCount`/`lastTranscribeDate` change on update. Recommend confirming the first real login against the live `riddimroom-studio` Firestore project.

## Timeline foundation verification notes

- `npx tsc --noEmit`: clean, zero errors.
- `npm run build`: clean (same pre-existing `import.meta`/cjs warning from `server.ts` that predates this change — not introduced here). Output bundle size unchanged from before this work, since nothing in the app imports the new timeline modules yet (no UI wiring at this stage, by design).
- `npx tsx test-timeline-foundation.mts`: 33/33 passed — construction/queries, validation accept + reject cases, and serialization round-trips.
- **Regression check on Step 2 (authentication), re-run in full rather than assumed safe:** `test-auth-integration.mjs` re-run against a freshly started Firebase Auth Emulator and the real dev server — 9/9 passed, unchanged from Step 2. None of Step 2's files (`AuthContext.tsx`, `LoginPage.tsx`, `ProtectedRoute.tsx`, `router.ts`, `types/user.ts`, `server.ts`) were touched by this work.
- Repository line-ending state: confirmed still clean (`core.autocrlf false` local config from the prior cleanup holds; new files were authored with LF endings from the start).

## Phase 1 completion pass (Steps 3–15)

Implements the remaining Phase 1 scope in one continuous pass per your
approval, on top of the existing flat-repo/React+Vite+TS/Express/Firebase
architecture — no migration to a monorepo, no replacement of Steps 1–2 or
the timeline foundation, no parallel data model. Every new feature reads/
writes through `Project`/`TimelineItem` (the timeline foundation) — there
is exactly one timeline representation in this codebase.

**New modules, by area:**
- `src/lib/media/{probe,validate,upload}.ts` — file probing (duration/
  dimensions), validation (type/size), real Firebase Storage upload with
  progress via `uploadBytesResumable`.
- `src/components/Editor/{CameraCapture,MediaImportPanel}.tsx` — capture +
  upload UI with retry-on-error.
- `src/lib/projects/persistence.ts` — `projects/{projectId}` create/load/
  save/list/delete via the Firestore client SDK.
- `src/context/ProjectContext.tsx` — the editor's single source of truth
  for the `Project` being edited (mirrors `AuthContext`'s pattern).
- `src/components/{Dashboard,Editor/EditorShell,Editor/PreviewPane,
  Editor/TimelinePanel,Editor/ItemInspector}.tsx` — the actual product UI.
- `src/lib/timeline/insert.ts` — editor-facing construction helpers
  (`appendMediaToTimeline`, `addTextItem`, `addWatermarkItem`,
  `addCaptionItems`) on top of the existing `utils.ts`, plus a new
  `updateItem` added to `utils.ts` itself (a real gap — Step 6 was the
  first caller that needed to patch an existing item's fields).
- `src/lib/render/compositor.ts` — `drawFrame`, shared verbatim by
  `PreviewPane` (live preview) and `Canvas2DRenderer` (export), so preview
  and export can't drift apart into two implementations.
- `src/lib/transcription/{types,gemini,whisper,index}.ts` +
  `POST /api/transcribe` in `server.ts` — provider abstraction, Gemini
  primary, Whisper fallback, server-side quota gate.
- `src/lib/backgroundRemoval/index.ts` + `BackgroundRemovalButton.tsx` —
  provider abstraction around `@imgly/background-removal`.
- `src/lib/export/{renderer,canvas2dRenderer,validate}.ts` +
  `ExportPanel.tsx` — renderer abstraction, working Canvas2D/MediaRecorder/
  WebAudio implementation, output validation.
- `src/components/Editor/{AddTextPanel,WatermarkPanel,TranscribePanel}.tsx`
  — overlay/AI panels wired into `EditorShell`.

**Architecture decisions made without stopping for approval (per your
"make a reasonable decision and continue" instruction):**
- **`projects/{projectId}` persistence goes client SDK direct, not through
  `server.ts`.** The earlier roadmap tentatively suggested mirroring
  `/api/user/status`'s server-mediated pattern; on implementation, the
  reason that pattern exists for `users/{uid}` (role/status/quota must
  never be client-writable) doesn't apply to `Project` — every field on it
  is the owning user's own editorial data, and `firestore.rules` already
  enforces per-document ownership. Documented in
  `src/lib/projects/persistence.ts`.
- **`listProjects` sorts client-side, not via Firestore `orderBy`.**
  `where('ownerUid','==',uid) + orderBy('updatedAt')` on different fields
  needs a composite index provisioned in the Firebase console — an out-of-
  repo manual step. Sorting the (capped) result client-side avoids that
  dependency.
- **Media sizing convention in `compositor.ts`:** `video` items fill the
  canvas at `scale: 1`; `image` items draw at 25% canvas width at
  `scale: 1`, aspect-preserved. Documented in the module since the data
  model stores percentages/multipliers, not pixels.
- **Caption style catalog reduced from caption's 17 styles to 3
  (`src/lib/captions/styles.ts`)** — 3 real, distinct, working styles
  rather than 17 stub entries that don't actually render differently.
  Extending the array (not the data model) is how a later pass restores
  the rest.
- **Export renderer is client-side Canvas2D/MediaRecorder**, matching what
  all three legacy apps already did — behind a `Renderer` interface
  (`src/lib/export/renderer.ts`) specifically so a future server-side
  Cloud Run renderer can implement the same contract without touching
  `ExportPanel`. This was flagged as an open architectural decision in the
  pre-implementation roadmap; resolved here in favor of the renderer
  abstraction rather than leaving Step 12 unbuilt.
- **Whisper fallback implemented as a real HTTP-endpoint-backed provider
  (`WHISPER_API_URL`), not a hardcoded third-party integration** — per the
  roadmap, no confirmed Whisper deployment exists to port credentials for.
  Throws a clear `TranscriptionConfigurationError` when unset rather than
  faking a transcript or building unused infrastructure.
- **Bundle size:** `@imgly/background-removal`'s ONNX runtime (the
  multi-MB WASM model) is dynamically `import()`-ed only when background
  removal actually runs, so it never inflates the initial bundle (verified
  in `dist/` output — it's its own lazy chunk). Added `manualChunks` in
  `vite.config.ts` to split the `firebase` and `react` vendor bundles from
  app code, so app-code changes don't invalidate those (larger, more
  stable) chunks' cache.

**Known operational requirement, not a code defect:** canvas-based preview/
export requires the Firebase Storage bucket to serve media with CORS
enabled for the app's origin — added `storage.cors.json` at the repo root
(apply once via `gsutil cors set storage.cors.json gs://<bucket>`, a real
GCP credential this sandbox does not have and cannot apply itself).
Without it, `<video>`/`<img>` playback in the app still works normally;
only canvas capture (export) is affected, and `validateRenderResult`
catches the resulting near-empty output rather than reporting a false
success.

**Source-of-feature additions to the log above:**
- **Capture:** `getUserMedia`/`MediaRecorder` flow re-implemented against
  this app's component structure from EventCam's proven approach (not a
  verbatim port — EventCam's version was tightly coupled to its own
  single-screen `App.tsx`).
- **Watermark/Text overlays:** EventCam's percentage-based
  `WatermarkSettings`/`TextOverlaySettings` fields, already generalized
  into `ImageTimelineItem`/`TextTimelineItem` by the timeline foundation —
  this step is the first real UI writing those fields.
- **Caption engine:** `CaptionTimelineItem.words` shape unchanged from the
  timeline foundation (BoltVideoApp's `WordTiming`, itself from caption's
  `WordCaption`). Cue-chunking (`addCaptionItems`'s `maxCueDurationSeconds`
  splitting) is new — none of the three legacy apps needed it in quite
  this form since caption's Whisper pipeline produced cues directly.
- **Export:** Canvas2D + `MediaRecorder` technique — the same fundamental
  approach BoltVideoApp/EventCam/caption each used for their own exports,
  applied here against the shared `Project` model instead of per-app clip
  state.
- **Quota enforcement:** `dailyCount`/`lastTranscribeDate` reset logic
  reused verbatim from `/api/user/status` (Step 2), now actually
  incremented by a real quota-consuming operation for the first time.

## Phase 1 completion pass — verification notes

- `npx tsc --noEmit`: clean, zero errors, across every new/changed file.
- `npm run build`: clean (same pre-existing `import.meta`/cjs warning in
  `server.ts`, unrelated to this work). Main app chunk now split from the
  `firebase` and `react` vendor chunks (see decisions above);
  `@imgly/background-removal`'s ONNX runtime confirmed to load only as a
  separate, on-demand chunk.
- `npx tsx test-timeline-foundation.mts`: still 33/33 — the timeline
  foundation itself was not modified (only extended, via the new
  `updateItem` in `utils.ts`, which is additive).
- `npx tsx test-editor-foundation.mts` (new, 25 checks): `appendMediaToTimeline`
  sequential placement, `addTextItem`/`addWatermarkItem`/`addCaptionItems`
  (including transcript chunking), `updateItem`, `validateMediaFile`,
  `mediaKindForMimeType`, `validateRenderResult` — 25/25 passed.
- `npx tsx test-transcription-providers.mts` (new, 4 checks): both
  providers throw `TranscriptionConfigurationError` — not a fake result —
  when unconfigured, and confirmed Gemini's provider never calls `fetch()`
  before that check fails. 4/4 passed.
- **Regression, re-run in full against a freshly started Firebase Auth
  Emulator + the real dev server, not assumed safe:** `test-auth-integration.mjs`
  — 9/9 passed (timeout raised 10s->20s; this sandbox has no reachable
  real Firestore, so even a valid-token request now waits out the Admin
  SDK's ~8.5s credential-resolution retry before its own try/catch
  returns a clean 500 — documented in the test file; this is the route
  correctly failing closed, not a hang, and not a regression from this
  work).
- **New live test against the real dev server + Auth Emulator:**
  `test-transcribe-endpoint.mjs` (6 checks) — verifies the parts of
  `POST /api/transcribe` that don't require a reachable Firestore backend:
  401 with no/invalid token, 400 on missing `storageUrl`/`mimeType`, and
  403 when the supplied `storageUrl` doesn't belong to the caller's own
  Storage path — all confirmed to short-circuit *before* any Firestore or
  transcription-provider call. 6/6 passed.
- **Firestore- and Storage-emulator-dependent testing was not possible in
  this sandbox**, unlike the Auth emulator: both the Firestore and Storage
  emulators require downloading a Java `.jar` from `storage.googleapis.com`
  at first launch, which the sandbox's network allowlist blocks (same
  class of restriction that blocked the Auth emulator's optional web UI in
  Step 2 — that one has no jar and only needed `"ui":{"enabled":false}` to
  route around; the emulators themselves have no such workaround). This
  means `projects/{projectId}` and Storage `firestore.rules`/`storage.rules`
  enforcement, and the Firestore-dependent portion of `/api/transcribe`
  (quota read/increment, provider dispatch), are verified by code review
  and the client-side ownership double-check in `loadProject`
  (`src/lib/projects/persistence.ts`) rather than a live emulator run.
  Recommend a manual smoke test against the real `riddimroom-studio`
  Firebase project before/at Phase 1 sign-off — same recommendation Step 2
  already made for Firestore document shape, now extended to cover
  `projects/{projectId}` and Storage uploads too.
- **Export engine — genuinely verified to produce usable output**, not
  just code-reviewed: a headless-Chromium (Playwright) smoke test
  (`test-export-browser/`, not part of `npm run build`/`lint` — requires
  `npm install --no-save playwright`, see that folder's `run.mjs` header)
  builds a real `Project` (video + text overlay + watermark + captions)
  against a same-origin synthetic 3-second source video (avoiding the
  separate CORS operational requirement above so this test isolates the
  renderer's own mechanics), runs the actual `Canvas2DRenderer`, and
  confirms: a non-empty `video/webm` blob, duration matching the project
  (~3s), progress callbacks firing, and `validateRenderResult` accepting
  the result. 6/6 checks passed (243KB output for a 3s multi-layer
  export — a real, plausible file size, not a near-empty stub).
- **Manual end-to-end smoke test against a live Firebase project was not
  performed** — this sandbox has no real, reachable Firebase project
  (same limitation as Step 2/timeline-foundation). The 19-step smoke test
  you specified (sign in -> create project -> upload -> ... -> export ->
  quota -> unauthorized-access) is covered piecewise by the automated
  suites above (auth: Step 2's suite; capture/upload: code review +
  `validateMediaFile`/`probe` unit coverage; project persistence: code
  review + ownership double-check; overlays/captions: `test-editor-foundation.mts`;
  export: the live browser smoke test; quota/ownership: `test-transcribe-endpoint.mjs`)
  but has not been run as one continuous session against real
  infrastructure. Recommend doing that pass once real Firebase
  credentials and a `GEMINI_API_KEY` are available.

**Remaining external configuration requirements (not code blockers):**
1. Storage bucket CORS (`storage.cors.json`, apply via `gsutil`) — needed
   for canvas-based preview/export, not for ordinary playback/upload.
2. `GEMINI_API_KEY` — still the `.env.example` placeholder in this build;
   `/api/transcribe` returns a clear 503 configuration error until a real
   key is set, never a fake transcript.
3. `WHISPER_API_URL` — optional, unset by default; no confirmed Whisper
   deployment exists to point it at yet (see Risks in the earlier audit).
4. A Firestore composite index is **not** required (see the `listProjects`
   decision above) — noting this explicitly since it's the kind of thing
   that's easy to assume is needed and isn't.

## CORS + broken-canvas-image fix (post-Phase-1 live bug report)

**Bug reported:** loading an existing Artistly PNG from Firebase Storage in
the browser at `http://localhost:3000` failed with a CORS error
(`No 'Access-Control-Allow-Origin' header is present`) followed by
`net::ERR_FAILED`, followed by `compositor.ts:87 Uncaught
InvalidStateError: Failed to execute 'drawImage' ... 'broken' state` — this
is exactly the risk flagged (but not yet resolved) in the Phase 1
completion pass notes above: `storage.cors.json` existed in the repo but
was never actually applied to the real bucket, because neither this
sandbox nor the device environment has GCP credentials to run
`gsutil`/`gcloud`/`firebase` against the real `riddimroom-studio` project.
Re-verified fresh in this pass: `which gcloud gsutil firebase` and
`~/.config/gcloud` both come back empty on the device, and this sandbox
has network but no authenticated access to this specific GCP project — so
the CORS config is written and correct but **not applied**; that remains a
real action the project owner needs to perform (see below).

**Root cause, confirmed (not assumed):** a default Firebase Storage bucket
has no CORS configuration at all — every cross-origin `<img
crossOrigin="anonymous">`/`<video crossOrigin="anonymous">` request to it
fails at the browser's CORS check regardless of whether the request would
otherwise have been authorized. This is independent of `storage.rules`:
confirmed via a fresh read of `src/lib/media/upload.ts` that
`getDownloadURL()` returns real, unmodified Firebase Storage URLs (no
proxying), and confirmed via Firebase's own documented behavior that the
token embedded in a download URL is itself the access-control mechanism
for that specific object once obtained — a plain `<img>` GET to it does
not send an `Authorization` header and is not gated by `storage.rules` a
second time at fetch time. That means the reported failure is a genuine,
isolated CORS-configuration gap, not a masked authorization problem —
**`storage.rules` was reviewed and is unchanged and does not need to
change.**

**Fixes applied (smallest safe change, per your explicit constraint):**
1. `storage.cors.json` rewritten to the precise spec requested: origin
   restricted to `http://localhost:3000` (no bare `*`), methods
   `GET, HEAD, OPTIONS` (added `OPTIONS` for the preflight itself),
   response headers `Content-Type, Authorization`. No production origin
   was added because none exists yet in this repo — `firebase.json` has no
   `hosting` block, there's no Dockerfile/Cloud Build config, and
   `.env.example`'s `APP_URL` is still the literal placeholder
   `"MY_APP_URL"`. **Add the real production origin to this file's
   `origin` array once one exists, then re-run the command below.**
2. **Still not applied to the real bucket** — no GCP credentials are
   reachable from this sandbox or the device environment. The exact
   command to run once, from a machine with `gcloud`/`gsutil`
   authenticated against the `riddimroom-studio` project:
   ```
   gsutil cors set storage.cors.json gs://riddimroom-studio.firebasestorage.app
   ```
   or, with the newer `gcloud storage` surface:
   ```
   gcloud storage buckets update gs://riddimroom-studio.firebasestorage.app --cors-file=storage.cors.json
   ```
3. `src/lib/render/compositor.ts` — added `isImageReady(img)` (`img.complete
   && img.naturalWidth > 0 && img.naturalHeight > 0`, the standard way to
   tell a successfully-loaded image apart from a broken one) and gated
   `drawFrame`'s `image` case on it before ever calling `drawImageItem`;
   also wrapped `drawImageItem`'s `ctx.drawImage()` call in the same
   try/catch pattern `drawVideoItem` already used, as defense in depth.
   This is a render-loop safety net only — it does **not** fix or mask the
   CORS root cause; a broken image is now silently skipped for that frame
   instead of crashing the whole render/animation loop.
4. `src/components/Editor/PreviewPane.tsx` — `getImageEl` now attaches an
   `onerror` handler that `console.warn`s the failed asset id/URL, purely
   for diagnostics. It does not change what gets drawn (that's
   `compositor.ts`'s job) and does not retry or substitute a fallback
   image.

**Validation performed:**
- `npx tsc --noEmit`: clean.
- `npm run build`: clean (same pre-existing unrelated `import.meta`/cjs
  warning in `server.ts`).
- Full existing regression suite re-run, nothing skipped:
  `test-timeline-foundation.mts` 33/33, `test-editor-foundation.mts`
  25/25, `test-transcription-providers.mts` 4/4, `test-auth-integration.mjs`
  9/9 (against a freshly started Auth Emulator + real dev server),
  `test-transcribe-endpoint.mjs` 6/6 (same) — 77/77 passed, zero skipped,
  zero new failures.
- `test-export-browser/` (headless Chromium/Playwright), re-run after the
  `compositor.ts` change since it exercises `drawImageItem`/`isImageReady`
  on a real (same-origin, data-URL) watermark image: 6/6 checks passed,
  222KB real `video/webm` output — confirms the new readiness gate does
  not regress the working-image path.
- **What was not, and could not be, verified from this environment:**
  loading a real `https://firebasestorage.googleapis.com/...` image in an
  actual browser at `http://localhost:3000` after the CORS config is
  applied. This sandbox and the device bridge have no way to open a real
  browser against the user's live Firebase project with real uploaded
  assets and observe the network/console. **The CORS fix itself has not
  been applied to the real bucket** (see step 2 above) — until that gsutil/
  gcloud command is run, the original bug will still reproduce exactly as
  reported, because the code-side fixes (3 and 4) are a safety net for
  *already-broken* images, not a substitute for the actual CORS headers a
  successful cross-origin image load requires. Once the CORS command is
  run, the recommended check is: hard-refresh `http://localhost:3000`,
  open an existing project with a Firebase-Storage-backed image, confirm
  no CORS error in the console, and confirm the image renders in the
  preview canvas.
