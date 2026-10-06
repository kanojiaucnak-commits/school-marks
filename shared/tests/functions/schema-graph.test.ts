import { describe, expect, it } from 'vitest';
import {
  buildSchemaGraph,
  displayType,
  type CatalogRows,
} from '../../../supabase/functions/schema-graph/schemaGraph';

/**
 * The pin between "the live catalog says this" and "the visualiser draws
 * that".
 *
 * `schema-graph` returns exactly this module's output, so these tests are the
 * contract the page renders against. The two things that must never happen:
 *  - a malformed catalog row fabricating a table or edge (the browser would
 *    draw relationships the database does not have);
 *  - a multi-column foreign key collapsing to one edge or losing its column
 *    pairing (FK columns would point at the wrong primary key).
 */

function rows(overrides: Partial<CatalogRows> = {}): CatalogRows {
  return {
    tables: [
      { name: 'students', kind: 'r' },
      { name: 'marks', kind: 'r' },
      { name: 'v_summary', kind: 'v' },
    ],
    columns: [
      { table_name: 'students', column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO' },
      { table_name: 'students', column_name: 'roll_no', data_type: 'integer', udt_name: 'int4', is_nullable: 'YES' },
      { table_name: 'marks', column_name: 'id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO' },
      { table_name: 'marks', column_name: 'student_id', data_type: 'uuid', udt_name: 'uuid', is_nullable: 'NO' },
      { table_name: 'marks', column_name: 'tags', data_type: 'ARRAY', udt_name: '_text', is_nullable: 'YES' },
      { table_name: 'v_summary', column_name: 'total', data_type: 'bigint', udt_name: 'int8', is_nullable: 'YES' },
    ],
    primaryKeys: [
      { table_name: 'students', column_name: 'id' },
      { table_name: 'marks', column_name: 'id' },
    ],
    foreignKeys: [
      { name: 'marks_student_id_fkey', from_table: 'marks', from_column: 'student_id', to_table: 'students', to_column: 'id' },
    ],
    ...overrides,
  };
}

describe('displayType', () => {
  it('compacts the verbose information_schema names', () => {
    expect(displayType('character varying', 'varchar')).toBe('varchar');
    expect(displayType('timestamp with time zone', 'timestamptz')).toBe('timestamptz');
    expect(displayType('integer', 'int4')).toBe('int');
    expect(displayType('boolean', 'bool')).toBe('bool');
  });

  it('reads array types out of the udt_name', () => {
    expect(displayType('ARRAY', '_text')).toBe('text[]');
    expect(displayType('ARRAY', '_uuid')).toBe('uuid[]');
    expect(displayType('ARRAY', '')).toBe('[]');
  });

  it('shows the short name for enums and user-defined types', () => {
    expect(displayType('USER-DEFINED', 'mark_status')).toBe('mark_status');
  });

  it('falls back to whatever it has when the row is malformed', () => {
    expect(displayType(undefined, undefined)).toBe('');
    expect(displayType('jsonb', undefined)).toBe('jsonb');
  });
});

describe('buildSchemaGraph', () => {
  it('builds tables with ordered, flagged columns', () => {
    const graph = buildSchemaGraph(rows());

    expect(graph.tables.map((t) => t.name)).toEqual(['students', 'marks', 'v_summary']);
    expect(graph.tables[0]!.kind).toBe('table');
    expect(graph.tables[2]!.kind).toBe('view');

    expect(graph.tables[0]!.columns).toEqual([
      { name: 'id', type: 'uuid', nullable: false, primary: true },
      { name: 'roll_no', type: 'int', nullable: true, primary: false },
    ]);
  });

  it('keeps the FK edge paired from column to column', () => {
    const graph = buildSchemaGraph(rows());

    expect(graph.foreignKeys).toEqual([
      {
        id: 'marks_student_id_fkey:marks.student_id>students.id',
        from: 'marks',
        fromColumn: 'student_id',
        to: 'students',
        toColumn: 'id',
      },
    ]);
  });

  it('correlates multi-column FK parts by position, and keeps ids unique', () => {
    const graph = buildSchemaGraph(
      rows({
        tables: [
          { name: 'marks', kind: 'r' },
          { name: 'exams', kind: 'r' },
          { name: 'subjects', kind: 'r' },
        ],
        foreignKeys: [
          {
            name: 'mj_mid_fkey',
            from_table: 'marks',
            from_column: 'exam_id',
            to_table: 'exams',
            to_column: 'id',
          },
          {
            name: 'mj_mid_fkey',
            from_table: 'marks',
            from_column: 'subject_id',
            to_table: 'subjects',
            to_column: 'id',
          },
        ],
      }),
    );

    expect(graph.foreignKeys).toHaveLength(2);
    expect(graph.foreignKeys[0]!.fromColumn).toBe('exam_id');
    expect(graph.foreignKeys[0]!.toColumn).toBe('id');
    expect(graph.foreignKeys[1]!.fromColumn).toBe('subject_id');
    expect(graph.foreignKeys[1]!.toColumn).toBe('id');
  });

  it('drops a foreign key whose endpoint is not a known table', () => {
    const graph = buildSchemaGraph(
      rows({
        foreignKeys: [
          { name: 'c', from_table: 'marks', from_column: 'x', to_table: 'ghost', to_column: 'id' },
        ],
      }),
    );

    expect(graph.foreignKeys).toEqual([]);
  });

  it('handles an empty catalog without throwing', () => {
    const graph = buildSchemaGraph({ tables: [], columns: [], primaryKeys: [], foreignKeys: [] });

    expect(graph.tables).toEqual([]);
    expect(graph.foreignKeys).toEqual([]);
  });
});