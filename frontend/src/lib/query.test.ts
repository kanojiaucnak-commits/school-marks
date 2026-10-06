import { describe, expect, it } from 'vitest';
import { toQueryError } from './query';

/**
 * The messages here are the only thing a user sees when the database refuses something,
 * so they are worth pinning. `PgError` is the shape `data-proxy` returns:
 *
 *     { success: false, error: { code, message, details, hint } }
 *
 * The `details` field matters more than it looks. Postgres puts the offending row in it
 * for a duplicate key (`Key (academic_year_id, name)=(…, Grade 6) already exists.`) and
 * the referencing table in it for a foreign-key violation
 * (`Key is still referenced from table "students".`). `QueryError.fieldIssues` parses the
 * first of those into an inline form error, and the 23503 message is built from the
 * second. Both were unreachable before, because the Edge Function read the SQLSTATE off
 * the top level of the driver's error object where it does not exist, so every database
 * refusal arrived as `INTERNAL_ERROR` with the raw Postgres message.
 */
describe('toQueryError', () => {
  describe('23503, a foreign-key violation', () => {
    // Captured verbatim from a delete of a class that still had six students.
    const error = toQueryError({
      code: '23503',
      message:
        'update or delete on table "classes" violates foreign key constraint ' +
        '"students_class_id_fkey" on table "students"',
      details: 'Key is still referenced from table "students".',
      hint: null,
    });

    it('keeps the SQLSTATE, so callers can branch on it', () => {
      expect(error.code).toBe('23503');
    });

    it('reports the violation as one', () => {
      expect(error.isReferenceError).toBe(true);
    });

    it('names what still holds the reference, in words rather than a table name', () => {
      // "still referenced from table \"students\"" is accurate and useless. The whole
      // point of the detail is that it can say *what* is in the way.
      expect(error.message).toBe('That is still in use by a student, so it cannot be removed.');
      expect(error.message).not.toContain('_');
      expect(error.message).not.toContain('constraint');
    });

    it('handles the keyed form of the detail, which also carries the key', () => {
      // Postgres uses this spelling when the constraint names more than one column.
      const keyed = toQueryError({
        code: '23503',
        message: 'update or delete on table "classes" violates foreign key constraint',
        details: 'Key (id)=(00000000-0000-0000-0000-000000000203) is still referenced from table "students".',
        hint: null,
      });

      expect(keyed.message).toBe('That is still in use by a student, so it cannot be removed.');
    });

    it('labels the less obvious referencing tables readably', () => {
      const teacher = toQueryError({
        code: '23503',
        message: '…',
        details: 'Key is still referenced from table "teacher_assignments".',
        hint: null,
      });

      expect(teacher.message).toContain('teacher');
      expect(teacher.message).not.toContain('teacher_assignments');
    });

    it('falls back to the class that does not end in an underscore', () => {
      // A table this map has never heard of must still read as English rather than
      // leaking an identifier into the interface.
      const unknown = toQueryError({
        code: '23503',
        message: '…',
        details: 'Key is still referenced from table "some_new_thing".',
        hint: null,
      });

      expect(unknown.message).toBe('That is still in use by some new thing, so it cannot be removed.');
    });

    it('still says something sensible when the detail is missing', () => {
      // Older responses, and any error raised outside Postgres, arrive without one.
      const bare = toQueryError({ code: '23503', message: '…', details: null, hint: null });

      expect(bare.message).toBe('That record is still in use elsewhere, so it cannot be changed.');
    });

    it('does not mistake a detail from another code for a table reference', () => {
      // 23505's detail names columns and a key, not a referrer. Only the 23503 wording
      // should be read as a table name.
      const duplicate = toQueryError({
        code: '23505',
        message: 'duplicate key value violates unique constraint "classes_academic_year_id_name_key"',
        details: 'Key (academic_year_id, name)=(00000000-…, Grade 6) already exists.',
        hint: null,
      });

      expect(duplicate.message).toBe('That already exists.');
    });
  });

  describe('23505, a duplicate key', () => {
    // Captured from a live duplicate-class-name insert.
    const LIVE_DUPLICATE = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "classes_academic_year_id_name_key"',
      details: null,
      hint: null,
    };

    it('is reported as "already exists" rather than as a constraint name', () => {
      // This is the message the live path actually produces, and what the user sees.
      expect(toQueryError(LIVE_DUPLICATE).message).toBe('That already exists.');
    });

    it('never leaks the constraint name into the interface', () => {
      const error = toQueryError(LIVE_DUPLICATE);

      expect(error.message).not.toContain('classes_academic_year_id_name_key');
      expect(error.message).not.toContain('duplicate key');
    });

    it('falls back to the banner when no key detail arrives', () => {
      // The pooler forwards `detail` for a foreign-key violation but drops it here, so
      // the `Key (…) already exists.` pattern is not available on this path and the
      // error has to stand on its message alone. Asserted so that if the pooler ever
      // starts forwarding it, the inline error appears and this test says so.
      expect(toQueryError(LIVE_DUPLICATE).fieldIssues).toEqual([]);
    });

    it('turns the key detail into an inline error naming the field', () => {
      // Reached over PostgREST, and over a direct connection, where `detail` arrives.
      const error = toQueryError({
        code: '23505',
        message: 'duplicate key value violates unique constraint "classes_academic_year_id_name_key"',
        details: 'Key (academic_year_id, name)=(00000000-…, Grade 6) already exists.',
        hint: null,
      });

      expect(error.fieldIssues).toEqual([
        { path: 'academic_year_id', message: 'That academic year id is already in use.' },
      ]);
    });
  });

  describe('23502, a missing required value', () => {
    // Captured from a live insert that omitted `name`.
    const LIVE_NOT_NULL = {
      code: '23502',
      message: 'null value in column "name" of relation "classes" violates not-null constraint',
      details: null,
      hint: null,
    };

    it('names the field instead of showing the raw Postgres text', () => {
      // Without a mapping this reached the interface verbatim, telling a school
      // administrator about `relation "classes"` — schema, not school.
      const error = toQueryError(LIVE_NOT_NULL);

      expect(error.message).toBe('Name is required.');
      expect(error.message).not.toContain('relation');
      expect(error.message).not.toContain('constraint');
    });

    it('produces an inline error on the field, with no detail to parse', () => {
      // The pooler drops `detail` for this code, so the column has to come from the
      // message. Without that, the error was a banner the form could not attach to an
      // input, and the user had to work out which field was empty themselves.
      expect(toQueryError(LIVE_NOT_NULL).fieldIssues).toEqual([
        { path: 'name', message: 'Name is required.' },
      ]);
    });

    it('reads the column from a snake_case name in the message', () => {
      const error = toQueryError({
        code: '23502',
        message:
          'null value in column "full_name" of relation "students" violates not-null constraint',
        details: null,
        hint: null,
      });

      expect(error.message).toBe('Full name is required.');
      expect(error.fieldIssues).toEqual([{ path: 'full_name', message: 'Full name is required.' }]);
    });

    it('still says something when the column cannot be identified', () => {
      expect(toQueryError({ code: '23502', message: 'not-null violated', details: null, hint: null }).message).toBe(
        'That field is required.',
      );
    });
  });

  describe('the codes the UI branches on', () => {
    it.each([
      ['42501', 'You do not have permission to do that.'],
      ['23514', 'That value is not allowed.'],
      ['22003', 'That number is outside the permitted range.'],
      ['PGRST116', 'That record could not be found.'],
      ['P0002', 'That record could not be found.'],
    ])('maps %s', (code, expected) => {
      expect(toQueryError({ code, message: 'raw postgres text', details: null, hint: null }).message).toBe(
        expected,
      );
    });

    it('prefers a Postgres hint over the generic message, since it is specific', () => {
      const error = toQueryError({
        code: '23514',
        message: '…',
        details: null,
        hint: 'Mark cannot exceed the exam maximum.',
      });

      expect(error.message).toBe('Mark cannot exceed the exam maximum.');
    });

    it('never leaks a raw Postgres message for a code it recognises', () => {
      // A regression guard on the whole point of the mapping: for every SQLSTATE the
      // switch handles, the user-facing text must be the friendly one. Before this was
      // fixed the 23503 and 23502 cases both passed the raw database text straight
      // through, naming tables and constraints.
      const recognised = [
        '42501',
        '23505',
        '23503',
        '23502',
        '23514',
        '22003',
        'PGRST116',
        'P0002',
      ];
      for (const code of recognised) {
        const error = toQueryError({
          code,
          message:
            'null value in column "name" of relation "classes" violates not-null constraint ' +
            'on table "students" violates foreign key constraint "students_class_id_fkey"',
          details: null,
          hint: null,
        });
        expect(error.message, `${code} leaked raw Postgres text`).not.toMatch(
          /relation|constraint|duplicate key|violates/i,
        );
      }
    });

    it('falls back to the raw message only for codes it has no mapping for', () => {
      const error = toQueryError({
        code: '42883',
        message: 'operator does not exist: text ?? text',
        details: null,
        hint: null,
      });

      expect(error.message).toBe('operator does not exist: text ?? text');
    });
  });

  describe('with nothing to work from', () => {
    it('says something rather than reporting a blank error', () => {
      expect(toQueryError(null).message).toBe('Something went wrong. Please try again.');
      // A response missing `code` altogether, which is what an unmapped failure looks
      // like. It must not be mistaken for a code and it must not render as an empty
      // string, which is what `''` would produce.
      expect(toQueryError({ message: null, details: null, hint: null }).code).toBe('UNKNOWN');
    });
  });
});