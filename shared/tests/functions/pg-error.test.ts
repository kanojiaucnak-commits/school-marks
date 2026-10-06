import { describe, expect, it } from 'vitest';
import { looksLikeSqlstate, readError } from '../../../supabase/functions/_shared/pgError';

/**
 * `@db/postgres` nests the Postgres error fields under a `fields` object instead of
 * spreading them onto the error:
 *
 *     PostgresError {
 *       message,
 *       fields: { severity: 'ERROR', code: '23503', message, detail, constraint, … },
 *       query,
 *       name,
 *     }
 *
 * Code reading `caught.code` therefore saw `undefined`, and every database error in the
 * application was reported as `INTERNAL_ERROR` with the raw Postgres message. The
 * client's `friendlyMessage()` — which maps 23503 to "still referenced by something
 * else", 23505 to "that already exists", 42501 to "you do not have permission" — never
 * matched anything.
 *
 * The driver error below is captured from this project's live database: a real attempt
 * to delete a class that still had students.
 */
const REAL_DRIVER_ERROR = {
  name: 'PostgresError',
  message:
    'update or delete on table "classes" violates foreign key constraint ' +
    '"students_class_id_fkey" on table "students"',
  fields: {
    severity: 'ERROR',
    code: '23503',
    message:
      'update or delete on table "classes" violates foreign key constraint ' +
      '"students_class_id_fkey" on table "students"',
    detail: 'Key is still referenced from table "students".',
    schema: 'public',
    table: 'students',
    constraint: 'students_class_id_fkey',
    file: 'ri_triggers.c',
    line: '2612',
    routine: 'ri_ReportViolation',
  },
};

describe('readError', () => {
  describe('the real driver shape', () => {
    it('finds the SQLSTATE, which is not at the top level', () => {
      const read = readError(REAL_DRIVER_ERROR);

      expect(read.code).toBe('23503');
      // The property the buggy code read. Pinning that it is absent is the point: it is
      // why `caught.code` was `undefined`.
      expect((REAL_DRIVER_ERROR as Record<string, unknown>).code).toBeUndefined();
    });

    it('finds the detail, which is what makes the message actionable', () => {
      expect(readError(REAL_DRIVER_ERROR).detail).toBe('Key is still referenced from table "students".');
    });

    it('finds the constraint the database named', () => {
      expect(readError(REAL_DRIVER_ERROR).constraint).toBe('students_class_id_fkey');
    });

    it('recognises the code as a SQLSTATE, so it is not treated as an app code', () => {
      const read = readError(REAL_DRIVER_ERROR);

      expect(looksLikeSqlstate(read.code)).toBe(true);
    });
  });

  describe('application errors, which carry a top-level code', () => {
    // `AuthError`, `RateLimitError` and the SQL builder's own validation errors all
    // raise with a non-numeric code. These must keep working.
    it('reads a top-level FORBIDDEN from an AuthError', () => {
      const read = readError({ code: 'FORBIDDEN', message: 'Your account has been deactivated.' });

      expect(read.code).toBe('FORBIDDEN');
      expect(read.message).toBe('Your account has been deactivated.');
    });

    it('reads an INVALID_TRANSITION from the SQL builder', () => {
      expect(readError({ code: 'INVALID_TRANSITION', message: 'Already approved.' }).code).toBe(
        'INVALID_TRANSITION',
      );
    });

    it('does not let an application code overwrite a real SQLSTATE', () => {
      // If both are present the SQLSTATE is the one the client must branch on.
      const read = readError({
        code: 'SOMETHING_ELSE',
        fields: { code: '23505', message: 'duplicate key' },
      });

      expect(read.code).toBe('23505');
    });
  });

  describe('shapes with nothing usable', () => {
    it('returns all-null rather than throwing on null', () => {
      expect(readError(null)).toEqual({ code: null, message: null, detail: null, hint: null, constraint: null });
    });

    it('falls back to the thrown value stringified, so a message is never blank', () => {
      // A plain `new Error('boom')` has a message but no code; an unexpected throw may
      // have neither, and "undefined" would be worse than the text.
      expect(readError(new Error('boom')).message).toBe('boom');
      expect(readError('a bare string').message).toBe('a bare string');
    });

    it('ignores an empty hint rather than reporting one as present', () => {
      // `hint` decides between "that value is not allowed" and Postgres's own wording.
      // An empty string must not count as supplied.
      expect(readError({ fields: { code: '23514', hint: '' } }).hint).toBeNull();
    });
  });
});

describe('looksLikeSqlstate', () => {
  it('accepts the five-character class the database raises', () => {
    for (const code of ['23503', '23505', '23514', '42501']) {
      expect(looksLikeSqlstate(code)).toBe(true);
    }
  });

  it('accepts the P-prefixed class', () => {
    expect(looksLikeSqlstate('P0002')).toBe(true);
  });

  it('rejects a PostgREST code, which is not a SQLSTATE', () => {
    // `PGRST116` is what PostgREST returns for a `single()` that matched no rows. The
    // client's `friendlyMessage` handles it, but it is not something Postgres raised,
    // so this must not be treated as one — which is also why the original regex was
    // `/^\d{5}$|^P\d{4}$/` rather than a looser match.
    expect(looksLikeSqlstate('PGRST116')).toBe(false);
  });

  it('rejects this application’s own codes', () => {
    // These are what distinguishes a database error from an application error.
    for (const code of ['FORBIDDEN', 'UNAUTHENTICATED', 'RATE_LIMITED', 'INVALID_TRANSITION']) {
      expect(looksLikeSqlstate(code)).toBe(false);
    }
  });

  it('rejects non-strings and near-misses', () => {
    expect(looksLikeSqlstate(undefined)).toBe(false);
    expect(looksLikeSqlstate(null)).toBe(false);
    expect(looksLikeSqlstate(23503)).toBe(false);
    // Six digits is not a SQLSTATE; four digits alone is not one either.
    expect(looksLikeSqlstate('235030')).toBe(false);
    expect(looksLikeSqlstate('0002')).toBe(false);
  });
});