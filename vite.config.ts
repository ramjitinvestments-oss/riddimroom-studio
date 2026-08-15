import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
