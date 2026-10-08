import { Pool } from 'jsr:@db/postgres@0.19';
import { poolerUrl } from './pooler.ts';
import { jsonSafe } from './json.ts';
import { encodeParams } from './params.ts';

/**
 * Direct Postgres access from an Edge Function, impersonating the caller.
 *
 * ── Why this exists ────────────────────────────────────────────────────────────
 *
 * PostgREST is the usual path from the browser to the database, and it is what
 * this project was originally built against. It cannot be used here: PostgREST
 * verifies bearer tokens itself against `PGRST_JWT_SECRET`, which Supabase sets
 * through container configuration. Clerk issues RS256 tokens; PostgREST only knows
 * Supabase's own ES256 key, so every request fails with `PGRST301 / "No suitable
 * key or wrong key type"`.
 *
 * Third-party auth would fix that, but it could not be enabled from here: the
 * dashboard did not apply it and `supabase config push` silently omits the
 * `auth.third_party` block. Minting Supabase-signed tokens is also out, because
 * the project JWT secret is not retrievable — not through the Management API, not
 * from the database, and Vault holds zero secrets.
 *
 * So this module talks to Postgres directly and sets the identity up the same way
 * PostgREST would have.
 *
 * ── Why this does not weaken RLS ───────────────────────────────────────────────
 *
 * The tempting shortcut is to use the service role, which every function already
 * has. That would be a serious regression: `service_role` has BYPASSRLS, so no
 * policy would run and the repository would become the only thing authorising
 * access.
 *
 * Instead every statement runs as `authenticated`, reached via `SET LOCAL ROLE`.
 * That role does not bypass RLS, holds the same table grants PostgREST grants it,
 * and every policy in `0002_rls.sql` keys off `current_clerk_id()` — which reads
 * `request.jwt.claims`, the exact GUC PostgREST sets. Injecting it here means the
 * policies evaluate with no change whatsoever.
 *
 * Verified against this project before being written:
 *   current_user     = authenticated   (not service_role)
 *   current_clerk_id = user_…          (the caller)
 *   students visible = 0 for an unassigned teacher
 *
 * ── A note on the driver ──────────────────────────────────────────────────────
 *
 * `@db/postgres` has changed both its pool accessor (`connect` → `getConnection`)
 * and its query methods across versions, and neither difference is caught at build
 * time — a wrong guess is a runtime `TypeError`. Everything below therefore probes
 * for the method rather than assuming, and normalises the result shape. This is not
 * defensive style for its own sake: the first version of this file guessed `get()`
 * and every query failed.
 */

const DATABASE_URL = Deno.env.get('SUPABASE_DB_URL');

let pool: Pool | null = null;

function getPool(): Pool {
  if (!DATABASE_URL) {
    throw new Error(
      'SUPABASE_DB_URL is not set. It is injected automatically into Edge Functions; ' +
        'if you are running locally, run with `supabase functions serve`.',
    );
  }

  pool ??= new Pool(
    poolerUrl(
      DATABASE_URL,
      Deno.env.get('PG_POOLER_HOST'),
      // 6543 is transaction mode, which suits this workload: every statement is short
      // and parameterised, there is no session state to preserve, and
      // `SET LOCAL ROLE authenticated` is scoped to a transaction — precisely the unit
      // the transaction pooler hands out.
      Deno.env.get('PG_POOLER_PORT'),
    ),
    2,
    // The third argument is `lazy`, not an options bag. `@db/postgres` exposes no
    // `prepare` setting anywhere — it is not in `ClientOptions` — so the
    // `{ prepare: false }` that used to sit here was being read as the boolean.
    // It type-checked against nothing, it never disabled preparing, and every Edge
    // Function has always run through the pooler with the driver's own defaults.
    //
    // `true` is kept deliberately: it is the behaviour production has actually been
    // running with, opening connections on first use instead of two of them at
    // module load, which is what a cold Edge Function wants.
    true,
  );

  return pool;
}

type UnknownFn = (...args: unknown[]) => unknown;

/**
 * The driver's surface varies by version, so find the first method that exists
 * rather than hard-coding one spelling.
 */
function pick(target: unknown, names: string[]): UnknownFn | null {
  const record = target as Record<string, unknown> | null;
  if (!record) return null;
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'function') return (value as UnknownFn).bind(target);
  }
  return null;
}

interface ReleasableClient {
  release: () => void;
  [key: string]: unknown;
}

/** Normalise the several shapes a driver may return into a plain row array. */
function toRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown } | null)?.rows;
  if (Array.isArray(rows)) return rows;
  if (result === null || result === undefined) return [];
  return [result];
}

async function takeConnection(): Promise<ReleasableClient> {
  const candidate = getPool() as unknown as Record<string, unknown>;
  const take = pick(candidate, ['getConnection', 'connect', 'get']);

  if (!take) {
    throw new Error(
      'The Postgres pool exposes none of getConnection(), connect() or get(). ' +
        'The @db/postgres API differs between versions; check the installed driver.',
    );
  }

  return (await take()) as ReleasableClient;
}

/** Execute one statement and return its rows. */
async function exec(client: ReleasableClient, query: string, params: unknown[]): Promise<unknown[]> {
  const run =
    pick(client, ['unsafe', 'queryObject', 'query']) ??
    pick(client, ['queryObjects']);

  if (!run) {
    throw new Error('The Postgres client exposes no usable query method.');
  }

  // Every statement in the application funnels through here, which is the only place
  // the bound parameters can be corrected before the driver sees them. See
  // `_shared/params.ts`: `@db/postgres` encodes *any* JavaScript array as a Postgres
  // array literal, so a `jsonb` argument or column holding an array — `save_marks_grid`'s
  // `p_rows`, `save_grading_scheme`'s `p_rules` — was sent as `{"{\"marks\":72}"}` and
  // rejected by the JSON parser with `Expected ":", but found "}"`.
  const encoded = encodeParams(params);

  // `jsonSafe` is applied here rather than at each call site: every Edge Function in
  // this directory returns driver output straight to `JSON.stringify`, so a BigInt
  // from any column would otherwise surface as an opaque 500.
  return toRows(await run(query, encoded)).map((row) => jsonSafe(row));
}

export interface CallerIdentity {
  /** The Clerk user id (`user_2aBc…`), i.e. `auth.jwt() ->> 'sub'`. */
  clerkUserId: string;
}

/** The query handle handed to callers. */
export interface Sql {
  query: <R = Record<string, unknown>>(query: string, params?: unknown[]) => Promise<R[]>;
}

async function withConnection<T>(
  prepare: (client: ReleasableClient) => Promise<void>,
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  const client = await takeConnection();

  const sql: Sql = {
    query: async <R>(query: string, params: unknown[] = []): Promise<R[]> => {
      const rows = await exec(client, query, params);
      return rows as R[];
    },
  };

  try {
    await prepare(client);
    return await fn(sql);
  } finally {
    try {
      client.release();
    } catch {
      // A connection that is already gone needs no release; swallowing this keeps
      // a failure here from masking the caller's own error.
    }
  }
}

/**
 * Run `fn` in a transaction that impersonates `caller` as `authenticated`.
 *
 * Everything happens inside one transaction so `SET LOCAL ROLE` and the claims GUC
 * are discarded on completion and cannot leak into the next request served by the
 * same pooled connection. A thrown error rolls back, so a failed query cannot leave
 * a partial write behind.
 */
export async function runAsCaller<T>(
  caller: CallerIdentity,
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  return withConnection(
    async (client) => {
      await exec(client, 'begin', []);
      try {
        await exec(client, 'set local role authenticated', []);

        // `is_local = true` keeps the claim scoped to this transaction. This is the
        // same GUC PostgREST populates, which is why the policies need no changes.
        await exec(client, 'select set_config($1, $2, true)', [
          'request.jwt.claims',
          JSON.stringify({ sub: caller.clerkUserId, role: 'authenticated' }),
        ]);
      } catch (caught) {
        await exec(client, 'rollback', []);
        throw caught;
      }
    },
    async (sql) => {
      try {
        const result = await fn(sql);
        await sql.query('commit');
        return result;
      } catch (caught) {
        await sql.query('rollback').catch(() => undefined);
        throw caught;
      }
    },
  );
}

/**
 * Same as {@link runAsCaller} but for statements that are not scoped to a caller.
 *
 * Used only by the catalogue lookups in `sql.ts`, which read `information_schema`
 * and `pg_proc`. Kept separate and separately named so that "read the schema" is
 * visibly a different privilege from "read a user's rows".
 */
export async function runPrivileged<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  return withConnection(async () => undefined, fn);
}

/** Close the pool. Used by tests and by nothing in the request path. */
export async function closePool(): Promise<void> {
  if (pool) {
    const closing = pool;
    pool = null;
    await closing.end();
  }
}