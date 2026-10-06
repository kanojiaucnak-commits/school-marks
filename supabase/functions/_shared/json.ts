/**
 * Make a result set safe to `JSON.stringify`.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────
 *
 * Postgres `int8`/`bigint` comes back from the driver as a JavaScript `BigInt`, and
 * `JSON.stringify` refuses one outright:
 *
 *     TypeError: Do not know how to serialize a BigInt
 *
 * So any query touching a `bigint` column failed with a 500. That is not a rare edge
 * case: `count(*)` returns `int8`, which made the administrator's dashboard — and every
 * `head: true` count in the app — fail with a message that says nothing about the
 * cause. It presented as "the page will not load", and the logs named a serialisation
 * problem rather than the query.
 *
 * ── Why numbers, and why not always ─────────────────────────────────────────────
 *
 * The browser is a JSON consumer, so there is no way to preserve a BigInt on the wire
 * regardless. A count is well inside `Number.MAX_SAFE_INTEGER`, so it is sent as a
 * number — which is what the frontend already expects and what PostgREST returns for
 * the same query. A value too large for that is sent as a *string* rather than silently
 * rounded, so a loss of precision is visible instead of invisible.
 *
 * `Date` is deliberately left alone: `JSON.stringify` handles it, as ISO 8601.
 *
 * This lives in its own module rather than in `postgres.ts` because it has nothing to
 * do with connecting. Keeping it separate is also what makes it testable: `postgres.ts`
 * imports the Deno Postgres driver, which must never be resolved under Node, so a pure
 * function sitting in that file would be unreachable from a test.
 */

/**
 * Convert BigInts to JSON-safe values, recursing into arrays and plain objects.
 *
 * Leaves everything else untouched.
 */
export function jsonSafe<T>(value: T): T {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return (Number.isSafeInteger(asNumber) ? asNumber : value.toString()) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => jsonSafe(entry)) as unknown as T;
  }

  // Only plain objects are walked. A Date has toJSON(); a Buffer or other class
  // instance has its own representation, and rebuilding it as a bare object would lose
  // both.
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = jsonSafe(entry);
      }
      return out as unknown as T;
    }
  }

  return value;
}