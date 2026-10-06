import { requireCaller, requirePermission } from '../_shared/auth.ts';
import { handle, json } from '../_shared/http.ts';
import { runPrivileged } from '../_shared/postgres.ts';
import { buildSchemaGraph } from './schemaGraph.ts';

/**
 * `schema-graph` — the live database, drawn from the live catalog.
 *
 * Reads `pg_catalog` and `information_schema` and returns the tables, columns,
 * primary keys and foreign keys of the `public` schema. The visualiser renders
 * exactly what is deployed: a migration lands and the graph catches up with no
 * deploy of this function, because this is not a snapshot anywhere.
 *
 * Read-only by design. The schema is the security boundary (RLS, audit
 * triggers, trigger-derived grades), so this function returns nothing a caller
 * could write with and the page edits nothing. Schema changes belong in
 * `supabase/migrations/` and go through the deploy pipeline.
 *
 * Admin-only: `settings:manage` is the permission the Settings screen and this
 * page share, so "who can see how the school's data is shaped" stays in the
 * same matrix as "who can rename the school".
 *
 * The catalog is read with `runPrivileged`, not `runAsCaller`: it is a
 * read-only listing of *what the database is*, not of any user's rows, and no
 * object in it is protected by RLS. Requesting it as a specific caller would be
 * pretending a shape is a row.
 */

interface SchemaResponse {
  tables: Array<{
    name: string;
    kind: string;
    columns: Array<{ name: string; type: string; nullable: boolean; primary: boolean }>;
  }>;
  foreignKeys: Array<{
    id: string;
    from: string;
    fromColumn: string;
    to: string;
    toColumn: string;
  }>;
}

Deno.serve((request) =>
  handle(request, async () => {
    const caller = await requireCaller(request);
    await requirePermission(caller, 'settings:manage');

    const graph = await runPrivileged(async (sql) => {
      // One connection, so the four statements run sequentially — the Postgres
      // protocol does not interleave queries on a single connection.
      const tables = await sql.query<Record<string, unknown>>(
        `select c.relname as name,
                c.relkind as kind
           from pg_catalog.pg_class c
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1
            and c.relkind in ('r', 'v', 'm')
            and not c.relispartition
          order by c.relname`,
        ['public'],
      );

      const columns = await sql.query<Record<string, unknown>>(
        `select c.table_name,
                c.column_name,
                c.data_type,
                c.udt_name,
                c.is_nullable
           from information_schema.columns c
          where c.table_schema = $1
          order by c.table_name, c.ordinal_position`,
        ['public'],
      );

      const primaryKeys = await sql.query<Record<string, unknown>>(
        `select cnf.relname as table_name,
                att.attname as column_name
           from pg_catalog.pg_constraint c
           join pg_catalog.pg_class cnf on cnf.oid = c.conrelid
           join pg_catalog.pg_namespace n on n.oid = cnf.relnamespace
           join lateral unnest(c.conkey) as k(attnum) on true
           join pg_catalog.pg_attribute att
             on att.attrelid = c.conrelid and att.attnum = k.attnum
          where c.contype = 'p'
            and n.nspname = $1`,
        ['public'],
      );

      const foreignKeys = await sql.query<Record<string, unknown>>(
        `select c.conname as name,
                cnf.relname as from_table,
                att.attname as from_column,
                cft.relname as to_table,
                fat.attname as to_column
           from pg_catalog.pg_constraint c
           join pg_catalog.pg_class cnf on cnf.oid = c.conrelid
           join pg_catalog.pg_namespace fn on fn.oid = cnf.relnamespace
           join pg_catalog.pg_class cft on cft.oid = c.confrelid
           join lateral unnest(c.conkey) with ordinality as k(attnum, ord) on true
           join pg_catalog.pg_attribute att
             on att.attrelid = c.conrelid and att.attnum = k.attnum
           join lateral unnest(c.confkey) with ordinality as fk(attnum, ord) on fk.ord = k.ord
           join pg_catalog.pg_attribute fat
             on fat.attrelid = c.confrelid and fat.attnum = fk.attnum
          where c.contype = 'f'
            and fn.nspname = $1`,
        ['public'],
      );

      return buildSchemaGraph({ tables, columns, primaryKeys, foreignKeys });
    });

    return json(graph satisfies SchemaResponse);
  }),
);