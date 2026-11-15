import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// `base: './'` keeps the build relocatable (GitHub Pages project sites, Vercel, file servers).
// VITE_CACHE_DIR lets several dev servers run side by side without fighting over the dep cache.
export default defineConfig({
  base: './',
  plugins: [react()],
  cacheDir: process.env.VITE_CACHE_DIR ?? 'node_modules/.vite',
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
