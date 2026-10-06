import { describe, expect, it } from 'vitest';
import { assertNoArrayColumns, encodeParams } from '../../../supabase/functions/_shared/params';

/**
 * Bound-parameter encoding for `@db/postgres`.
 *
 * ── The bug this pins ──────────────────────────────────────────────────────────
 *
 * The driver serialises a parameter like this:
 *
 *     if (value instanceof Array)  return encodeArray(value);   // {"a","b"}
 *     if (value instanceof Object) return JSON.stringify(value);
 *
 * The array branch wins unconditionally, because the driver has no way to know the
 * target type. So a `jsonb` argument holding an array was sent as a Postgres array
 * literal of one escaped-JSON element:
 *
 *     {"{\"studentId\":\"…\",\"marks\":72,\"status\":\"PRESENT\"}"}
 *
 * Postgres read the whole element as a single *key*, asked for the `:` that must
 * follow a key, found `}`, and returned:
 *
 *     22P02  invalid input syntax for type json
 *     Expected ":", but found "}".
 *
 * That reads like a malformed client payload, and the payload was fine — which is why
 * this went unnoticed until `save_marks_grid` was actually exercised. Marks autosave,
 * grading-scheme editing and OCR confirmation all failed for every user, always.
 *
 * The fix is to stringify array parameters here so they arrive as text, which Postgres
 * casts to `jsonb` implicitly (the parameter type is unspecified, so it is inferred
 * from the argument or column).
 */

/**
 * Reproduce the driver's `encodeArgument` + `encodeArray` for a single parameter, so
 * the test asserts against what the driver would really send rather than a paraphrase.
 */
function driverWireValue(value: unknown): string {
  if (value === null || typeof value === 'undefined') return '\0null';
  if (value instanceof Array) {
    let out = '{';
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out += ',';
      const element = value[i];
      const encoded = element instanceof Object && !(element instanceof Date)
        ? JSON.stringify(element)
        : String(element);
      out += `"${encoded.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return `${out}}`;
  }
  if (value instanceof Object) return JSON.stringify(value);
  return String(value);
}

const MARKS_ROWS = [
  {
    studentId: '00000000-0000-0000-0000-000000000501',
    marks: 72,
    status: 'PRESENT',
    remarks: null,
  },
];

describe('encodeParams', () => {
  it('sends an array as JSON text, not as an array literal', () => {
    const [encoded] = encodeParams([MARKS_ROWS]);

    // The exact text Postgres must receive for `p_rows jsonb`.
    expect(encoded).toBe(JSON.stringify(MARKS_ROWS));
    expect(() => JSON.parse(encoded as string)).not.toThrow();
  });

  it('no longer produces the literal the driver used to send', () => {
    const before = driverWireValue(MARKS_ROWS);
    const [after] = encodeParams([MARKS_ROWS]);

    // Sanity check on the reproduction itself: the old wire form is what produced
    // `Expected ":", but found "}"`, and it is not valid JSON.
    expect(before).toMatch(/^\{"\{.*\\".*"\}$/);
    expect(() => JSON.parse(before)).toThrow();

    expect(after).not.toBe(before);
    expect(JSON.parse(after as string)).toEqual(MARKS_ROWS);
  });

  it('handles an empty array, which the array literal also got wrong', () => {
    // `encodeArray([])` produces `{}`, which is a valid jsonb *object*, not array.
    // `save_marks_grid` checks `jsonb_array_length(p_rows) = 0`, so a silently
    // retyped payload would have taken the wrong branch.
    expect(driverWireValue([])).toBe('{}');

    const [encoded] = encodeParams([[]]);
    expect(encoded).toBe('[]');
    expect(Array.isArray(JSON.parse(encoded as string))).toBe(true);
  });

  it('keeps null and undefined as SQL NULL rather than text', () => {
    // `params.push(value ?? null)` in `buildRpc` already normalises undefined, but a
    // null must not become the four characters "null" — that is a value, not NULL.
    expect(encodeParams([null, undefined])).toEqual([null, undefined]);
  });

  it('leaves scalars, dates and plain objects to the driver', () => {
    const date = new Date('2026-09-14T00:00:00.000Z');
    const params = [
      '00000000-0000-0000-0000-000000000101',
      42,
      true,
      date,
      { grade: 'A', gradePoint: 4 },
      null,
    ];

    expect(encodeParams(params)).toEqual(params);
  });

  it('preserves argument order and count, so placeholders stay aligned', () => {
    const params = ['a', MARKS_ROWS, 7, null];
    const encoded = encodeParams(params);

    expect(encoded).toHaveLength(params.length);
    expect(encoded[0]).toBe('a');
    expect(encoded[1]).toBe(JSON.stringify(MARKS_ROWS));
    expect(encoded[2]).toBe(7);
    expect(encoded[3]).toBeNull();
  });

  it('converts a BigInt inside the array instead of throwing', () => {
    // `JSON.stringify` refuses a BigInt outright, and a bigint gets into a payload
    // the moment a `count(*)` is read back — the same class of failure `jsonSafe`
    // exists for on the way out.
    expect(() => encodeParams([[{ count: 3n }]])).not.toThrow();
    expect(encodeParams([[{ count: 3n }]])[0]).toBe('[{"count":3}]');
  });

  it('keeps a bigint that is too large as a string rather than rounding it', () => {
    const huge = 9007199254740993n;
    expect(encodeParams([[{ n: huge }]])[0]).toBe(`[{"n":"${huge}"}]`);
  });

  it('does not mutate the caller’s array', () => {
    const rows = [{ studentId: 'x', marks: 1 }];
    encodeParams([rows]);
    expect(rows).toEqual([{ studentId: 'x', marks: 1 }]);
  });
});

describe('assertNoArrayColumns', () => {
  it('is empty for the current schema', () => {
    // The whole justification for stringifying arrays is that no column in `public`
    // is a real Postgres array. This is the tripwire if that ever stops being true.
    expect(
      assertNoArrayColumns([
        { table: 'export_jobs', column: 'params', type: 'jsonb' },
        { table: 'import_batches', column: 'rows', type: 'jsonb' },
        { table: 'students', column: 'full_name', type: 'text' },
      ]),
    ).toEqual([]);
  });

  it('names the column that would need the driver told the type explicitly', () => {
    expect(
      assertNoArrayColumns([
        { table: 'students', column: 'full_name', type: 'text' },
        { table: 'students', column: 'tags', type: 'text[]' },
        { table: 'subjects', column: 'codes', type: 'character varying(2)[]' },
      ]),
    ).toEqual(['students.tags text[]', 'subjects.codes character varying(2)[]']);
  });
});
