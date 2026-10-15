# RiddimRoom Studio — v1

Unified production application replacing `riddimroom-caption`, `riddimroom-app` (EventCam), and `boltvideoapp`. One codebase, one Firebase project (`riddimroom-studio`), one authentication system, one editor.

## v1 — what it is

Premium, SIMPLE video editor. 3-step flow:

1. **Capture / Upload** — record with live camera (9:16 / 16:9 / 1:1 / 4:5, logo + text overlay, brand slots, bg-removal, audio chain) or upload media. Pick from 12 curated templates.
2. **Edit + Captions** — multi-track timeline, transcribe (Gemini primary, Whisper fallback), edit words, split/merge captions, 12 caption styles + karaoke, PiP video overlay (talking-head / explainer, circle / rounded / square, border + shadow), text, watermark.
3. **Export** — real MP4 (H.264 + AAC via ffmpeg.wasm), resolution/FPS/bitrate picker, progress, preview = export. Plus SRT / VTT caption export.

Cloud hybrid: Firebase (`riddimroom-studio`) for auth / projects / storage / licensing. Browser does editing + export (like CapCut Web).

Licensing: **Free** (30s projects, 2 transcriptions/day, 3 exports/day, watermark on) + **Lifetime** one-time unlock ($35, up to 10 min projects, 10 transcriptions/day, unlimited exports, no watermark, all templates). Entitlement via Firestore `licenses/{uid}`, written only by the Stripe webhook. Stripe Checkout is a **stub** until `STRIPE_*` keys are set — no payment is taken in this build.

Deferred (NOT in v1): screen recording, cursor effects, annotations, quizzes, teleprompter.

## Local development

```bash
npm install
cp .env.example .env   # fill in GEMINI_API_KEY for transcription, STRIPE_* for checkout
npm run dev            # http://localhost:3000 (tsx server + Vite)
```

## Build

```bash
npm run build
npm start
```

## Tests / typecheck

```bash
npx tsc --noEmit
npm test
npm run build
```

CI (`.github/workflows/ci.yml`) runs all three on every push / PR to `main`.

## Firebase setup (needs user input — not run in this build)

1. **Deploy rules:**
   ```bash
   firebase deploy --only firestore:rules,storage
   ```
2. **Storage CORS** (required — without it, canvas export produces blank video):
   ```bash
   ./scripts/apply-storage-cors.sh
   # or: gcloud storage buckets update gs://riddimroom-studio.firebasestorage.app --cors-file=storage.cors.json
   ```
3. **Set env** in your hosting env (Cloud Run / .env): `GEMINI_API_KEY`, `FIREBASE_PROJECT_ID=riddimroom-studio`, `FIREBASE_SERVICE_ACCOUNT_JSON` (local only) or ADC on Cloud Run, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID_LIFETIME` (when ready to sell).
4. **Kill-switch:** set `config/global.disabled = true` in Firestore to block non-admin sign-ins (enforced in `/api/user/status`).

## Manual smoke checklist

- Sign in → create project (pick aspect) → upload → capture (camera) → add PiP (Step 2 → Video overlay) → transcribe (needs real `GEMINI_API_KEY`, else 503) → style captions → Export SRT/VTT → Export MP4 → check watermark on free vs off on lifetime (mock `licenses/{uid}` doc).

See `PROGRESS.md` / `CHANGELOG.md` for build history.
