import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// `base: './'` keeps the build relocatable (GitHub Pages project sites, Vercel, file servers).
// VITE_CACHE_DIR lets several dev servers run side by side without fighting over the dep cache.
// Two pages: the carrier app at / and the A-10 simulator at /a10/ (docs/a10/ARCHITECTURE.md §1).
export default defineConfig({
  base: './',
  plugins: [react()],
  cacheDir: process.env.VITE_CACHE_DIR ?? 'node_modules/.vite',
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        a10: resolve(import.meta.dirname, 'a10/index.html'),
      },
    },
  },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
