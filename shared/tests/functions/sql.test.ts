import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the `data-proxy` SQL builder.
 *
 * This module builds SQL from caller-supplied names, and identifiers cannot be
 * parameterised in Postgres — so a mistake here is not a bug but an injection
 * point sitting in front of every table in the database. These tests are the only
 * thing standing between a request body and the query text.
 *
 * `_shared/postgres.ts` is mocked wholesale: it exists only to open a connection,
 * and a unit test must not. The catalogue lookups it performs are replaced with a
 * small fixed schema, which also makes the allowlist behaviour explicit — a name
 * absent from `CATALOG` is a name that does not exist.
 */

const CATALOG = [
  { table_name: 'students', column_name: 'id', kind: 'table' },
  { table_name: 'students', column_name: 'full_name', kind: 'table' },
  { table_name: 'students', column_name: 'roll_number', kind: 'table' },
  { table_name: 'students', column_name: 'section_id', kind: 'table' },
  { table_name: 'v_directory', column_name: 'id', kind: 'view' },
  { table_name: 'v_directory', column_name: 'full_name', kind: 'view' },
  // The embed target, and the relation that links to it. `profiles` links from
  // `teacher_id`, which is exactly why the link column cannot be guessed.
  { table_name: 'profiles', column_name: 'id', kind: 'table' },
  { table_name: 'profiles', column_name: 'full_name', kind: 'table' },
  { table_name: 'profiles', column_name: 'email', kind: 'table' },
  { table_name: 'assignment_requests', column_name: 'id', kind: 'table' },
  { table_name: 'assignment_requests', column_name: 'teacher_id', kind: 'table' },
  { table_name: 'assignment_requests', column_name: 'subject_id', kind: 'table' },
  { table_name: 'assignment_requests', column_name: 'status', kind: 'table' },
  { table_name: 'subjects', column_name: 'id', kind: 'table' },
  { table_name: 'subjects', column_name: 'name', kind: 'table' },
];

const RPC_ARGS = [
  { arg_name: 'p_academic_year_id', position: 1 },
  { arg_name: 'p_class_id', position: 2 },
  { arg_name: 'p_section_id', position: 3 },
  { arg_name: 'p_subject_id', position: 4 },
];

const runPrivileged = vi.fn(async (fn: (sql: unknown) => Promise<unknown>) =>
  fn({
    query: async (sql: string) => {
      if (sql.includes('information_schema.columns')) return CATALOG;
      if (sql.includes('pg_proc')) {
        // `present` is the existence probe: one row, no arguments.
        if (sql.includes('true as present')) return [{ present: true }];
        if (/proname\s*=\s*\$1/.test(sql)) return RPC_ARGS;
        return [];
      }
      return [];
    },
  }),
);

vi.mock('../../../supabase/functions/_shared/postgres.ts', () => ({
  runPrivileged,
  runAsCaller: vi.fn(),
  closePool: vi.fn(),
}));

const { buildQuery, buildCount, buildRpc, invalidateCatalog, SqlValidationError } = await import(
  '../../../supabase/functions/_shared/sql.ts'
);

beforeEach(() => {
  // The catalogue is cached for ten minutes; clear it so each test sees the
  // fixture rather than the previous one's.
  invalidateCatalog();
});

describe('identifier allowlist', () => {
  it('rejects a relation that does not exist', async () => {
    await expect(buildQuery({ op: 'select', table: 'pg_authid' })).rejects.toThrow(SqlValidationError);
  });

  it('rejects a table name carrying SQL', async () => {
    await expect(
      buildQuery({ op: 'select', table: 'students; drop table marks', columns: '*' }),
    ).rejects.toThrow(/Unknown relation/);
  });

  it('rejects a column that does not exist on the relation', async () => {
    await expect(buildQuery({ op: 'select', table: 'students', columns: 'nope' })).rejects.toThrow(
      /Unknown column/,
    );
  });

  it('rejects a column borrowed from a different relation', async () => {
    // `section_id` exists on students but not on v_directory.
    await expect(
      buildQuery({ op: 'select', table: 'v_directory', columns: 'section_id' }),
    ).rejects.toThrow(/Unknown column/);
  });

  it('rejects a filter on a column the relation does not have', async () => {
    await expect(
      buildQuery({ op: 'select', table: 'students', filters: [{ column: 'role_id', op: 'eq', value: 1 }] }),
    ).rejects.toThrow(/Unknown column/);
  });

  it('rejects ordering by an unknown column', async () => {
    await expect(
      buildQuery({ op: 'select', table: 'students', order: [{ column: 'secret' }] }),
    ).rejects.toThrow(/Unknown column/);
  });

  it('refuses to write to a view', async () => {
    await expect(buildQuery({ op: 'insert', table: 'v_directory', rows: { id: 'x' } })).rejects.toThrow(
      /view and cannot be written/,
    );
    await expect(buildQuery({ op: 'delete', table: 'v_directory' })).rejects.toThrow(/view/);
  });

  it('allows a view to be read', async () => {
    const built = await buildQuery({ op: 'select', table: 'v_directory', columns: 'full_name' });
    expect(built.sql).toContain('from "v_directory"');
  });
});

describe('values are always bound, never interpolated', () => {
  it('turns a drop-table payload in a value into a parameter', async () => {
    const built = await buildQuery({
      op: 'select',
      table: 'students',
      columns: 'full_name',
      filters: [{ column: 'full_name', op: 'eq', value: "'; drop table students; --" }],
    });

    expect(built.sql).not.toContain('drop table');
    expect(built.sql).toContain('$1');
    expect(built.params).toEqual(["'; drop table students; --"]);
  });

  it('keeps a payload in a select list out of the SQL entirely', async () => {
    await expect(
      buildQuery({ op: 'select', table: 'students', columns: 'full_name, 1) as x(--' }),
    ).rejects.toThrow(/Unknown column/);
  });

  it('binds a payload inside an or() fragment', async () => {
    const built = await buildQuery({
      op: 'select',
      table: 'students',
      columns: 'full_name',
      or: "full_name.eq.x') or 1=1 --",
    });

    expect(built.sql).not.toContain('1=1');
    expect(built.params).toEqual(["x') or 1=1 --"]);
  });

  it('rejects an or() fragment naming an unknown column', async () => {
    await expect(
      buildQuery({ op: 'select', table: 'students', or: 'nope.eq.1' }),
    ).rejects.toThrow(/Unknown column/);
  });

  it('rejects an or() fragment with an unsupported operator', async () => {
    await expect(buildQuery({ op: 'select', table: 'students', or: 'full_name.regex.x' })).rejects.toThrow(
      /Unsupported operator/,
    );
  });

  it('binds values in an insert rather than inlining them', async () => {
    const built = await buildQuery({
      op: 'insert',
      table: 'students',
      rows: { full_name: "Robert'); DROP TABLE students;--" },
    });

    expect(built.sql).not.toContain('DROP TABLE');
    expect(built.params).toEqual(["Robert'); DROP TABLE students;--"]);
  });

  it('rejects an insert naming an unknown column', async () => {
    await expect(
      buildQuery({ op: 'insert', table: 'students', rows: { role_id: 'admin' } }),
    ).rejects.toThrow(/Unknown column/);
  });
});

describe('select construction', () => {
  it('selects every column by default', async () => {
    const built = await buildQuery({ op: 'select', table: 'students' });
    expect(built.sql).toBe('select "students".* from "students"');
    expect(built.params).toEqual([]);
  });

  it('combines several filters with AND', async () => {
    const built = await buildQuery({
      op: 'select',
      table: 'students',
      columns: 'full_name',
      filters: [
        { column: 'full_name', op: 'eq', value: 'Alice' },
        { column: 'roll_number', op: 'gte', value: 3 },
      ],
    });

    expect(built.sql).toContain('where');
    expect(built.sql).toContain(' and ');
    expect(built.params).toEqual(['Alice', 3]);
  });

  it('renders is null and is not null without binding a value', async () => {
    const nulls = await buildQuery({
      op: 'select',
      table: 'students',
      filters: [{ column: 'roll_number', op: 'is', value: null }],
    });
    expect(nulls.sql).toContain('"roll_number" is null');

    const notNulls = await buildQuery({
      op: 'select',
      table: 'students',
      filters: [{ column: 'roll_number', op: 'is', value: false }],
    });
    expect(notNulls.sql).toContain('"roll_number" is not null');
    expect(notNulls.params).toEqual([]);
  });

  it('renders an in() list as one placeholder per value', async () => {
    const built = await buildQuery({
      op: 'select',
      table: 'students',
      filters: [{ column: 'full_name', op: 'in', values: ['a', 'b', 'c'] }],
    });

    expect(built.sql).toContain('in ($1, $2, $3)');
    expect(built.params).toEqual(['a', 'b', 'c']);
  });

  it('treats an empty in() list as matching nothing, without invalid SQL', async () => {
    const built = await buildQuery({
      op: 'select',
      table: 'students',
      filters: [{ column: 'full_name', op: 'in', values: [] }],
    });
    expect(built.sql).toContain('where false');
    expect(built.sql).not.toContain('in ()');
  });

  it('combines an or() group with ordinary filters using AND', async () => {
    const built = await buildQuery({
      op: 'select',
      table: 'students',
      filters: [{ column: 'roll_number', op: 'eq', value: 7 }],
      or: 'full_name.eq.Alice,roll_number.eq.9',
    });

    // The or() group is one predicate joined internally by OR, then ANDed with the
    // ordinary filters — matching PostgREST, where `or` narrows within the same
    // WHERE rather than replacing it.
    expect(built.sql).toContain(' or ');
    expect(built.sql).toContain(' and ');
  });

  it('applies ordering with an explicit nulls placement', async () => {
    const built = await buildQuery({
      op: 'select',
      table: 'students',
      order: [{ column: 'full_name', ascending: false, nullsFirst: false }],
    });
    expect(built.sql).toContain('order by "students"."full_name" desc nulls last');
  });

  it('clamps a limit and converts a range to limit/offset', async () => {
    const limited = await buildQuery({ op: 'select', table: 'students', limit: 999_999 });
    expect(limited.sql).toContain('limit 10000');

    const ranged = await buildQuery({ op: 'select', table: 'students', range: [20, 39] });
    expect(ranged.sql).toContain('limit 20 offset 20');
  });

  it('never emits a negative offset from a hostile range', async () => {
    const built = await buildQuery({ op: 'select', table: 'students', range: [-50, -10] });
    expect(built.sql).not.toContain('-');
    expect(built.sql).toContain('offset 0');
  });

  it('selects a constant for a head request', async () => {
    const built = await buildQuery({ op: 'select', table: 'students', head: true, count: 'exact' });
    expect(built.sql).toContain('select 1 from');
    expect(built.returnsRows).toBe(false);
    expect(built.wantsCount).toBe(true);
  });

  it('ignores the projection on a head request, because it is discarded', async () => {
    // The client speaks PostgREST, where `columns: '1'` is the idiomatic way to ask
    // for a count with no rows, and that is what it sent. This builder validates the
    // column against the relation's real columns, so it answered
    // `Unknown column "1" on "v_directory"` — a 400 for every `head: true` count in
    // the app, including the administrator's teacher headcount.
    //
    // A head query substitutes its own projection, so the requested one is never used.
    // Validating it anyway is not defensiveness, it is just wrong.
    const built = await buildQuery({
      op: 'select',
      table: 'students',
      head: true,
      count: 'exact',
      columns: '1',
    });

    expect(built.sql).toContain('select 1 from');
    expect(built.sql).not.toContain('"1"');
    expect(built.returnsRows).toBe(false);
  });

  it('still validates a projection that is not a head request', async () => {
    // The exemption above is specific to `head`. A real select must not gain the same
    // leniency, or the allowlist would stop protecting ordinary queries.
    await expect(
      buildQuery({ op: 'select', table: 'students', columns: '1' }),
    ).rejects.toThrow(/Unknown column/i);
  });
});

describe('embedded resources', () => {
  it('links on an explicitly named column when the guess would be wrong', async () => {
    // `profiles` would be guessed as `profile_id`; the real link is `teacher_id`.
    const built = await buildQuery({
      op: 'select',
      table: 'assignment_requests',
      columns: 'id, profiles:profiles!teacher_id(full_name, email)',
    });

    // The foreign key is on `assignment_requests`, so the subquery compares the
    // parent's column against the target's `id` — not the other way round, which
    // would ask for a `profiles.teacher_id` that does not exist.
    expect(built.sql).toContain('where "assignment_requests"."teacher_id" = "profiles"."id"');
    expect(built.sql).toContain('as "profiles"');
  });

  it('explains the fix when the guessed link column does not exist', async () => {
    await expect(
      buildQuery({ op: 'select', table: 'students', columns: 'profiles:profiles(full_name)' }),
    ).rejects.toThrow(/State the link explicitly/);
  });

  it('expands several embeds in one select', async () => {
    const built = await buildQuery({
      op: 'select',
      table: 'assignment_requests',
      columns: 'id, subjects:subjects!subject_id(name)',
    });
    expect(built.sql).toContain('as "subjects"');
    expect(built.sql).toContain('where "assignment_requests"."subject_id" = "subjects"."id"');
  });

  it('rejects an embedded target that is not a relation', async () => {
    await expect(
      buildQuery({ op: 'select', table: 'students', columns: 'x:secret_table(a)' }),
    ).rejects.toThrow(/Unknown relation/);
  });

  it('rejects an embedded column the target does not have', async () => {
    await expect(
      buildQuery({
        op: 'select',
        table: 'assignment_requests',
        columns: 'profiles:profiles!teacher_id(nope)',
      }),
    ).rejects.toThrow(/Unknown column/);
  });
});

describe('writes', () => {
  it('builds a multi-row insert', async () => {
    const built = await buildQuery({
      op: 'insert',
      table: 'students',
      rows: [
        { full_name: 'A', roll_number: 1 },
        { full_name: 'B', roll_number: 2 },
      ],
    });

    expect(built.sql).toContain('insert into "students"');
    expect(built.sql).toContain('values ($1, $2), ($3, $4)');
    expect(built.params).toEqual(['A', 1, 'B', 2]);
  });

  it('refuses an update with no values', async () => {
    await expect(buildQuery({ op: 'update', table: 'students', rows: {} })).rejects.toThrow(
      /No values supplied/,
    );
  });

  it('refuses an insert with no rows', async () => {
    await expect(buildQuery({ op: 'insert', table: 'students', rows: [] })).rejects.toThrow(
      /No rows supplied/,
    );
  });

  it('excludes the conflict columns from an upsert update set', async () => {
    const built = await buildQuery({
      op: 'upsert',
      table: 'students',
      onConflict: 'id',
      rows: { id: 'x', full_name: 'A' },
    });

    // Writing the conflict key back is a no-op and makes Postgres reject it.
    expect(built.sql).toContain('on conflict ("id")');
    expect(built.sql).toContain('do update set "full_name" = excluded."full_name"');
    expect(built.sql).not.toContain('"id" = excluded."id"');
  });

  it('falls back to do nothing when every column is the conflict column', async () => {
    const built = await buildQuery({
      op: 'upsert',
      table: 'students',
      onConflict: 'id',
      rows: { id: 'x' },
    });
    expect(built.sql).toContain('do nothing');
  });

  it('requires a where clause target to be a real column on delete', async () => {
    const built = await buildQuery({
      op: 'delete',
      table: 'students',
      filters: [{ column: 'id', op: 'eq', value: 'x' }],
    });
    expect(built.sql).toContain('delete from "students" where');
  });
});

describe('count', () => {
  it('counts with the same filters and parameters', async () => {
    const built = await buildCount({
      op: 'select',
      table: 'students',
      filters: [{ column: 'full_name', op: 'eq', value: 'Alice' }],
    });

    expect(built.sql).toContain('count(*)::bigint');
    expect(built.params).toEqual(['Alice']);
  });
});

describe('rpc', () => {
  it('binds arguments by the name the function declares', async () => {
    const built = await buildRpc('request_assignment', { p_academic_year_id: 'y' });
    expect(built.sql).toContain('public."request_assignment"(');
    expect(built.sql).toContain('"p_academic_year_id" => $1');
    expect(built.params).toEqual(['y']);
  });

  it('rejects an argument the function does not declare', async () => {
    // Otherwise a caller could pass a parameter the signature never mentioned and
    // discover how the function is really wired.
    await expect(buildRpc('request_assignment', { p_bogus: 1 })).rejects.toThrow(/Unknown argument/);
  });

  it('rejects a function name that is not a plain identifier', async () => {
    await expect(buildRpc('fn(); drop table students', {})).rejects.toThrow(/Invalid function name/);
  });
});
