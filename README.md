# RiddimRoom Studio

Unified production application replacing `riddimroom-caption`, `riddimroom-app` (EventCam), and `boltvideoapp`. One codebase, one Firebase project (`riddimroom-studio`), one authentication system, one editor.

See `riddimroom-studio-phase0-plan.md`, `riddimroom-studio-phase0-addendum.md`, and `riddimroom-studio-phase1-plan.md` (provided separately to the project owner) for the approved architecture and roadmap.

## Local development

```bash
npm install
cp .env.example .env.local   # fill in GEMINI_API_KEY when the AI transcription step lands
npm run dev
```

## Build

```bash
npm run build
npm start
```
