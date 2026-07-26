import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'ui',
  // The UI is served under /s/<token>/, so all asset URLs must be relative.
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
});
