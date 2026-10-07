import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Deployment target: GitHub Pages by default; Vercel when `VERCEL` is set.
 *
 * `base` prefixes every asset URL in the built HTML. A wrong base produces a
 * page that loads and then 404s on its own JS and CSS — which is exactly how
 * the first Vercel deployment broke: Pages serves from `/<repo>/`, Vercel
 * serves from the domain root, and one value cannot satisfy both.
 *
 * Resolution order: an explicit `VITE_BASE_PATH` always wins (the escape
 * hatch), then the `VERCEL` variable every Vercel build injects, then the
 * Pages default.
 */
const BASE =
  process.env.VITE_BASE_PATH ?? (process.env.VERCEL ? '/' : '/school-marks/');

export default defineConfig({
  base: BASE,

  plugins: [react()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  server: {
    port: 5173,
    strictPort: false,
    /**
     * No API proxy any more. The Worker is gone and the browser talks to Supabase
     * and Clerk directly, so there is no second origin to collapse. The proxy
     * existed only to make the session cookie behave as it did in production.
     */
  },

  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        /**
         * Split vendor code so an app-code change does not invalidate the
         * framework cache.
         *
         * `clerk` and `supabase` are split out because they are the two heaviest
         * dependencies and neither changes when application code does.
         */
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
          charts: ['recharts'],
          forms: ['react-hook-form', '@hookform/resolvers', 'zod'],
          clerk: ['@clerk/react'],
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },

  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});