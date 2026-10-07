import { getSupabase } from './supabase';

/**
 * Supabase data-access helpers.
 *
 * Replaces the old REST client. Three responsibilities:
 *
 *  1. Turn PostgREST's machine errors into messages that are safe to render, so
 *     no page has to pattern-match error text.
 *  2. Wrap a query builder into the same `{items, page, pageSize, total,
 *     totalPages}` envelope `useListQuery` and `<Pagination>` already speak.
 *  3. Unwrap the `{ok, code, message}` payloads the Postgres RPCs in
 *     `0004_functions.sql` return, so a workflow refusal reads like an
 *     exception rather than a silently-ignored result.
 *
 * Nothing here bypasses RLS. These helpers run as the signed-in user, so a
 * teacher calling `listRows('marks')` still only sees rows their RLS policies
 * permit — which is the whole point of moving enforcement into the database.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                       */
/* -------------------------------------------------------------------------- */

export interface PgError {
  code?: string;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

export class QueryError extends Error {
  /** Domain code: a Postgres SQLSTATE, or a code returned by an RPC. */
  readonly code: string;
  readonly details: unknown;
  readonly hint: string | null;

  /**
   * The message the database actually produced, kept before it was replaced.
   *
   * `message` is the user-facing text and is safe to render, which means the original
   * is gone by the time anything wants to inspect it. {@link fieldIssues} needs it: the
   * column behind a `23502` and the columns behind a `23505` are named only in the raw
   * text, and the pooler in use drops `detail` for both codes. Without this the form
   * had nothing to attach an inline error to.
   */
  readonly rawMessage: string | null;

  constructor(
    code: string,
    message: string,
    details?: unknown,
    hint?: string | null,
    rawMessage?: string | null,
  ) {
    super(message);
    this.name = 'QueryError';
    this.code = code;
    this.details = details ?? null;
    this.hint = hint ?? null;
    this.rawMessage = rawMessage ?? null;
  }

  /** Always safe to render directly to a user. */
  get userMessage(): string {
    return this.message || 'Something went wrong. Please try again.';
  }

  /** Blocked by an RLS policy, or the role lacks the permission. */
  get isForbidden(): boolean {
    return this.code === '42501' || this.code === 'FORBIDDEN';
  }

  /** Unique-constraint violation, or an optimistic-concurrency conflict. */
  get isConflict(): boolean {
    return this.code === '23505' || this.code === 'CONFLICT';
  }

  /** Nobody matched — genuinely absent, not a permission problem. */
  get isNotFound(): boolean {
    return this.code === 'P0002' || this.code === 'PGRST116';
  }

  /** Foreign-key violation. */
  get isReferenceError(): boolean {
    return this.code === '23503';
  }

  /** Numeric out of range, e.g. a mark above the exam maximum. */
  get isRangeError(): boolean {
    return this.code === '22003';
  }

  /** A CHECK constraint refused the row. */
  get isCheckViolation(): boolean {
    return this.code === '23514';
  }

  /**
   * Field-level messages parsed out of a Postgres exception, for inline form errors.
   *
   * Both are read from `details` *and* `message`, because the pooler in use forwards
   * `detail` for a foreign-key violation but not for `23505` or `23502`. Parsing only
   * `details` left both of these dead on the live path — a duplicate name or a missing
   * field produced a banner instead of an error under the right input. The messages
   * arrive as
   *   `Key (student_id, exam_id)=(…) already exists.`
   *   `null value in column "full_name" of relation "students" …`
   */
  get fieldIssues(): Array<{ path: string; message: string }> {
    // `details` is `unknown` on the class because it is carried through verbatim from
    // whatever threw; only a string can be pattern-matched. `rawMessage` is the
    // database's own text — `message` is the friendly replacement, which by design
    // contains none of the identifiers that need matching against.
    const detail = typeof this.details === 'string' ? this.details : null;
    const text = `${detail ?? ''}\n${this.rawMessage ?? this.message}`;

    const unique = text.match(/Key \(([^)]+)\)/);
    if (unique?.[1]) {
      const field = unique[1].split(',')[0]!.trim();
      return [{ path: field, message: `That ${humanColumn(field).toLowerCase()} is already in use.` }];
    }

    const column = notNullColumn(this.rawMessage ?? this.message, detail);
    if (column) return [{ path: column, message: `${humanColumn(column)} is required.` }];

    return [];
  }
}

/**
 * How each table is named when it has to appear in an error message.
 *
 * Postgres reports a foreign-key violation in terms of the schema, not the vocabulary
 * of the school: `Key is still referenced from table "teacher_assignments"`. Naming the
 * table is what makes the message actionable, so it is worth saying it in words the
 * reader recognises. Anything unlisted falls back to the underscored name with
 * underscores turned into spaces, which is still readable.
 */
const TABLE_LABELS: Record<string, string> = {
  academic_years: 'an academic year',
  assignment_requests: 'a pending class request',
  audit_logs: 'the audit log',
  classes: 'a class',
  exams: 'an exam',
  export_jobs: 'an export',
  grading_rules: 'a grading rule',
  grading_schemes: 'a grading scheme',
  import_batches: 'an import',
  mark_submissions: 'a mark submission',
  marks: 'an entered mark',
  notifications: 'a notification',
  ocr_documents: 'an uploaded scan',
  ocr_results: 'a scan result',
  profiles: 'a user account',
  sections: 'a section',
  settings: 'the settings',
  students: 'a student',
  subjects: 'a subject',
  teacher_assignments: 'a teacher’s class assignment',
};

function humanTable(table: string): string {
  return TABLE_LABELS[table] ?? table.replace(/_/g, ' ');
}

/** `full_name` → `Full name`. The column is all that is available to name the field. */
function humanColumn(column: string): string {
  const words = column.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The column a not-null violation names.
 *
 * Postgres repeats it in two places: `detail` as `Failing row contains (…)`, and
 * `message` as `null value in column "name" of relation "classes" …`. Only the message
 * is dependable. The connection pooler in use here forwards `detail` for a foreign-key
 * violation but drops it for `23502` and `23505`, so relying on `detail` alone left this
 * message unmapped and the raw Postgres text was shown to the user, naming the table.
 */
function notNullColumn(message?: string | null, detail?: string | null): string | null {
  return (
    detail?.match(/null value in column "([^"]+)"/)?.[1] ??
    message?.match(/null value in column "([^"]+)"/)?.[1] ??
    null
  );
}

/** Postgres SQLSTATE → a message a teacher can act on. */
function friendlyMessage(
  code: string,
  raw?: string | null,
  hint?: string | null,
  detail?: string | null,
): string {
  switch (code) {
    case '42501':
      return 'You do not have permission to do that.';
    case '23505':
      return 'That already exists.';
    case '23503': {
      // Postgres names the referencing table in `detail`:
      //   `Key is still referenced from table "students".`
      //   `Key (id)=(…) is still referenced from table "teacher_assignments".`
      // Saying *what* still holds the reference turns a dead end into a next step.
      const referrer = detail?.match(/still referenced from table "([^"]+)"/)?.[1];
      return referrer
        ? `That is still in use by ${humanTable(referrer)}, so it cannot be removed.`
        : 'That record is still in use elsewhere, so it cannot be changed.';
    }
    case '23502': {
      // Without this the raw text reaches the interface:
      // `null value in column "name" of relation "classes" violates not-null constraint`
      const column = notNullColumn(raw, detail);
      return column ? `${humanColumn(column)} is required.` : 'That field is required.';
    }
    case '23514':
      return hint ?? 'That value is not allowed.';
    case '22003':
      return hint ?? 'That number is outside the permitted range.';
    case 'PGRST116':
    case 'P0002':
      return 'That record could not be found.';
    default:
      return raw || 'Something went wrong. Please try again.';
  }
}

export function toQueryError(error: PgError | null | undefined): QueryError {
  if (!error) return new QueryError('UNKNOWN', 'Something went wrong. Please try again.');

  const code = error.code ?? 'UNKNOWN';
  return new QueryError(
    code,
    friendlyMessage(code, error.message, error.hint, error.details),
    error.details,
    error.hint,
    // Retained for `fieldIssues`, which has to read the original to name the field.
    error.message,
  );
}

/** Throw a `QueryError` for any `{error}` returned by PostgREST. */
export function assertOk<T extends { error: PgError | null }>(result: T): T {
  if (result.error) throw toQueryError(result.error);
  return result;
}

/* -------------------------------------------------------------------------- */
/* RPC results                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The refusal envelope every workflow RPC in `0004_functions.sql` returns.
 *
 * Structural rather than a closed interface so a caller's own result type (which
 * declares `ok`, `code` and `message` without an index signature) is accepted
 * without an intersection at every call site.
 */
export interface RpcResult {
  ok?: boolean;
  code?: string;
  message?: string;
}

/**
 * Unwrap an RPC payload, throwing if the database refused.
 *
 * Those functions deliberately *return* a refusal rather than raising, because
 * the caller needs to tell "version conflict" from "policy refused" from "no
 * changes submitted". Without this, a `SUBMISSION_NOT_EDITABLE` would arrive as a
 * truthy-looking object and the UI would report success on a rejected write.
 */
export function unwrap<T extends RpcResult>(result: T): T {
  if (result?.ok !== true) {
    throw new QueryError(
      result?.code ?? 'UNKNOWN',
      result?.message ?? 'That action was refused.',
    );
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Functions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Call one of the Postgres functions and return its result.
 *
 * Lives here rather than in `supabase.ts` because it needs `toQueryError`: the
 * old copy in `supabase.ts` threw `new Error(error.message)`, handing callers the
 * **raw** database text — the same defect already fixed on the query path, where
 * a `23503` becomes a sentence a person can act on. It could not be corrected in
 * place because `query.ts` imports `getSupabase` from `supabase.ts`, so
 * importing back would close an import cycle. Moving the function breaks the
 * cycle instead of documenting it.
 *
 * ── On the returned shape ─────────────────────────────────────────────────────
 *
 * PostgREST answers a set-returning function (`RETURNS TABLE(...)`) with a JSON
 * **array**, and a scalar-returning one (`RETURNS boolean`, `RETURNS uuid`) with a
 * JSON **object**. The previous version did `data?.[0]`, which is right for the
 * first and quietly wrong for the second: indexing a returned `uuid` string yields
 * its first character. Every call site discarded the result, so nothing was
 * visibly broken — which is exactly how this sort of thing survives. Both shapes
 * are handled explicitly now, and the choice is asserted in the type.
 */
export async function rpc<T = unknown>(
  fn: string,
  args: Record<string, unknown> = {},
): Promise<T | null> {
  const { data, error } = await getSupabase().rpc(fn, args);
  if (error) throw toQueryError(error);
  if (data === null || data === undefined) return null;
  return (Array.isArray(data) ? (data[0] ?? null) : data) as T;
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                         */
/* -------------------------------------------------------------------------- */

export type Row = Record<string, unknown>;

/**
 * Convert a snake_case row to camelCase.
 *
 * Shallow by design — every join the app needs is flat. Nested objects (the
 * `rules` jsonb on a grading scheme, for instance) pass through untouched.
 */
export function camel<T>(row: Row | null | undefined): T | null {
  if (!row) return null;

  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  }
  return out as T;
}

export function camelMany<T>(rows: Row[] | null | undefined): T[] {
  return (rows ?? []).map((row) => camel<T>(row)!);
}

/** Postgres `numeric` arrives as a string over PostgREST. */
export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value) || fallback;
  return fallback;
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Insert one row and return it, camelCased.
 *
 * Postgres reports a uniqueness violation as `23505` with the colliding index in
 * `detail`, but the message alone is "duplicate key value violates unique
 * constraint" — it never says which field. Naming the column is the difference
 * between a user fixing the form and a user filing a bug, so the mapping lives
 * here rather than being repeated by every repo that can create a row.
 *
 * Lives in `query.ts` rather than in one of the domain repos because it is
 * generic: it names a table and a row, and knows nothing about either.
 */
export async function insertRow<T>(table: string, row: Row): Promise<T> {
  const { data, error } = await getSupabase().from(table).insert(row).select().single();

  if (error) {
    if (error.code === '23505') {
      const key = error.details?.match(/Key \(([^)]+)\)/)?.[1]?.replace(/_/g, ' ') ?? 'value';
      throw new QueryError(
        '23505',
        `That ${key} is already in use.`,
        error.details,
        error.hint,
        // Kept like `toQueryError` keeps it: `details` is dropped by the pooler
        // for a duplicate key, and without the original text `fieldIssues` has
        // nothing to name the offending column from.
        error.message,
      );
    }
    throw toQueryError(error);
  }

  // `.single()` succeeded, so there is exactly one row.
  return camel<T>(data)!;
}

/* -------------------------------------------------------------------------- */
/* Builders                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The minimum a PostgREST builder must expose to be filtered and ranged.
 *
 * Declared as a self-type constraint rather than a concrete type on purpose:
 * supabase-js parameterises `PostgrestFilterBuilder` by schema, row, relation and
 * method, and infers all four from the table name and column list. Any helper
 * that *names* that type would force either a generated `Database` type (derived
 * from the live project, so gitignored and able to drift) or an `as never` at
 * every call site. Self-typing lets the caller's own builder type flow through
 * unchanged, and the repos above supply the real row shape via the cast on
 * `data`.
 */
export interface QueryLike<TResult> {
  range(from: number, to: number): QueryLike<TResult>;
  select(
    columns?: string,
    options?: Record<string, unknown>,
  ): PromiseLike<{ data: TResult[] | null; error: PgError | null; count: number | null }>;
}

export interface Filterable<TResult> extends QueryLike<TResult> {
  or(filters: string): Filterable<TResult>;
}

/**
 * Case-insensitive "contains" search across several columns, as a PostgREST
 * `or()` fragment.
 *
 * Returns `undefined` for an empty term, because `or(undefined)` is a runtime
 * error rather than a no-op — the check is easy to forget and the failure is
 * unhelpful.
 */
export function orSearch(columns: string[], term: unknown): string | undefined {
  if (typeof term !== 'string' || !term.trim()) return undefined;

  // `%` and `_` are wildcards to ilike; escape them so a search for "50%" is a
  // literal rather than "anything starting with 50".
  const pattern = `%${term.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
  return columns.map((column) => `${column}.ilike.${pattern}`).join(',');
}

/**
 * Apply an optional search fragment, returning the same builder type.
 *
 * A helper because the null check is easy to get wrong and impossible to see at
 * the call site.
 */
export function applySearch<TBuilder extends Filterable<unknown>>(
  builder: TBuilder,
  fragment: string | undefined,
): TBuilder {
  return fragment ? (builder.or(fragment) as TBuilder) : builder;
}

/** Drop keys whose value is empty, so `eq()` is not called with `''`. */
export function defined<T extends Record<string, unknown>>(values: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return out as Partial<T>;
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                   */
/* -------------------------------------------------------------------------- */

export interface ListParams {
  page: number;
  pageSize: number;
  [key: string]: string | number | boolean | undefined | null;
}

export interface ListResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * Apply pagination and normalise the result into a `ListResponse`.
 *
 * `count: 'exact'` costs an extra scan, which is the right trade here: a school
 * has thousands of marks rows rather than millions, and every list view needs a
 * real total to render pagination correctly.
 *
 * The page is clamped, so deleting the last row on page 7 cannot produce a
 * negative offset and a Postgres error.
 */
export async function paginate<T, TBuilder extends QueryLike<T>>(
  builder: TBuilder,
  params: Pick<ListParams, 'page' | 'pageSize'>,
): Promise<ListResponse<T>> {
  const pageSize = Math.max(1, Math.min(Number(params.pageSize) || 25, 200));
  const page = Math.max(1, Number(params.page) || 1);
  const from = (page - 1) * pageSize;

  const { data, error, count } = await builder
    .range(from, from + pageSize - 1)
    .select('*', { count: 'exact' });

  if (error) throw toQueryError(error);

  const total = count ?? 0;
  return {
    items: camelMany<T>(data as Row[]),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/* -------------------------------------------------------------------------- */
/* Convenience reads                                                            */
/* -------------------------------------------------------------------------- */

/**
 * All matching rows, camelCased.
 *
 * Only for result sets that are bounded by construction — a section roster, a
 * dropdown of subjects. Never for an unbounded table.
 */
export async function selectRows<T>(
  table: string,
  columns = '*',
  build?: (builder: never) => never,
): Promise<T[]> {
  const base = getSupabase().from(table).select(columns);
  const query = (build ? build(base as never) : (base as never)) as PromiseLike<{
    data: unknown;
    error: PgError | null;
  }>;

  const { data, error } = await query;
  if (error) throw toQueryError(error);
  return camelMany<T>(data as Row[] | null);
}

/** At most one row, camelCased. Returns null rather than throwing when absent. */
export async function selectOne<T>(
  table: string,
  columns: string,
  build: (builder: never) => never,
): Promise<T | null> {
  const base = getSupabase().from(table).select(columns);
  const query = (build(base as never) as { limit: (n: number) => unknown }).limit(1) as PromiseLike<{
    data: unknown;
    error: PgError | null;
  }>;

  const { data, error } = await query;
  if (error) throw toQueryError(error);
  return camel<T>((data as Row[] | undefined)?.[0] ?? null);
}