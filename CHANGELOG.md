# Changelog

All notable changes to RiddimRoom Studio are documented here, in order, per the approved build process (small logical commits, changelog updated continuously).

## [Unreleased] — Phase 1

### Step 1 — Project foundation
- Initialized repository (`ramjitinvestments-oss/riddimroom-studio`, private).
- Provisioned new Firebase project `riddimroom-studio` (Blaze plan): Authentication (Email/Password + Google), Firestore (default database, nam5), Cloud Storage (`riddimroom-studio.firebasestorage.app`, US-EAST1), web app registered.
- Scaffolded React 19 + Vite 6 + TypeScript + Tailwind 4 frontend and Express + esbuild backend, matching the proven pattern from `riddimroom-caption` / `riddimroom-app`.
- Added `firestore.rules` and `storage.rules` implementing the unified user schema from the approved Phase 0 architecture (default-deny, merged role/status fields).
- Added `/api/health` endpoint.
