import { jsonSafe } from './json.ts';

/**
 * Encode bound parameters so the Postgres driver sends what Postgres expects.
 *
 * ── Why this is not a one-liner ────────────────────────────────────────────────
 *
 * `@db/postgres` serialises a parameter in `query/encode.ts`:
 *
 *     if (value instanceof Array)  return encodeArray(value);   // {"a","b"}
 *     if (value instanceof Object) return JSON.stringify(value);
 *
 * The first branch wins, and it does so **unconditionally** — the driver cannot
 * know the target column type, so a JavaScript array is always sent as a Postgres
 * *array literal* and never as JSON. That is the right default for a real array
 * column, and completely wrong for a `jsonb` value that happens to be an array.
 *
 * The failure is not a type error, which is what makes it so easy to miss. The
 * array literal for `save_marks_grid`'s `p_rows` looked like this on the wire:
 *
 *     {"{\"studentId\":\"…\",\"marks\":72,\"status\":\"PRESENT\",\"remarks\":null}"}
 *
 * Each element's JSON was escaped and quoted, so Postgres read the whole thing as a
 * single *key*. It then asked for the `:` that must follow a key, found `}` instead,
 * and answered:
 *
 *     22P02  invalid input syntax for type json
 *     Expected ":", but found "}".
 *
 * That is a syntax complaint about JSON, so it reads like a payload problem and
 * sends you looking at the client. The payload was fine. The driver was wrong.
 *
 * ── What it broke ──────────────────────────────────────────────────────────────
 *
 * Every `jsonb` function argument that is an array, and every `jsonb` *column* that
 * is written with an array value:
 *
 *   save_marks_grid(p_rows jsonb)        — every mark save
 *   save_grading_scheme(p_rules jsonb)   — creating and editing a grading scheme
 *   replace_ocr_results(p_results jsonb) — confirming OCR output
 *   export_jobs.params                   — queued export parameters
 *   import_batches.rows                  — a student's imported row
 *
 * The first of those is the autosave at the centre of the application, and it failed
 * for every teacher, every time, with a 500 and no message in the UI.
 *
 * ── Why stringifying is safe here ──────────────────────────────────────────────
 *
 * Because the array is sent as *text*, the parameter type is unspecified and
 * Postgres infers it from context — the `jsonb` argument, or the `jsonb` column in
 * `insert … values ($1)` — and applies its implicit `text → jsonb` cast. That is
 * already what happens today, which is exactly why the driver's own text reached the
 * JSON parser and produced a JSON error rather than a type error.
 *
 * The one thing this would break is a genuine array **column**, which needs the array
 * literal. There are none: `public` contains no array-typed column, and `op: 'in'`
 * filters are expanded into one placeholder per value in `buildWhere`, so an
 * `in (…)` list never arrives here as an array either. `assertNoArrayColumns` is the
 * tripwire for that assumption.
 *
 * This lives outside `postgres.ts` because that module imports the Deno driver, which
 * must never be resolved under Node — a pure function sitting there would be
 * unreachable from a test.
 */

/** Postgres types an array parameter could legitimately target. */
const ARRAY_TYPE_NAMES = /\[\]$/;

/**
 * Convert parameters the driver would mis-encode into text Postgres can cast.
 *
 * Non-array values pass through untouched: the driver already handles `null`,
 * `Date`, `Uint8Array`, booleans, numbers and plain objects correctly, and rewriting
 * them here would only add a way to get them wrong.
 */
export function encodeParams(params: readonly unknown[]): unknown[] {
  return params.map((value) => {
    // A nested array can only be a real array literal (or a mis-encoded jsonb array
    // of arrays), so it takes the same path. `jsonSafe` runs first because
    // `JSON.stringify` throws outright on a BigInt, and a `count(*)` read back into
    // a payload is exactly how a bigint gets in there.
    if (Array.isArray(value)) {
      return JSON.stringify(jsonSafe(value));
    }
    return value;
  });
}

/**
 * Guard for the one assumption {@link encodeParams} makes.
 *
 * Intended to be called from a migration check or a test, not the request path: if a
 * `text[]` column is ever added, arrays must stop being stringified and the driver
 * needs to be told the type explicitly instead.
 */
export function assertNoArrayColumns(
  columns: ReadonlyArray<{ table: string; column: string; type: string }>,
): string[] {
  return columns
    .filter((column) => ARRAY_TYPE_NAMES.test(column.type))
    .map((column) => `${column.table}.${column.column} ${column.type}`);
}
