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

## Source-of-feature log

Per the approval rules, every ported feature must document its origin app. Logged here as steps complete:

- **Step 1 (foundation):** boilerplate pattern sourced from `riddimroom-caption`'s `server.ts`/`vite.config.ts`/`tsconfig.json` (near-identical AI-Studio scaffold shared by both legacy apps).
- **Step 2 (authentication):** auth state machine, LoginPage, ProtectedRoute, and `/api/user/status` sourced from `riddimroom-caption`'s `App.tsx` + `ProtectedRoute.tsx` + `server.ts`. Extracted into a shared context/middleware per your requirement; in-memory Firestore fallback intentionally dropped (documented reasons in `server.ts` and `CHANGELOG.md`); `status` field default deviates from EventCam's `'pending'` to `'approved'` (documented reason in `src/types/user.ts`).

## Step 2 verification notes

- **Live-tested** against a real Firebase Auth Emulator (Java 21 + firebase-tools, both provisioned locally since the sandbox lacked them) and the actual dev + production server builds: email registration, email login (correct + wrong password), password reset request, missing/invalid/tampered token rejection, valid-token acceptance, freshly-registered-token acceptance (session persistence proxy). 9/9 automated checks passed (`test-auth-integration.mjs`, kept in the repo for reuse in later steps).
- **Found and fixed two real bugs during this testing** (see CHANGELOG Step 2 "Bugs found and fixed"): missing try/catch around Firestore ops in `/api/user/status`, and a missing process-level `unhandledRejection` handler — both would have caused a crash or hang under real Firestore load, not just in testing.
- **Verified by code review, not live execution:** Google Sign-In popup flow, browser session persistence across reloads, and ProtectedRoute's redirect behavior. These require a real browser executing against the live Firebase project; the sandbox environment used for this build has no way to drive a real OAuth popup or reload a live page against `localhost`. All three are unmodified ports of caption's exact, already-proven-working Firebase SDK calls (`signInWithPopup`, `setPersistence`, `onAuthStateChanged`-driven redirect) — traced line-by-line against caption's working source. Recommend a manual smoke test against the deployed app once Step 2 ships to Vercel, or before Phase 1 sign-off at the latest.
- **Not tested (needs real Firestore credentials):** the exact shape of newly-created/updated Firestore documents (schema defaults, quota reset). The Firestore emulator's binary could not be downloaded in this sandbox (`storage.googleapis.com` is blocked by the network allowlist, and no alternate mirror exists). Verified instead by direct code trace of `/api/user/status` against the required field list — all 15 `UserProfile` fields are set with the specified defaults on creation, and only `lastLogin`/`lastUpdated`/`dailyCount`/`lastTranscribeDate` change on update. Recommend confirming the first real login against the live `riddimroom-studio` Firestore project.
