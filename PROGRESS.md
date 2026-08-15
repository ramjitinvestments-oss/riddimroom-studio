# Progress

Tracks completion status of each Phase 1 build-order step (see `riddimroom-studio-phase1-plan.md`). Updated continuously, per step, not just at phase end.

| # | Step | Status |
|---|------|--------|
| 1 | Project foundation | **Complete** — repo, Firebase project, codebase scaffold, all verified (tsc clean, dev + prod builds boot and serve correctly) |
| 2 | Authentication | **Complete** — Google + email/password auth, shared context, ProtectedRoute, Admin SDK middleware, unified user doc upsert; verified live against Firebase Auth emulator + real dev/prod server, plus code review for browser-only flows (see Step 2 completion report) |
| 3 | Shared storage | Not started |
| 4 | Capture | Not started |
| 5 | Upload | Not started |
| 6 | Shared editor shell | Not started |
| 7 | Background removal | Not started |
| 8 | Watermark overlay | Not started |
| 9 | Text overlay | Not started |
| 10 | AI transcription | Not started |
| 11 | Caption engine | Not started |
| 12 | Export engine | Not started |
| 13 | Quota enforcement | Not started |
| 14 | UI refinement | Not started |
| 15 | Final Phase 1 verification | Not started |

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
