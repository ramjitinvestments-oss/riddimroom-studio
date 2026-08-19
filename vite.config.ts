import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    // @ffmpeg/ffmpeg spins up a Web Worker via
    // `new Worker(new URL('./worker.js', import.meta.url))` inside its own
    // package. Vite's default dev-time dependency pre-bundling (esbuild)
    // rewrites that in a way that breaks the worker's ability to resolve
    // and load its own script in dev mode — the Worker gets created but
    // never responds, so `ffmpeg.load()` hangs forever with no error and
    // no timeout (confirmed live: no worker script network request ever
    // fired, and no console error, but nothing progressed for 3+ minutes).
    // Excluding both packages from pre-bundling is the fix documented by
    // the ffmpeg.wasm project for exactly this Vite dev-server symptom.
    // Production builds are unaffected (Vite's build-time bundler resolves
    // the worker correctly either way — confirmed by the `dist/assets/worker-*.js`
    // chunk already present in `npm run build` output).
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // Splits the two largest, rarely-changing vendor libraries into
        // their own cacheable chunks (Phase 1 Step 14 bundle-size pass —
        // see PROGRESS.md Risks). @imgly/background-removal's ONNX runtime
        // is already excluded from this concern: it's dynamically
        // `import()`-ed only when background removal actually runs (see
        // src/lib/backgroundRemoval/index.ts), so Vite already emits it as
        // its own lazy chunk without any manualChunks entry.
        manualChunks: {
          firebase: ['firebase/app', 'firebase/auth', 'firebase/firestore', 'firebase/storage'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
