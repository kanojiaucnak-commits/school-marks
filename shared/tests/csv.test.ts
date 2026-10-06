import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvToObjects, toCsv } from '../src/utils.js';

/**
 * The CSV contract both CSV implementations must satisfy.
 *
 * There are two copies of this logic: here (used by the browser) and in
 * `supabase/functions/_shared/csv.ts` (used by Edge Functions, which run on Deno
 * and cannot resolve this workspace package).
 *
 * These tests pin the behaviour of the copy that *can* be executed in CI, and the
 * cases are chosen so the Deno copy can be asserted against the same list by hand
 * or in a Deno test run. A divergence is not cosmetic: the export functions write
 * CSV with the Deno copy and the import preview reads CSV with it, so a
 * disagreement about quoting would make a school's own export fail to re-import.
 */

/**
 * Excel needs a UTF-8 BOM to open a non-ASCII file correctly, and `toCsv` emits
 * one — this app's student names are full of accented characters. Every assertion
 * below therefore compares against a BOM-prefixed, CRLF-terminated string, and the
 * BOM is asserted explicitly so it cannot be dropped by accident.
 */
const BOM = '\uFEFF';

/** Strip the BOM so the escaping assertions read cleanly. */
function body(csv: string): string {
  return csv.replace(/^\uFEFF/, '');
}

describe('toCsv', () => {
  it('emits a UTF-8 BOM so Excel opens non-ASCII names correctly', () => {
    expect(toCsv([{ name: 'Renée Ångström' }]).startsWith(BOM)).toBe(true);
  });

  it('writes a header from the first row', () => {
    expect(body(toCsv([{ full_name: 'Amara Osei', roll_number: 1 }]))).toBe(
      'full_name,roll_number\r\nAmara Osei,1\r\n',
    );
  });

  it('takes the header from every row, not just the first', () => {
    // A row missing a later column must still get a cell, or the columns shift.
    expect(body(toCsv([{ a: 1 }, { a: 2, b: 3 }]))).toBe('a,b\r\n1,\r\n2,3\r\n');
  });

  it('returns an empty string for no rows and no explicit header', () => {
    expect(toCsv([])).toBe('');
  });

  it('writes only the header when given headers and no rows', () => {
    expect(body(toCsv([], ['a', 'b']))).toBe('a,b\r\n');
  });

  it('quotes fields containing the delimiter', () => {
    expect(body(toCsv([{ full_name: 'Osei, Amara' }]))).toBe('full_name\r\n"Osei, Amara"\r\n');
  });

  it('doubles embedded quotes', () => {
    expect(body(toCsv([{ remarks: 'He said "well"' }]))).toBe(
      'remarks\r\n"He said ""well"""\r\n',
    );
  });

  it('quotes fields containing newlines', () => {
    expect(body(toCsv([{ remarks: 'line one\nline two' }]))).toBe(
      'remarks\r\n"line one\nline two"\r\n',
    );
  });

  it('writes null and undefined as empty cells but keeps a zero', () => {
    expect(body(toCsv([{ a: null, b: undefined, c: 0 }]))).toBe('a,b,c\r\n,,0\r\n');
  });

  it('honours an explicit header order', () => {
    expect(body(toCsv([{ a: '1', b: '2' }], ['b', 'a']))).toBe('b,a\r\n2,1\r\n');
  });
});

describe('parseCsv', () => {
  it('splits plain rows', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles CRLF', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps delimiters inside quotes', () => {
    expect(parseCsv('a,b\n"x,y",z')).toEqual([
      ['a', 'b'],
      ['x,y', 'z'],
    ]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('a\n"say ""hi"""')).toEqual([['a'], ['say "hi"']]);
  });

  it('keeps newlines inside quoted fields', () => {
    expect(parseCsv('a\n"one\ntwo"')).toEqual([['a'], ['one\ntwo']]);
  });

  it('preserves empty cells', () => {
    expect(parseCsv('a,b,c\n1,,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });

  it('returns nothing for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('parseCsvToObjects', () => {
  it('keys rows by header', () => {
    expect(parseCsvToObjects('name,score\nAmara,42')).toEqual([{ name: 'Amara', score: '42' }]);
  });

  it('fills missing trailing cells with empty strings', () => {
    expect(parseCsvToObjects('a,b,c\n1')).toEqual([{ a: '1', b: '', c: '' }]);
  });

  it('returns nothing for empty input', () => {
    expect(parseCsvToObjects('')).toEqual([]);
  });
});

describe('round trip', () => {
  /**
   * These three rows each break a naive implementation in a different way:
   * a delimiter inside quotes, an escaped quote, and an embedded newline.
   */
  const rows = [
    { name: 'Amara Osei', remark: 'Steady progress', score: 42 },
    { name: 'Chen, Wei', remark: 'Said "excellent" today', score: 51 },
    { name: 'Diallo, Fatou', remark: 'Line one\nline two', score: 37 },
  ];

  it('survives write-then-read unchanged', () => {
    const parsed = parseCsvToObjects(toCsv(rows));

    expect(parsed).toHaveLength(3);
    rows.forEach((row, index) => {
      expect(parsed[index]?.name).toBe(row.name);
      expect(parsed[index]?.remark).toBe(row.remark);
      expect(parsed[index]?.score).toBe(String(row.score));
    });
  });
});