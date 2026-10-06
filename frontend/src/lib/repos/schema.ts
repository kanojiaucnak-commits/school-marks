import { edgeFetch } from '../edge';

/**
 * The schema graph, as `schema-graph` serves it.
 *
 * These types mirror `supabase/functions/schema-graph/schemaGraph.ts` exactly —
 * the page renders the payload untouched, so the browser-side type is a
 * contract, not a guess. `schema-graph` is admin-only (`settings:manage`), and
 * a non-admin caller gets a 403 from the function itself, never from this file.
 */

export type TableKind = 'table' | 'view' | 'matview';

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  primary: boolean;
}

export interface SchemaTable {
  name: string;
  kind: TableKind;
  columns: SchemaColumn[];
}

export interface SchemaForeignKey {
  id: string;
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
}

export interface SchemaGraph {
  tables: SchemaTable[];
  foreignKeys: SchemaForeignKey[];
}

/** Fetch the live database shape. No caching: it must mirror what is deployed. */
export async function listSchemaGraph(): Promise<SchemaGraph> {
  return edgeFetch<SchemaGraph>('schema-graph', { method: 'GET' });
}