import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type { Connect, Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * `/a10` → 301 `/a10/` in dev and preview, as GitHub Pages does for a folder. Without it the
 * SPA fallback answers `/a10` with the carrier's index.html.
 */
function a10TrailingSlash(): Plugin {
  const redirect: Connect.NextHandleFunction = (req, res, next) => {
    const [path, query] = (req.url ?? '').split('?');
    if (path !== '/a10') return next();
    res.statusCode = 301;
    res.setHeader('Location', query ? `/a10/?${query}` : '/a10/');
    res.end();
  };
  return {
    name: 'a10-trailing-slash',
    configureServer: (server) => void server.middlewares.use(redirect),
    configurePreviewServer: (server) => void server.middlewares.use(redirect),
  };
}

// `base: './'` keeps the build relocatable (GitHub Pages project sites, Vercel, file servers).
// VITE_CACHE_DIR lets several dev servers run side by side without fighting over the dep cache.
// Two pages: the carrier app at / and the A-10 simulator at /a10/ (docs/a10/ARCHITECTURE.md §1).
// The entry key `index` keeps the carrier's chunk names (assets/index-<hash>.js).
export default defineConfig({
  base: './',
  plugins: [react(), a10TrailingSlash()],
  cacheDir: process.env.VITE_CACHE_DIR ?? 'node_modules/.vite',
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600,
    rolldownOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        a10: resolve(import.meta.dirname, 'a10/index.html'),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
