/**
 * Reading a Postgres error out of whatever the driver actually produced.
 *
 * ── The bug this exists to fix ──────────────────────────────────────────────────
 *
 * `@db/postgres` does not spread the Postgres error fields onto the error. It nests
 * them:
 *
 *     PostgresError {
 *       message,
 *       fields: {
 *         severity: 'ERROR',
 *         code:     '23503',        ← the SQLSTATE
 *         message,
 *         detail:   'Key is still referenced from table "students".',
 *         schema:   'public',
 *         table:    'students',
 *         constraint: 'students_class_id_fkey',
 *       },
 *     }
 *
 * Code that read `caught.code` therefore got `undefined`. Every database error in the
 * application was reported as `INTERNAL_ERROR` with the raw Postgres message attached,
 * and the client's `friendlyMessage()` — which maps 23503 to "still referenced by
 * something else", 23505 to "that already exists", 42501 to "you do not have
 * permission" — never matched anything.
 *
 * The symptom was a raw constraint name in the UI: deleting a class that still has
 * students said
 *
 *     update or delete on table "classes" violates foreign key constraint
 *     "students_class_id_fkey" on table "students"
 *
 * which is correct as a database error and useless to a school administrator.
 *
 * ── Why both locations are read ─────────────────────────────────────────────────
 *
 * Not every error here comes from the driver. `AuthError`, `RateLimitError` and the
 * validation errors raised by the SQL builder all carry a top-level `code` — a
 * non-numeric one like `FORBIDDEN` or `INVALID_TRANSITION`. So the nested fields are
 * preferred, because a genuine SQLSTATE is five digits or matches `P####`, and the
 * top-level code is the fallback for everything this codebase raises itself.
 */

export interface PgErrorShape {
  /** SQLSTATE (`23503`), or an application code such as `FORBIDDEN`. */
  code: string | null;
  message: string | null;
  detail: string | null;
  hint: string | null;
  /** The constraint or column the database named, when it named one. */
  constraint: string | null;
}

/** `23503`, `P0002` — a real SQLSTATE, as opposed to one of this app's own codes. */
export function looksLikeSqlstate(code: unknown): code is string {
  return typeof code === 'string' && (/^\d{5}$/.test(code) || /^P\d{4}$/.test(code));
}

/**
 * Extract the code, message and detail from a thrown value, whichever shape it is.
 *
 * Returns all-null rather than throwing, so a caller can always read the result.
 */
export function readError(caught: unknown): PgErrorShape {
  const error = (caught ?? {}) as Record<string, unknown>;

  // The driver's nesting. `fields` is a plain object of strings.
  const nested = (error.fields ?? {}) as Record<string, unknown>;

  const nestedCode = typeof nested.code === 'string' ? nested.code : null;
  const topCode = typeof error.code === 'string' ? error.code : null;

  // Prefer the SQLSTATE. An application code is only used when the driver did not
  // supply one, so a `FORBIDDEN` from `AuthError` is not overwritten and a `23503` is
  // never mistaken for something else.
  const code = looksLikeSqlstate(nestedCode) ? nestedCode : (topCode ?? nestedCode);

  const firstString = (...values: unknown[]): string | null => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
    return null;
  };

  return {
    code,
    // Not `String(caught)` as the last resort: for null or undefined that yields the
    // literal text "null" or "undefined", which is worse than no message because it
    // looks like one.
    message:
      firstString(nested.message, error.message) ??
      (caught === null || caught === undefined ? null : String(caught)),
    detail: firstString(nested.detail, error.detail),
    hint: firstString(nested.hint, error.hint),
    constraint: firstString(nested.constraint, error.constraintName, error.constraint),
  };
}