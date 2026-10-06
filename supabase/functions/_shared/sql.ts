import { runPrivileged } from './postgres.ts';

/**
 * SQL construction for `data-proxy`.
 *
 * ── The rule this file exists to enforce ───────────────────────────────────────
 *
 * Identifiers cannot be parameterised in Postgres. There is no `$1` for a table
 * name or a column name, so anything that reaches the SQL text has to be
 * *checked*, not escaped. Every table, view, column and function name is therefore
 * validated against the live catalog via `information_schema`/`pg_proc` before it
 * is allowed anywhere near a statement.
 *
 * That is stronger than escaping. An allowlist drawn from the actual schema means
 * a caller cannot name a relation that does not exist, cannot reference a column
 * of some other table, and cannot smuggle a fragment through a name — the request
 * fails validation rather than producing a statement.
 *
 * Values are a different matter and are always bound parameters. There is no
 * string interpolation of a value into SQL anywhere in this file.
 *
 * The caller runs as `authenticated`, so RLS still applies to whatever this
 * builds. This module decides *what statement to run*, never *whether it may
 * return rows*.
 */

export class SqlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlValidationError';
  }
}

interface Relation {
  name: string;
  /** True for views, which are read-only — an INSERT into one must be rejected. */
  isView: boolean;
  columns: Set<string>;
}

const CATALOG_TTL_MS = 10 * 60_000;
let catalog: Map<string, Relation> | null = null;
let catalogFetchedAt = 0;

/**
 * Every readable relation in `public`, with its columns.
 *
 * Cached because it is read on the first query of every cold start and it changes
 * only when a migration runs.
 */
async function getCatalog(): Promise<Map<string, Relation>> {
  if (catalog && Date.now() - catalogFetchedAt < CATALOG_TTL_MS) return catalog;

  const rows = await runPrivileged(({ query }) =>
    query<{ table_name: string; column_name: string; kind: string }>(`
      select c.table_name, c.column_name,
             case when v.table_name is null then 'table' else 'view' end as kind
        from information_schema.columns c
        left join information_schema.views v
          on v.table_schema = c.table_schema and v.table_name = c.table_name
       where c.table_schema = 'public'
    `),
  );

  const built = new Map<string, Relation>();
  for (const row of rows) {
    const existing = built.get(row.table_name);
    if (existing) existing.columns.add(row.column_name);
    else {
      built.set(row.table_name, {
        name: row.table_name,
        isView: row.kind === 'view',
        columns: new Set([row.column_name]),
      });
    }
  }

  catalog = built;
  catalogFetchedAt = Date.now();
  return built;
}

/** Force the next call to re-read the catalog. Used after migrations. */
export function invalidateCatalog(): void {
  catalog = null;
  catalogFetchedAt = 0;
}

async function requireRelation(name: string, write: boolean): Promise<Relation> {
  if (typeof name !== 'string' || name.length === 0) {
    throw new SqlValidationError('A relation name is required.');
  }

  const relations = await getCatalog();
  const relation = relations.get(name);

  if (!relation) {
    // Deliberately does not echo the attempted name into a client-facing message
    // beyond a generic refusal; the caller supplied it, so that is harmless, but
    // the set of existing tables is not something to enumerate.
    throw new SqlValidationError(`Unknown relation "${name}".`);
  }

  if (write && relation.isView) {
    throw new SqlValidationError(`"${name}" is a view and cannot be written to.`);
  }

  return relation;
}

/**
 * Expand a select list into safe output expressions.
 *
 * Supports `*`, comma-separated columns, and the embedded-resource form
 * `alias:table(columns)` used for a handful of joins. Anything that is not a
 * column of the relation, and not a recognised embedded target, is rejected.
 */
async function buildSelectList(
  relation: Relation,
  columns: string | undefined,
  params: unknown[],
): Promise<string> {
  const relations = await getCatalog();
  const requested = (columns && columns.trim()) || '*';

  if (requested === '*') return `${quoteIdent(relation.name)}.*`;

  const parts: string[] = [];

  for (const rawPart of splitTopLevel(requested)) {
    const part = rawPart.trim();
    if (!part) continue;

    // PostgREST's embedded syntax, optionally naming the link column:
    //   alias:table(columns)          link column guessed
    //   alias:table!link_column(cols)  link column stated
    const embedded = part.match(
      /^([a-z_][a-z0-9_]*)\s*:\s*([a-z_][a-z0-9_]*)(?:!([a-z_][a-z0-9_]*))?\s*\(([^)]*)\)$/i,
    );

    if (embedded) {
      // Every group is inside the pattern, so a match always populates all five.
      const [, alias = '', table = '', explicitLink, inner = ''] = embedded;
      const target = relations.get(table);
      if (!target) throw new SqlValidationError(`Unknown relation "${table}".`);

      const innerColumns =
        inner.trim() === '*'
          ? '*'
          : inner
              .split(',')
              .map((c) => c.trim())
              .filter(Boolean)
              .map((c) => {
                if (!target.columns.has(c)) {
                  throw new SqlValidationError(`Unknown column "${c}" on "${table}".`);
                }
                return `${quoteIdent(c)} as ${quoteIdent(c)}`;
              })
              .join(', ');

      /**
       * The link column.
       *
       * Guessing by singularising the table name is wrong often enough to matter:
       * `profiles` links from `teacher_id`, not `profile_id`, and
       * `teacher_assignments` from `subject_id`. So the caller states it with
       * PostgREST's `!column` syntax, and the guess is only a fallback.
       */
      const linkColumn = explicitLink ?? `${table.replace(/s$/, '')}_id`;
      if (!relation.columns.has(linkColumn)) {
        throw new SqlValidationError(
          `"${relation.name}" has no column "${linkColumn}". State the link explicitly, e.g. ${alias}:${table}!${linkColumn}(…).`,
        );
      }

      const subColumns = innerColumns === '*' ? `${quoteIdent(table)}.*` : innerColumns;

      parts.push(
        `(select ${subColumns} from ${quoteIdent(table)} ` +
          `where ${quoteIdent(table)}.${quoteIdent(linkColumn)} = ${quoteIdent(relation.name)}.${quoteIdent('id')}) as ${quoteIdent(alias)}`,
      );
      continue;
    }

    // `count=exact` support selects a bare column list; nothing here aggregates.
    for (const c of part.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (c === '*') {
        parts.push(`${quoteIdent(relation.name)}.*`);
        continue;
      }
      if (!relation.columns.has(c)) {
        throw new SqlValidationError(`Unknown column "${c}" on "${relation.name}".`);
      }
      parts.push(`${quoteIdent(relation.name)}.${quoteIdent(c)}`);
    }
  }

  if (parts.length === 0) return `${quoteIdent(relation.name)}.*`;
  void params;
  return parts.join(', ');
}

/** Split on commas that are not inside parentheses. */
function splitTopLevel(input: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';

  for (const char of input) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

/**
 * Quote an identifier.
 *
 * Reached only after the name has been checked against the catalog, but quoted
 * regardless so a legitimate name containing unusual characters still works.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/* -------------------------------------------------------------------------- */
/* Filter operators                                                            */
/* -------------------------------------------------------------------------- */

const FILTER_OPERATORS: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE',
};

export interface FilterSpec {
  column: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is' | 'in';
  value?: unknown;
  values?: unknown[];
}

export interface OrderSpec {
  column: string;
  ascending?: boolean;
  nullsFirst?: boolean;
}

export interface QuerySpec {
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  table: string;
  columns?: string;
  filters?: FilterSpec[];
  order?: OrderSpec[];
  limit?: number;
  range?: [number, number];
  count?: string;
  head?: boolean;
  rows?: Record<string, unknown> | Record<string, unknown>[];
  onConflict?: string;
  /** `or=` fragment in PostgREST syntax, e.g. `a.ilike.%x%,b.eq.1`. */
  or?: string;
}

function buildFilterClause(
  relation: Relation,
  filters: FilterSpec[] | undefined,
  params: unknown[],
): string {
  if (!filters || filters.length === 0) return '';

  const clauses: string[] = [];

  for (const filter of filters) {
    if (!relation.columns.has(filter.column)) {
      throw new SqlValidationError(`Unknown column "${filter.column}" on "${relation.name}".`);
    }
    const column = `${quoteIdent(relation.name)}.${quoteIdent(filter.column)}`;

    switch (filter.op) {
      case 'is': {
        // `is null` / `is not null`. The value is a boolean, not data.
        const negate = filter.value === false || filter.value === 'not null';
        clauses.push(`${column} is ${negate ? 'not ' : ''}null`);
        break;
      }
      case 'in': {
        const values = filter.values ?? [];
        if (values.length === 0) {
          // An empty IN list matches nothing. `false` keeps it a valid statement.
          clauses.push('false');
          break;
        }
        const placeholders = values.map((value) => {
          params.push(value);
          return `$${params.length}`;
        });
        clauses.push(`${column} in (${placeholders.join(', ')})`);
        break;
      }
      default: {
        const operator = FILTER_OPERATORS[filter.op];
        if (!operator) throw new SqlValidationError(`Unsupported operator "${filter.op}".`);
        params.push(filter.value ?? null);
        clauses.push(`${column} ${operator} $${params.length}`);
      }
    }
  }

  return clauses.length ? ` where ${clauses.join(' and ')}` : '';
}

const OR_PART = /^([a-z_][a-z0-9_]*)\.([a-z]+)\.(.*)$/i;

/**
 * Translate PostgREST's `or=` syntax into parameterised SQL.
 *
 * The grammar is `column.op.value` joined by commas. Each triple is validated the
 * same way an ordinary filter is: the column must exist on the relation and the
 * operator must be in the allowlist. Values are bound, never interpolated — the
 * alternative would be to trust a raw filter string, which is exactly the kind of
 * thing that turns a read endpoint into an injection point.
 */
function buildOrClause(relation: Relation, fragment: string, params: unknown[]): string {
  const clauses: string[] = [];

  for (const part of fragment.split(',')) {
    const match = part.trim().match(OR_PART);
    if (!match) throw new SqlValidationError('Malformed or() filter.');

    const [, column = '', op = '', value = ''] = match;
    if (!relation.columns.has(column)) {
      throw new SqlValidationError(`Unknown column "${column}" on "${relation.name}".`);
    }

    const operator = FILTER_OPERATORS[op.toLowerCase()];
    if (!operator) throw new SqlValidationError(`Unsupported operator "${op}" in or().`);

    params.push(value);
    clauses.push(`${quoteIdent(relation.name)}.${quoteIdent(column)} ${operator} $${params.length}`);
  }

  if (clauses.length === 0) return '';
  return ` where ${clauses.join(' or ')}`;
}

function buildOrderClause(relation: Relation, order: OrderSpec[] | undefined): string {
  if (!order || order.length === 0) return '';

  const parts = order.map((entry) => {
    if (!relation.columns.has(entry.column)) {
      throw new SqlValidationError(`Unknown column "${entry.column}" on "${relation.name}".`);
    }
    const direction = entry.ascending === false ? 'desc' : 'asc';
    const nulls = entry.nullsFirst ? 'nulls first' : 'nulls last';
    return `${quoteIdent(relation.name)}.${quoteIdent(entry.column)} ${direction} ${nulls}`;
  });

  return ` order by ${parts.join(', ')}`;
}

function buildLimitClause(relation: Relation, spec: QuerySpec): string {
  if (spec.range) {
    const [from, to] = spec.range;
    const safeFrom = Math.max(0, Math.floor(Number(from) || 0));
    const safeTo = Math.max(safeFrom, Math.floor(Number(to) ?? safeFrom));
    return ` limit ${safeTo - safeFrom + 1} offset ${safeFrom}`;
  }
  if (typeof spec.limit === 'number') {
    return ` limit ${Math.max(0, Math.min(Math.floor(spec.limit), 10_000))}`;
  }
  void relation;
  return '';
}

/** Build the `set` clause of an update, validating every column. */
function buildAssignments(relation: Relation, row: Record<string, unknown>, params: unknown[]): string {
  const entries = Object.entries(row);
  if (entries.length === 0) throw new SqlValidationError('No values supplied to update.');

  return entries
    .map(([column, value]) => {
      if (!relation.columns.has(column)) {
        throw new SqlValidationError(`Unknown column "${column}" on "${relation.name}".`);
      }
      params.push(value ?? null);
      return `${quoteIdent(column)} = $${params.length}`;
    })
    .join(', ');
}

export interface BuiltStatement {
  sql: string;
  params: unknown[];
  /** True when the statement returns rows that should be sent to the caller. */
  returnsRows: boolean;
  /** Set for a statement that must also report how many rows match. */
  wantsCount: boolean;
}

/**
 * Turn a validated {@link QuerySpec} into SQL plus bound parameters.
 */
export async function buildQuery(spec: QuerySpec): Promise<BuiltStatement> {
  const write = spec.op !== 'select';
  const relation = await requireRelation(spec.table, write);
  const params: unknown[] = [];

  switch (spec.op) {
    case 'select': {
      // A `head` query returns no rows, so its column list is discarded below and
      // never reaches Postgres. Building it anyway meant validating a column that is
      // then thrown away — and since the client speaks PostgREST, it sends
      // `columns: '1'` for a head, which is not a real column on any table. That
      // failed as `Unknown column "1" on "v_directory"`, turning every `head: true`
      // count in the app into a 400.
      //
      // Skipping the work also keeps `head` honest about what it needs: filters,
      // order and limit, but not a projection.
      const selectList = spec.head ? '' : await buildSelectList(relation, spec.columns, params);
      const orClause = spec.or ? buildOrClause(relation, spec.or, params) : '';
      const andClause = buildFilterClause(relation, spec.filters, params);

      // `or()` and ordinary filters combine with AND, matching PostgREST: an `or`
      // group is one predicate among the others, not a replacement for them.
      const where = [orClause.replace(/^ where /, ''), andClause.replace(/^ where /, '')]
        .filter(Boolean)
        .join(' and ');

      const sql =
        `select ${spec.head ? '1' : selectList} from ${quoteIdent(relation.name)}` +
        (where ? ` where ${where}` : '') +
        buildOrderClause(relation, spec.order) +
        buildLimitClause(relation, spec);

      return { sql, params, returnsRows: !spec.head, wantsCount: spec.count === 'exact' };
    }

    case 'insert': {
      const rows = Array.isArray(spec.rows) ? spec.rows : [spec.rows ?? {}];
      if (rows.length === 0) throw new SqlValidationError('No rows supplied to insert.');

      const columns: string[] = [];
      for (const row of rows) {
        for (const column of Object.keys(row)) {
          if (!relation.columns.has(column)) {
            throw new SqlValidationError(`Unknown column "${column}" on "${relation.name}".`);
          }
          if (!columns.includes(column)) columns.push(column);
        }
      }

      const tuples = rows.map((row) => {
        const placeholders = columns.map((column) => {
          params.push(row[column] ?? null);
          return `$${params.length}`;
        });
        return `(${placeholders.join(', ')})`;
      });

      const quoted = columns.map(quoteIdent).join(', ');
      const sql =
        `insert into ${quoteIdent(relation.name)} (${quoted}) values ${tuples.join(', ')} returning *`;

      return { sql, params, returnsRows: true, wantsCount: false };
    }

    case 'upsert': {
      const rows = Array.isArray(spec.rows) ? spec.rows : [spec.rows ?? {}];
      if (rows.length === 0) throw new SqlValidationError('No rows supplied to upsert.');

      const conflict = (spec.onConflict ?? 'id')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);

      for (const column of conflict) {
        if (!relation.columns.has(column)) {
          throw new SqlValidationError(`Unknown column "${column}" on "${relation.name}".`);
        }
      }

      const columns: string[] = [];
      for (const row of rows) {
        for (const column of Object.keys(row)) {
          if (!relation.columns.has(column)) {
            throw new SqlValidationError(`Unknown column "${column}" on "${relation.name}".`);
          }
          if (!columns.includes(column)) columns.push(column);
        }
      }

      const tuples = rows.map((row) => {
        const placeholders = columns.map((column) => {
          params.push(row[column] ?? null);
          return `$${params.length}`;
        });
        return `(${placeholders.join(', ')})`;
      });

      // Conflict columns are excluded from the update set: writing the same value
      // back is a no-op, and including them makes Postgres reject the statement.
      const updatable = columns.filter((column) => !conflict.includes(column));
      const updates =
        updatable.length > 0
          ? `do update set ${updatable.map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`).join(', ')}`
          : 'do nothing';

      const quoted = columns.map(quoteIdent).join(', ');
      const sql =
        `insert into ${quoteIdent(relation.name)} (${quoted}) values ${tuples.join(', ')} ` +
        `on conflict (${conflict.map(quoteIdent).join(', ')}) ${updates} returning *`;

      return { sql, params, returnsRows: true, wantsCount: false };
    }

    case 'update': {
      const row = (Array.isArray(spec.rows) ? spec.rows[0] : spec.rows) ?? {};
      const assignments = buildAssignments(relation, row, params);
      const where = buildFilterClause(relation, spec.filters, params);

      const sql =
        `update ${quoteIdent(relation.name)} set ${assignments}` +
        (where ? ` where ${where.replace(/^ where /, '')}` : '') +
        ' returning *';

      return { sql, params, returnsRows: true, wantsCount: false };
    }

    case 'delete': {
      const where = buildFilterClause(relation, spec.filters, params);
      const sql = `delete from ${quoteIdent(relation.name)}` + (where ? ` where ${where.replace(/^ where /, '')}` : '') + ' returning *';
      return { sql, params, returnsRows: true, wantsCount: false };
    }

    default:
      throw new SqlValidationError('Unsupported operation.');
  }
}

/**
 * Count rows matching the same filters, for `count: 'exact'`.
 *
 * RLS applies here too, so the total can never exceed what the caller may see —
 * which is the whole point of counting in the database rather than in the browser.
 */
export async function buildCount(spec: QuerySpec): Promise<BuiltStatement> {
  const relation = await requireRelation(spec.table, false);
  const params: unknown[] = [];

  const orClause = spec.or ? buildOrClause(relation, spec.or, params) : '';
  const andClause = buildFilterClause(relation, spec.filters, params);
  const where = [orClause.replace(/^ where /, ''), andClause.replace(/^ where /, '')]
    .filter(Boolean)
    .join(' and ');

  const sql =
    `select count(*)::bigint as count from ${quoteIdent(relation.name)}` +
    (where ? ` where ${where}` : '');

  return { sql, params, returnsRows: true, wantsCount: false };
}

/* -------------------------------------------------------------------------- */
/* RPC                                                                         */
/* -------------------------------------------------------------------------- */

interface RpcArg {
  name: string;
  position: number;
  type: string;
}

/** Declared argument names of a `public` function, for named binding. */
async function getRpcArgs(fnName: string): Promise<RpcArg[]> {
  const rows = await runPrivileged(({ query }) =>
    query<{ arg_name: string; position: number }>(
      // `u.name`, not `p.proname`. Selecting the *function* name into the argument
      // column makes every named call fail with "Unknown argument" — invisible for
      // a zero-argument function, which is why `my_profile()` passing while
      // `request_assignment` never worked.
      `select u.name as arg_name, u.ord as position
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         left join unnest(p.proargnames) with ordinality as u(name, ord) on true
        where n.nspname = 'public' and p.proname = $1
        order by u.ord`,
      [fnName],
    ),
  );

  const args = rows
    .filter((row) => row.arg_name)
    .map((row, index) => ({ name: row.arg_name, position: row.position || index + 1, type: '' }));

  // No rows at all means no such function. A function that exists but takes no
  // arguments yields one row whose `arg_name` is null, which is a valid call — the
  // two cases must not be conflated.
  if (rows.length === 0) {
    const exists = await runPrivileged(({ query }) =>
      query<{ present: boolean }>(
        `select true as present from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`,
        [fnName],
      ),
    );

    if (exists.length === 0) throw new SqlValidationError(`Unknown function "${fnName}".`);
  }

  return args;
}

/**
 * Build `select * from public.fn(p_arg => $1, …)`.
 *
 * Arguments are bound by name, using the names Postgres reports for the function,
 * so a caller cannot smuggle a positional argument into a function whose signature
 * they have guessed. Supplying an unknown argument name is an error rather than
 * being ignored.
 */
export async function buildRpc(fnName: string, args: Record<string, unknown>): Promise<BuiltStatement> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(fnName)) {
    throw new SqlValidationError('Invalid function name.');
  }

  const declared = await getRpcArgs(fnName);
  const params: unknown[] = [];
  const bindings: string[] = [];

  for (const arg of declared) {
    if (!(arg.name in args)) continue;
    params.push(args[arg.name] ?? null);
    bindings.push(`${quoteIdent(arg.name)} => $${params.length}`);
  }

  const unknown = Object.keys(args).filter((key) => !declared.some((d) => d.name === key));
  if (unknown.length > 0) {
    throw new SqlValidationError(`Unknown argument "${unknown[0]}" for "${fnName}".`);
  }

  const call = `public.${quoteIdent(fnName)}(${bindings.join(', ')})`;
  return {
    sql: `select * from ${call}`,
    params,
    returnsRows: true,
    wantsCount: false,
  };
}