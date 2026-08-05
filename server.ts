/**
 * RiddimRoom Studio — Cloud Run backend.
 *
 * Phase 1, Step 1 (Project foundation): dev/prod server boilerplate + health
 * check only. Authenticated API routes (auth session, media upload/transcribe/
 * export, admin, quota) are added in their own build steps per the approved
 * Phase 1 plan — not stubbed here.
 */
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

// Dev runs this file directly as ESM (tsx); prod runs the esbuild CJS bundle,
// where __dirname is a native CJS global and import.meta.url is unavailable.
// Resolve whichever is actually present instead of assuming one or the other.
declare const __dirname: string | undefined;
const currentDir =
  typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(new URL(import.meta.url).pathname);

const isProd = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;

async function createServer() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'riddimroom-studio', timestamp: new Date().toISOString() });
  });

  if (isProd) {
    // server.cjs is bundled into dist/ alongside the built index.html/assets,
    // so at runtime currentDir *is* the static root — not dist/dist.
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

  app.listen(PORT, () => {
    console.log(`[riddimroom-studio] listening on port ${PORT} (${isProd ? 'production' : 'development'})`);
  });
}

createServer();
