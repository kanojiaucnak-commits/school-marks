import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/**
 * Test config for `@school/shared`.
 *
 * Its one job is making the Edge Function sources loadable under Node.
 *
 * `supabase/functions/_shared/` is written for Deno and imports its dependencies by
 * Deno specifier — `npm:fflate`, `jsr:@db/postgres`. Neither resolves in Node, so
 * these helpers were previously untestable: the XLSX writer and the SQL builder, the
 * two pieces most likely to be subtly wrong and hardest to notice, had no coverage
 * at all and had never been executed.
 *
 * Aliasing `npm:fflate` to the real package means the workbook is genuinely built
 * and its bytes genuinely zipped in these tests — not a stub that proves nothing.
 *
 * `@db/postgres` is deliberately *not* aliased: `sql.test.ts` mocks
 * `_shared/postgres.ts` outright, because the only reason that module exists is to
 * open a connection, and a test must not.
 *
 * `jsr:@supabase/supabase-js@2` maps to the *real* npm package, not a stub. Aliasing
 * it to a stub would be the cheaper option and the wrong one: `_shared/auth.ts` gets
 * imported purely to reach the pure `readClerkIdentity` helper, and a stubbed
 * `createClient` would let a genuine change to how the auth client is constructed
 * pass unnoticed. The workspace already installs the real package for the frontend,
 * so using it costs nothing and hides nothing.
 */
export default defineConfig({
  resolve: {
    // Array form, and a pattern rather than a string: the sources import the
    // *versioned* specifier `npm:fflate@0.8.2`, so an exact-string alias for
    // `npm:fflate` silently fails to match and the test dies on resolution.
    alias: [
      { find: /^npm:fflate(@[\w.]+)?$/, replacement: 'fflate' },
      { find: /^jsr:(@[\w-]+\/)?@supabase\/supabase-js(@[\w.]+)?$/, replacement: '@supabase/supabase-js' },
      { find: /^@\//, replacement: `${fileURLToPath(new URL('./src', import.meta.url))}/` },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
  },
});
