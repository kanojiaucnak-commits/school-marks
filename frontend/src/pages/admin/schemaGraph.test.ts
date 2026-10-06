import { describe, expect, it } from 'vitest';
import { layoutGraph, neighborTableIds, tableHeight, TABLE_WIDTH } from './schemaGraph';
import type { SchemaGraph, SchemaTable } from '../../lib/repos/schema';

function table(name: string, columns: number, kind: SchemaTable['kind'] = 'table'): SchemaTable {
  return {
    name,
    kind,
    columns: Array.from({ length: columns }, (_, i) => ({
      name: `c${i}`,
      type: 'uuid',
      nullable: false,
      primary: i === 0,
    })),
  };
}

const schema: SchemaGraph = {
  tables: [
    table('students', 3),
    table('marks', 4),
    table('academic_years', 2),
    table('subjects', 2),
    // Self-referencing FK: must not hang the layout.
    table('profiles', 2),
  ],
  foreignKeys: [
    { id: 'a', from: 'marks', fromColumn: 'student_id', to: 'students', toColumn: 'id' },
    { id: 'b', from: 'marks', fromColumn: 'academic_year_id', to: 'academic_years', toColumn: 'id' },
    { id: 'c', from: 'marks', fromColumn: 'subject_id', to: 'subjects', toColumn: 'id' },
    { id: 'd', from: 'profiles', fromColumn: 'manager_id', to: 'profiles', toColumn: 'id' },
  ],
};

describe('tableHeight', () => {
  it('scales with the column count and collapses to a title bar', () => {
    const wide = table('wide', 10);
    expect(tableHeight(wide, false)).toBeGreaterThan(tableHeight(table('narrow', 2), false));
    expect(tableHeight(wide, true)).toBe(tableHeight(table('narrow', 2), true));
    expect(tableHeight(table('one', 0), false)).toBe(tableHeight(table('one', 0), true));
  });
});

describe('layoutGraph', () => {
  it('places referencing tables in deeper columns than the tables they reference', () => {
    const positions = layoutGraph(schema, new Set());

    expect(positions.marks!.x).toBe(positions.students!.x + TABLE_WIDTH + 90);
    expect(positions.students!.x).toBe(0);
    // academic_years and subjects are also layer 0, stacked top-to-bottom by name.
    expect(positions.academic_years!.x).toBe(0);
    expect(positions.subjects!.x).toBe(0);
  });

  it('stacks tables in the same layer without overlapping', () => {
    const positions = layoutGraph(schema, new Set());
    expect(positions.students!.y).toBeGreaterThan(positions.academic_years!.y + 1);
  });

  it('survives a self-referencing foreign key (a cycle)', () => {
    // The cycle means no infinite recursion; all five tables still get a position.
    const positions = layoutGraph(schema, new Set());
    expect(Object.keys(positions)).toHaveLength(5);
    expect(positions.profiles!.x).toBeGreaterThanOrEqual(0);
  });

  it('re-lays out vertically when a table collapses', () => {
    const expanded = layoutGraph(schema, new Set());
    const collapsed = layoutGraph(schema, new Set(['students']));
    expect(collapsed.profiles).toEqual(expanded.profiles);
    // Collapsing a layer-0 table shortens the column, moving the table below it up.
    expect(collapsed.subjects!.y).toBeLessThan(expanded.subjects!.y);
    // A table in an untouched column keeps its position.
    expect(collapsed.marks).toEqual(expanded.marks);
  });
});

describe('neighborTableIds', () => {
  it('returns the immediate FK neighbours in either direction', () => {
    expect(neighborTableIds(schema, 'marks').sort()).toEqual([
      'academic_years',
      'students',
      'subjects',
    ]);
    expect(neighborTableIds(schema, 'students')).toEqual(['marks']);
    expect(neighborTableIds(schema, 'profiles')).toEqual(['profiles']);
  });
});