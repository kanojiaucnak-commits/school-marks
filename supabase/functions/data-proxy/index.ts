import { requireCaller } from '../_shared/auth.ts';
import { corsHeaders, handle, readJson } from '../_shared/http.ts';
import { looksLikeSqlstate, readError } from '../_shared/pgError.ts';
import { runAsCaller } from '../_shared/postgres.ts';
import {
  buildCount,
  buildQuery,
  buildRpc,
  SqlValidationError,
  type QuerySpec,
} from '../_shared/sql.ts';

/**
 * `data-proxy` — the browser's only path to Postgres.
 *
 * PostgREST cannot be used on this project: it verifies bearer tokens against
 * `PGRST_JWT_SECRET`, which Supabase sets through container config, and Clerk's
 * RS256 tokens do not match the only key it knows (Supabase's own ES256). See
 * `_shared/postgres.ts` for the full account of what was ruled out.
 *
 * So this function verifies the Clerk token itself and then runs the statement
 * against Postgres **as `authenticated`**, injecting `request.jwt.claims` exactly
 * as PostgREST would. Every RLS policy therefore evaluates unchanged. This function
 * decides which statement to run; it never decides what the caller may see.
 *
 * SQL is built in `_shared/sql.ts`, where relation, column and function names are
 * checked against the live catalog and every value is a bound parameter.
 *
 * It is deliberately not a general SQL console: there is no way to pass a
 * fragment of SQL in, only structured operations.
 */

interface ProxyRequest {
  op: QuerySpec['op'] | 'rpc';
  table?: string;
  columns?: string;
  filters?: QuerySpec['filters'];
  order?: QuerySpec['order'];
  limit?: number;
  range?: [number, number];
  count?: string;
  head?: boolean;
  rows?: QuerySpec['rows'];
  onConflict?: string;
  or?: string;
  fn?: string;
  args?: Record<string, unknown>;
}

interface Envelope {
  data: unknown;
  count: number | null;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  return handle(request, async () => {
    const caller = await requireCaller(request);
    const body = (await readJson<ProxyRequest>(request)) ?? ({} as ProxyRequest);

    try {
      const result = await runAsCaller({ clerkUserId: caller.clerkUserId }, async (sql) => {
        if (body.op === 'rpc') {
          if (!body.fn) throw new SqlValidationError('An rpc call requires a function name.');

          const statement = await buildRpc(body.fn, body.args ?? {});
          const rows = await sql.query<Record<string, unknown>>(statement.sql, statement.params);
          return { data: rows, count: null } satisfies Envelope;
        }

        if (!body.table) throw new SqlValidationError('A table name is required.');

        const spec: QuerySpec = {
          op: body.op,
          table: body.table,
          columns: body.columns,
          filters: body.filters,
          order: body.order,
          limit: body.limit,
          range: body.range,
          count: body.count,
          head: body.head,
          rows: body.rows,
          onConflict: body.onConflict,
          or: body.or,
        };

        const statement = await buildQuery(spec);
        const rows = await sql.query<Record<string, unknown>>(statement.sql, statement.params);

        let count: number | null = null;
        if (statement.wantsCount) {
          const countStatement = await buildCount(spec);
          const counted = await sql.query<{ count: string }>(countStatement.sql, countStatement.params);
          count = counted[0] ? Number(counted[0].count) : 0;
        }

        return { data: rows, count } satisfies Envelope;
      });

      return new Response(JSON.stringify({ success: true, data: result.data, count: result.count }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() },
      });
    } catch (caught) {
      if (caught instanceof SqlValidationError) {
        // A rejected request is the caller's fault, not a server fault, and the
        // message names the offending identifier on purpose: the caller supplied it.
        return new Response(
          JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: caught.message } }),
          { status: 400, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() } },
        );
      }

      // Postgres errors must reach the client intact. `toQueryError()` in
      // `lib/query.ts` branches on the SQLSTATE and on Postgres's own wording —
      // "duplicate key value violates unique constraint", "null value in column"
      // — to produce specific messages. Flattening them to a generic 500 would
      // silently break every one of those messages.
      // Read through `readError`, not `caught.code`: `@db/postgres` nests the SQLSTATE
      // under `fields`, so `caught.code` is `undefined`. Reading it directly meant a
      // foreign-key violation came back as INTERNAL_ERROR with the raw constraint name
      // in the message, instead of 23503 and something a person can act on.
      const pg = readError(caught);
      const status = pg.code && looksLikeSqlstate(pg.code) ? 400 : 500;

      console.error('data-proxy statement failed', caught);

      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: pg.code ?? 'INTERNAL_ERROR',
            message: pg.message ?? 'The query could not be completed.',
            details: pg.detail,
            hint: pg.hint,
          },
        }),
        {
          status,
          headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() },
        },
      );
    }
  });
});