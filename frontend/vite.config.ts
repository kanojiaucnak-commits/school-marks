import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Deployment target: GitHub Pages.
 *
 * `base` must include the repository name, because Pages serves every project
 * from `https://<user>.github.io/<repo>/`. A wrong base produces a page that
 * loads and then 404s on its own JS and CSS.
 *
 * Set to '/' for a custom domain or a local-only build.
 */
const BASE = process.env.VITE_BASE_PATH ?? '/school-marks/';

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