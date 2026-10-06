/**
 * Database client for the browser.
 *
 * ── Why this is not supabase-js ───────────────────────────────────────────────
 *
 * This app authenticates with Clerk, and Clerk's tokens cannot reach PostgREST.
 * PostgREST verifies bearer tokens itself against `PGRST_JWT_SECRET`, which
 * Supabase sets through container configuration and which knows only Supabase's
 * own ES256 key. Clerk signs RS256, so every PostgREST request failed with
 * `PGRST301 / "No suitable key or wrong key type"`. Supabase's third-party auth
 * would fix this, but it could not be enabled from the CLI or the API, and
 * re-signing tokens locally needs the project JWT secret, which is not
 * retrievable. The full account is in `supabase/functions/_shared/postgres.ts`.
 *
 * So queries go to the `data-proxy` Edge Function instead. It verifies the Clerk
 * token, then runs the statement against Postgres as `authenticated` with
 * `request.jwt.claims` set, so **RLS evaluates exactly as it would have through
 * PostgREST**. This module is transport only: it decides nothing about what a
 * caller may see.
 *
 * ── Why the shape is unchanged ────────────────────────────────────────────────
 *
 * The chainable builder below is API-compatible with the slice of PostgREST that
 * `lib/repos/` uses, so no repository file changed.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;

export const isSupabaseConfigured = Boolean(SUPABASE_URL);

let tokenGetter: (() => Promise<string | null>) | null = null;

/** Called by <SupabaseTokenBridge /> on every render. Idempotent. */
export function setSupabaseTokenGetter(fn: () => Promise<string | null>): void {
  tokenGetter = fn;
}

export type PgErrorLike = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

export interface BuilderResponse<T> {
  data: T[] | null;
  error: PgErrorLike | null;
  count: number | null;
}

/**
 * The shape `single()` / `maybeSingle()` resolve to.
 *
 * PostgREST unwraps to a bare row for these, and the repos depend on it — they
 * call `camel(data)`, not `camelMany(data)`. Matching that exactly is what lets
 * every repository compile unchanged.
 */
export interface SingleResponse<T> {
  data: T | null;
  error: PgErrorLike | null;
  count: number | null;
}

/**
 * Everything a query can be given, with no `then` in sight.
 *
 * Splitting this out from the builder is what makes `.single()` type correctly. If
 * `single()` returned `this & PromiseLike<SingleResponse<T>>`, the class's own
 * `then` would shadow the interface's and the result would still be an array —
 * exactly the bug the repos' `camel(data)` calls expose. With no `then` here, the
 * only one in the returned type is the one that unwraps.
 */
export interface Chainable<T> {
  select(columns?: string, options?: Record<string, unknown>): Chainable<T>;
  insert(rows: unknown, options?: { onConflict?: string }): Chainable<T>;
  upsert(rows: unknown, options?: { onConflict?: string }): Chainable<T>;
  update(rows: unknown): Chainable<T>;
  delete(): Chainable<T>;

  eq(column: string, value: unknown): Chainable<T>;
  neq(column: string, value: unknown): Chainable<T>;
  gt(column: string, value: unknown): Chainable<T>;
  gte(column: string, value: unknown): Chainable<T>;
  lt(column: string, value: unknown): Chainable<T>;
  lte(column: string, value: unknown): Chainable<T>;
  like(column: string, pattern: string): Chainable<T>;
  ilike(column: string, pattern: string): Chainable<T>;
  is(column: string, value: unknown): Chainable<T>;
  in(column: string, values: readonly unknown[]): Chainable<T>;
  or(fragment: string): Chainable<T>;

  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): Chainable<T>;
  limit(count: number): Chainable<T>;
  range(from: number, to: number): Chainable<T>;

  single(): Chainable<T> & PromiseLike<SingleResponse<T>>;
  maybeSingle(): Chainable<T> & PromiseLike<SingleResponse<T>>;
}

type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is' | 'in';

interface FilterSpec {
  column: string;
  op: FilterOp;
  value?: unknown;
  values?: unknown[];
}

interface OrderSpec {
  column: string;
  ascending?: boolean;
  nullsFirst?: boolean;
}

type Op = 'select' | 'insert' | 'update' | 'upsert' | 'delete';

class ProxyError extends Error {
  constructor(readonly payload: PgErrorLike) {
    super(payload.message ?? 'Request failed');
  }
}

async function call(payload: Record<string, unknown>): Promise<{ data: unknown[]; count: number | null }> {
  if (!SUPABASE_URL) {
    throw new Error(
      'Supabase is not configured. Copy frontend/.env.example to .env.local and set VITE_SUPABASE_URL.',
    );
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = tokenGetter ? await tokenGetter().catch(() => null) : null;
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${SUPABASE_URL}/functions/v1/data-proxy`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    data?: unknown[];
    count?: number | null;
    error?: PgErrorLike;
  } | null;

  if (!response.ok || !body?.success) {
    throw new ProxyError(body?.error ?? { code: String(response.status), message: response.statusText });
  }

  return { data: body.data ?? [], count: body.count ?? null };
}

/**
 * Chainable query builder.
 *
 * Every method returns `this`, so a chain stays assignable while it is passed
 * around — `paginate()` relies on that — and execution happens in `then()`, when
 * the builder is awaited.
 */
class QueryBuilder<T = Record<string, unknown>>
  implements Chainable<T>, PromiseLike<BuilderResponse<T>>
{
  private readonly spec: {
    op: Op;
    table: string;
    columns?: string;
    filters: FilterSpec[];
    order: OrderSpec[];
    limit?: number;
    range?: [number, number];
    count?: string;
    head?: boolean;
    rows?: unknown;
    onConflict?: string;
    or?: string;
  };

  private expect: 'many' | 'one' | 'maybeOne' = 'many';
  private executed: Promise<BuilderResponse<T>> | null = null;

  constructor(table: string, op: Op) {
    this.spec = { op, table, filters: [], order: [] };
  }

  select(columns = '*', options: Record<string, unknown> = {}): this {
    this.spec.columns = columns;
    if (options.count === 'exact') this.spec.count = 'exact';
    if (options.head === true) {
      // `columns` is left as requested. PostgREST uses the literal string `'1'` here,
      // but that syntax is specific to PostgREST: `data-proxy` validates the column
      // against the table's real columns and rejected `"1"` outright. It substitutes
      // its own projection when `head` is set, so there is nothing to send.
      this.spec.head = true;
    }
    return this;
  }

  insert(rows: unknown, options: { onConflict?: string } = {}): this {
    this.spec.op = 'insert';
    this.spec.rows = rows;
    if (options.onConflict) this.spec.onConflict = options.onConflict;
    return this;
  }

  upsert(rows: unknown, options: { onConflict?: string } = {}): this {
    this.spec.op = 'upsert';
    this.spec.rows = rows;
    this.spec.onConflict = options.onConflict ?? 'id';
    return this;
  }

  update(rows: unknown): this {
    this.spec.op = 'update';
    this.spec.rows = rows;
    return this;
  }

  delete(): this {
    this.spec.op = 'delete';
    return this;
  }

  eq(column: string, value: unknown): this {
    return this.filter(column, 'eq', value);
  }
  neq(column: string, value: unknown): this {
    return this.filter(column, 'neq', value);
  }
  gt(column: string, value: unknown): this {
    return this.filter(column, 'gt', value);
  }
  gte(column: string, value: unknown): this {
    return this.filter(column, 'gte', value);
  }
  lt(column: string, value: unknown): this {
    return this.filter(column, 'lt', value);
  }
  lte(column: string, value: unknown): this {
    return this.filter(column, 'lte', value);
  }
  like(column: string, pattern: string): this {
    return this.filter(column, 'like', pattern);
  }
  ilike(column: string, pattern: string): this {
    return this.filter(column, 'ilike', pattern);
  }

  /** `is(null)` and `is(false)` both mean `is null`; the latter matches supabase-js. */
  is(column: string, value: unknown): this {
    return this.filter(column, 'is', value);
  }

  in(column: string, values: readonly unknown[]): this {
    this.spec.filters.push({ column, op: 'in', values: [...values] });
    return this;
  }

  /** PostgREST `or=` syntax, e.g. `a.ilike.%x%,b.eq.1`. Validated server-side. */
  or(fragment: string): this {
    this.spec.or = fragment;
    return this;
  }

  order(column: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}): this {
    this.spec.order.push({
      column,
      ascending: options.ascending !== false,
      nullsFirst: options.nullsFirst === true,
    });
    return this;
  }

  limit(count: number): this {
    this.spec.limit = count;
    return this;
  }

  range(from: number, to: number): this {
    this.spec.range = [from, to];
    return this;
  }

  single(): Chainable<T> & PromiseLike<SingleResponse<T>> {
    this.expect = 'one';
    return this.unwrap((rows) => (rows[0] ?? null) as T | null);
  }

  maybeSingle(): Chainable<T> & PromiseLike<SingleResponse<T>> {
    this.expect = 'maybeOne';
    return this.unwrap((rows) => (rows[0] ?? null) as T | null);
  }

  /**
   * A view of this builder that resolves to a single row instead of an array.
   *
   * Delegates to the same instance through the prototype chain, so the query state
   * is shared and fetched once. Only `then` differs, which is the whole point:
   * `await q.select().eq(...).single()` must yield the bare row `camel()` expects.
   */
  private unwrap(pick: (rows: unknown[]) => T | null): Chainable<T> & PromiseLike<SingleResponse<T>> {
    const source = this;
    const view = Object.create(source) as Record<string, unknown>;

    view.then = (onfulfilled?: unknown, onrejected?: unknown) =>
      source
        .run()
        .then((result) => ({
          data: pick((result.data ?? []) as unknown[]),
          error: result.error,
          count: result.count,
        }))
        .then(onfulfilled as never, onrejected as never);

    return view as unknown as Chainable<T> & PromiseLike<SingleResponse<T>>;
  }

  private filter(column: string, op: FilterOp, value: unknown): this {
    this.spec.filters.push({ column, op, value });
    return this;
  }

  private run(): Promise<BuilderResponse<T>> {
    // Memoised so awaiting a builder twice does not send two requests.
    this.executed ??= this.execute();
    return this.executed;
  }

  private async execute(): Promise<BuilderResponse<T>> {
    try {
      const { data, count } = await call({ ...this.spec });

      if (this.spec.head) return { data: [], count, error: null };

      if (this.expect === 'one' && data.length !== 1) {
        return {
          data: null,
          count,
          error: {
            code: 'PGRST116',
            message:
              data.length === 0
                ? 'No rows were returned, but exactly one was expected.'
                : `${data.length} rows were returned, but exactly one was expected.`,
          },
        };
      }

      if (this.expect === 'maybeOne' && data.length > 1) {
        return {
          data: null,
          count,
          error: {
            code: 'PGRST117',
            message: `${data.length} rows were returned, but at most one was expected.`,
          },
        };
      }

      return { data: data as T[], count, error: null };
    } catch (caught) {
      if (caught instanceof ProxyError) return { data: null, count: null, error: caught.payload };
      return {
        data: null,
        count: null,
        error: { message: caught instanceof Error ? caught.message : 'Request failed' },
      };
    }
  }

  then<R1 = BuilderResponse<T>, R2 = never>(
    onfulfilled?: ((value: BuilderResponse<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }
}

export interface DatabaseClient {
  /**
   * Returns a builder whose element type is `any`.
   *
   * Deliberate, and the reason is `paginate<T>()` in `lib/query.ts`, which is
   * generic in the row type and needs a builder it can accept for any `T`. A real
   * supabase-js client satisfies this structurally because its generics are erased
   * the same way. `any` is confined to this boundary: each repo declares its own
   * row shape and `camel()` maps it, so nothing downstream depends on it.
   */
  from(table: string): QueryBuilder<any> & PromiseLike<BuilderResponse<any>>;
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<BuilderResponse<any>>;
}

const client: DatabaseClient = {
  from: (table: string) => new QueryBuilder<any>(table, 'select'),

  rpc(fn: string, args: Record<string, unknown> = {}) {
    return (async () => {
      try {
        const { data } = await call({ op: 'rpc', fn, args });

        /**
         * A function returning a scalar (jsonb, uuid, text) comes back from
         * `select * from fn()` as a single column named after the function, so it is
         * unwrapped here to match what PostgREST returned. A function returning a
         * composite or a set of rows expands to real columns and is left alone.
         */
        if (data.length === 1) {
          const row = data[0] as Record<string, unknown>;
          const keys = Object.keys(row);
          if (keys.length === 1 && keys[0] === fn) {
            return { data: [row[fn]], count: null, error: null };
          }
        }

        return { data, count: null, error: null };
      } catch (caught) {
        if (caught instanceof ProxyError) return { data: null, count: null, error: caught.payload };
        return {
          data: null,
          count: null,
          error: { message: caught instanceof Error ? caught.message : 'Request failed' },
        };
      }
    })();
  },
};

export function getSupabase(): DatabaseClient {
  return client;
}
