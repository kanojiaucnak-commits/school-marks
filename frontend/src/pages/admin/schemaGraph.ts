import type { SchemaGraph, SchemaTable } from '../../lib/repos/schema';

/**
 * Pure layout + neighbourhood helpers for the database visualiser.
 *
 * Kept free of React so the deterministic behaviour (layering, dimensions,
 * "related to" sets) is unit-testable. Everything here is cosmetic: the graph
 * is read-only, so a wrong line or a wrong position can never corrupt data.
 */

export const TABLE_WIDTH = 264;
const HEADER_HEIGHT = 38;
const ROW_HEIGHT = 23;
const V_PAD = 8;
const COLUMN_GAP = 90;
/** Vertical gap between successive rows in the same layer. */
const LAYER_GAP = 18;

/** The rendered height of one table node — what the layout needs to avoid overlap. */
export function tableHeight(table: SchemaTable, collapsed: boolean): number {
  if (collapsed) return HEADER_HEIGHT + V_PAD * 2;
  return HEADER_HEIGHT + V_PAD * 2 + table.columns.length * ROW_HEIGHT;
}

export interface NodePosition {
  x: number;
  y: number;
}

/**
 * Longest-path layered layout, Dagre-style but dependency-free.
 *
 * Each table is placed in a column (layer) equal to the longest chain of
 * foreign keys that ends at it, so referencing tables sit to the right of the
 * tables they reference: `students` is left of `marks`, which is left of
 * `mark_submissions`. Within a layer, tables stack top to bottom by name.
 *
 * Cycles (self-referencing FKs like `profiles.manager_id`) are handled by
 * treating the in-progress node as layer 0, so a cycle cannot recurse forever.
 */
export function layoutGraph(
  schema: SchemaGraph,
  collapsed: Set<string>,
): Record<string, NodePosition> {
  const references = new Map<string, string[]>();
  for (const name of schema.tables.map((t) => t.name)) references.set(name, []);
  for (const fk of schema.foreignKeys) {
    const refs = references.get(fk.from);
    if (refs && refs.indexOf(fk.to) === -1) refs.push(fk.to);
  }

  const heightByTable = new Map(schema.tables.map((t) => [t.name, tableHeight(t, collapsed.has(t.name))]));
  const layer = new Map<string, number>();
  const inProgress = new Set<string>();

  function depthOf(name: string): number {
    const known = layer.get(name);
    if (known !== undefined) return known;
    if (inProgress.has(name)) return 0; // cycle — count it at the earliest layer
    inProgress.add(name);
    let depth = 0;
    for (const parent of references.get(name) ?? []) {
      depth = Math.max(depth, depthOf(parent) + 1);
    }
    inProgress.delete(name);
    layer.set(name, depth);
    return depth;
  }

  for (const table of schema.tables) depthOf(table.name);

  const byLayer = new Map<number, string[]>();
  for (const table of schema.tables) {
    const names = byLayer.get(layer.get(table.name) ?? 0) ?? [];
    names.push(table.name);
    byLayer.set(layer.get(table.name) ?? 0, names);
  }
  for (const names of byLayer.values()) names.sort();

  const positions: Record<string, NodePosition> = {};
  for (const [layerIndex, names] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    let y = 0;
    for (const name of names) {
      positions[name] = { x: layerIndex * (TABLE_WIDTH + COLUMN_GAP), y };
      y += (heightByTable.get(name) ?? 0) + LAYER_GAP;
    }
  }

  return positions;
}

/**
 * Every table connected to `name` by a foreign key, in either direction —
 * the "related to" set used to dim the rest of the graph.
 */
export function neighborTableIds(schema: SchemaGraph, name: string): string[] {
  const seen = new Set<string>();
  for (const fk of schema.foreignKeys) {
    if (fk.from === name) seen.add(fk.to);
    if (fk.to === name) seen.add(fk.from);
  }
  return [...seen];
}