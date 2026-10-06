/**
 * Pure mapping from Postgres catalog rows to a schema graph payload.
 *
 * Deliberately free of Deno APIs so `tsc` and vitest can check and pin it like
 * any other source file (see `shared/tsconfig.json`). This is the trust
 * boundary for the visualiser: the browser renders exactly the table/column/FK
 * objects built here, so a malformed catalog row must degrade to *no* edge
 * rather than an edge pointing nowhere.
 */

export type TableKind = 'table' | 'view' | 'matview';

export interface ColumnGraph {
  name: string;
  type: string;
  nullable: boolean;
  primary: boolean;
}

export interface TableGraph {
  name: string;
  kind: TableKind;
  columns: ColumnGraph[];
}

export interface ForeignKeyGraph {
  id: string;
  /** Table holding the foreign key column. */
  from: string;
  fromColumn: string;
  /** Table holding the referenced primary key. */
  to: string;
  toColumn: string;
}

export interface SchemaGraph {
  tables: TableGraph[];
  foreignKeys: ForeignKeyGraph[];
}

/** The raw row set each statement in `index.ts` returns, keyed by purpose. */
export interface CatalogRows {
  tables: Record<string, unknown>[];
  columns: Record<string, unknown>[];
  primaryKeys: Record<string, unknown>[];
  foreignKeys: Record<string, unknown>[];
}

const KIND_BY_RELKIND: Record<string, TableKind> = {
  r: 'table',
  v: 'view',
  m: 'matview',
};

/**
 * Short display form of a column type for a narrow node column.
 *
 * `information_schema.columns.data_type` is verbose ("character varying",
 * "timestamp with time zone"). The visualiser shows a compact form so the type
 * tag fits beside the column name; nothing here affects what the database
 * stores.
 */
export function displayType(dataType: unknown, udtName: unknown): string {
  const raw = typeof dataType === 'string' ? dataType : '';
  const udt = typeof udtName === 'string' ? udtName : '';

  // Postgres reports every array column as data_type 'ARRAY' with the element
  // type encoded in udt_name as `_text` etc.
  if (raw === 'ARRAY') return `${udt.replace(/^_/, '')}[]`;

  switch (raw) {
    case 'character varying':
      return 'varchar';
    case 'character':
      return 'char';
    case 'integer':
      return 'int';
    case 'smallint':
      return 'smallint';
    case 'bigint':
      return 'bigint';
    case 'double precision':
      return 'float8';
    case 'real':
      return 'float4';
    case 'boolean':
      return 'bool';
    case 'timestamp with time zone':
      return 'timestamptz';
    case 'timestamp without time zone':
      return 'timestamp';
    case 'time with time zone':
      return 'timetz';
    case 'time without time zone':
      return 'time';
    case 'numeric':
      return 'numeric';
    case 'money':
      return 'money';
    case 'bytea':
      return 'bytea';
    case 'jsonb':
      return 'jsonb';
    case 'json':
      return 'json';
    case 'text':
      return 'text';
    case 'uuid':
      return 'uuid';
    case 'date':
      return 'date';
    case 'USER-DEFINED':
      // Enums and custom types: the short udt name is the readable form.
      return udt || raw;
    default:
      return raw || udt;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Build the graph the visualiser renders.
 *
 * Columns keep the catalog's ordinal order (statement orders by
 * `ordinal_position`), and multi-column foreign keys produce one edge per
 * (from-column → to-column) pair, correlated by position in the constraint.
 */
export function buildSchemaGraph(rows: CatalogRows): SchemaGraph {
  const pkByTable = new Map<string, Set<string>>();
  for (const row of rows.primaryKeys) {
    const table = str(row.table_name);
    const column = str(row.column_name);
    if (!table || !column) continue;
    const columns = pkByTable.get(table) ?? new Set<string>();
    columns.add(column);
    pkByTable.set(table, columns);
  }

  const byName = new Map<string, TableGraph>();
  for (const row of rows.tables) {
    const name = str(row.name);
    if (!name || byName.has(name)) continue;
    const table: TableGraph = {
      name,
      kind: KIND_BY_RELKIND[str(row.kind)] ?? 'table',
      columns: [],
    };
    byName.set(name, table);
  }

  for (const row of rows.columns) {
    const table = str(row.table_name);
    const column = str(row.column_name);
    if (!table || !column) continue;
    const target = byName.get(table);
    if (!target) continue;
    target.columns.push({
      name: column,
      type: displayType(row.data_type, row.udt_name),
      nullable: str(row.is_nullable).toUpperCase() === 'YES',
      primary: pkByTable.get(table)?.has(column) ?? false,
    });
  }

  const tables = [...byName.values()];

  const seen = new Set<string>();
  const foreignKeys: ForeignKeyGraph[] = [];
  for (const row of rows.foreignKeys) {
    const constraint = str(row.name);
    const from = str(row.from_table);
    const fromColumn = str(row.from_column);
    const to = str(row.to_table);
    const toColumn = str(row.to_column);

    // A malformed row must drop the edge, never fabricate one.
    if (!constraint || !from || !fromColumn || !to || !toColumn) continue;
    if (!byName.has(from) || !byName.has(to)) continue;

    const id = `${constraint}:${from}.${fromColumn}>${to}.${toColumn}`;
    if (seen.has(id)) continue;
    seen.add(id);

    foreignKeys.push({ id, from, fromColumn, to, toColumn });
  }

  return { tables, foreignKeys };
}