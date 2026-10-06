import { describe, expect, it } from 'vitest';
import { jsonSafe } from '../../../supabase/functions/_shared/json';

/**
 * `jsonSafe()` exists because Postgres `int8` arrives as a JavaScript `BigInt`, which
 * `JSON.stringify` throws on:
 *
 *     TypeError: Do not know how to serialize a BigInt
 *
 * That surfaced as the administrator's dashboard failing to load — `count(*)` returns
 * `int8`, so `v_admin_counts` threw a 500 whose message named neither the query nor
 * the cause, and every `head: true` count in the app was equally broken.
 *
 * These tests assert the property that actually matters: the output is stringifiable.
 */
describe('jsonSafe', () => {
  it('converts a BigInt count to a number, matching what PostgREST returns', () => {
    expect(jsonSafe({ count: 16n })).toEqual({ count: 16 });
  });

  it('keeps the common counts as numbers', () => {
    // 0 and 1 are the values that appear in nearly every dashboard tile, and 0 is
    // falsy — a `|| 0` fallback downstream would hide it if this became `'0'`.
    expect(jsonSafe({ students: 0n, sections: 1n, subjects: 42n })).toEqual({
      students: 0,
      sections: 1,
      subjects: 42,
    });
  });

  it('sends a value beyond the safe integer range as a string rather than rounding it', () => {
    // Silently rounding here would be worse than the original crash: the number would
    // look plausible and be wrong.
    const huge = 9_007_199_254_740_993n; // Number.MAX_SAFE_INTEGER + 2
    expect(jsonSafe({ big: huge })).toEqual({ big: '9007199254740993' });
    expect(Number.isSafeInteger(Number(huge))).toBe(false);
  });

  it('handles the exact safe-integer boundary', () => {
    const edge = BigInt(Number.MAX_SAFE_INTEGER);
    expect(jsonSafe({ n: edge })).toEqual({ n: Number.MAX_SAFE_INTEGER });
  });

  it('handles negative BigInts', () => {
    expect(jsonSafe({ delta: -5n })).toEqual({ delta: -5 });
  });

  it('stringifies cleanly, which is the whole point', () => {
    expect(() => JSON.stringify(jsonSafe({ count: 16n }))).not.toThrow();
    expect(JSON.stringify(jsonSafe({ count: 16n }))).toBe('{"count":16}');
  });

  it('reaches BigInts nested inside a JSON column', () => {
    // jsonb values arrive as already-parsed objects, so a bigint inside one is
    // invisible to a top-level check.
    const row = { stats: { students: 16n, nested: [{ marks: 3n }] } };
    expect(() => JSON.stringify(jsonSafe(row))).not.toThrow();
    expect(jsonSafe(row)).toEqual({ stats: { students: 16, nested: [{ marks: 3 }] } });
  });

  it('walks arrays of rows', () => {
    expect(jsonSafe([{ id: 1n }, { id: 2n }])).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('leaves a Date alone so JSON.stringify can use its toJSON', () => {
    const date = new Date('2026-10-05T00:00:00.000Z');
    const out = jsonSafe({ at: date });
    expect(out.at).toBeInstanceOf(Date);
    expect(JSON.parse(JSON.stringify(out)).at).toBe('2026-10-05T00:00:00.000Z');
  });

  it('does not strip a class instance down to a bare object', () => {
    // A Buffer or similar has its own JSON representation. Rebuilding it as a plain
    // object would turn a byte string into `{"0":1,"1":2,…}`.
    class Thing {
      constructor(public readonly label: string) {}
      toJSON() {
        return { label: this.label };
      }
    }
    const thing = new Thing('x');
    expect(jsonSafe({ thing }).thing).toBe(thing);
  });

  it('passes through the value types a row is mostly made of', () => {
    const row = {
      id: '00000000-0000-0000-0000-000000000501',
      name: 'Aarav Sharma',
      active: true,
      score: 42.5,
      level: null,
    };
    expect(jsonSafe(row)).toEqual(row);
  });

  it('handles a bare BigInt and null without special-casing the caller', () => {
    expect(jsonSafe(7n)).toBe(7);
    expect(jsonSafe(null)).toBeNull();
    expect(jsonSafe(undefined)).toBeUndefined();
  });
});