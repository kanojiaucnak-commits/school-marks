import { copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Make client-side routing work on GitHub Pages.
 *
 * Cloudflare Pages had a `_redirects` file that turned every unknown path into
 * index.html. GitHub Pages has no equivalent rewrite rule — it serves a real 404
 * for any path that does not match a file on disk.
 *
 * The documented workaround is to publish a copy of index.html as 404.html.
 * Pages returns it with a 404 status for unmatched paths, but critically the
 * browser's address bar still holds the original path, so React Router sees
 * /app/students and renders the right route instead of treating the load as a
 * cold start at "/".
 *
 * The copy works because Vite emits asset URLs against `base`, so the same
 * markup resolves correctly no matter which file serves it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');
const index = resolve(dist, 'index.html');
const notFound = resolve(dist, '404.html');

if (!existsSync(index)) {
  console.error('[postbuild] dist/index.html not found — did the build run?');
  process.exit(1);
}

copyFileSync(index, notFound);
console.log('[postbuild] wrote dist/404.html for GitHub Pages SPA routing');