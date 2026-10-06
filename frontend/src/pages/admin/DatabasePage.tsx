import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { listSchemaGraph, type SchemaGraph, type SchemaTable } from '../../lib/repos/schema';
import { QueryError } from '../../lib/query';
import { Button } from '../../components/ui/Button';
import { Alert, EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { IconDatabase } from '../../components/ui/icons';
import {
  layoutGraph,
  neighborTableIds,
  TABLE_WIDTH,
} from './schemaGraph';

/**
 * Database visualiser.
 *
 * A read-only map of the live `public` schema, drawn as an interactive graph:
 * tables are nodes, and each foreign-key column carries a handle that its edge
 * starts from, running to the primary-key column it references. Pan, zoom, drag,
 * collapse a table to its title, or pick a table to dim everything outside its
 * immediate neighbourhood.
 *
 * Deliberately view-only. Postgres RLS, the audit triggers and the
 * trigger-derived grades all live in this database — the schema is the security
 * boundary, so nothing on this page can write, and schema changes stay in
 * `supabase/migrations/`. Admin-only: the `settings:manage` permission the
 * function checks is the same one the Settings page uses.
 */

type TableData = {
  table: SchemaTable;
  collapsed: boolean;
  /** Columns this table is the source of (holds the FK column). */
  outgoing: ReadonlySet<string>;
  /** Columns this table is the target of (the referenced PK column). */
  incoming: ReadonlySet<string>;
  dimmed: boolean;
  onToggle: (name: string) => void;
};

type TableNode = Node<TableData>;

const NO_COLS: ReadonlySet<string> = new Set();

const NODE_TYPES = { table: SchemaTableNode };

const NODE_COLORS: Record<SchemaTable['kind'], string> = {
  table: '#344e59', // brand-700
  view: '#5d7772', // sage-500
  matview: '#3a82bb', // info base
};

export default function DatabasePage() {
  const { data: schema, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['schema-graph'],
    queryFn: listSchemaGraph,
    staleTime: 60_000,
  });

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-4">
        <h1 className="page-title">
          The live database, drawn as a graph — tables, columns and the foreign keys that join them.
        </h1>
      </header>

      <Alert tone="info" title="Read-only, admin-only">
        This page cannot change anything — the schema is the security boundary. Schema changes belong
        in <code className="rounded bg-surface-muted px-1 py-0.5 font-mono text-[0.8em]">supabase/migrations/</code>.
        Click a table to highlight its neighbours; drag, pan and zoom freely.
      </Alert>

      {isLoading && <LoadingState label="Reading the live schema…" />}

      {error instanceof QueryError && (
        <ErrorState message={error.userMessage} onRetry={() => void refetch()} />
      )}

      {!isLoading && !error && schema && schema.tables.length === 0 && (
        <EmptyState
          title="No tables in the public schema"
          icon={<IconDatabase size={18} />}
          description="The function read an empty catalog, which should not happen for a deployed database."
        />
      )}

      {schema && schema.tables.length > 0 && (
        <SchemaCanvas schema={schema} refreshing={isFetching} onRefresh={() => void refetch()} />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Canvas                                                                      */
/* -------------------------------------------------------------------------- */

function SchemaCanvas({
  schema,
  refreshing,
  onRefresh,
}: {
  schema: SchemaGraph;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="h-[calc(100vh-15rem)] min-h-[460px] overflow-hidden rounded-xl border border-line bg-canvas">
      <ReactFlowProvider>
        <CanvasInner schema={schema} refreshing={refreshing} onRefresh={onRefresh} />
      </ReactFlowProvider>
    </div>
  );
}

function CanvasInner({
  schema,
  refreshing,
  onRefresh,
}: {
  schema: SchemaGraph;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { fitView } = useReactFlow();

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [layoutTick, setLayoutTick] = useState(0);

  const toggleCollapsed = useCallback((name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const focusNeighbours = useMemo(
    () => (focus ? new Set(neighborTableIds(schema, focus)) : null),
    [schema, focus],
  );

  /** All table names, and the visible subset when focus mode is on. */
  const allNames = useMemo(() => new Set(schema.tables.map((t) => t.name)), [schema]);
  const visible = useMemo(() => {
    if (!focusMode || !focus || !focusNeighbours) return allNames;
    return new Set<string>([focus, ...focusNeighbours]);
  }, [focusMode, focus, focusNeighbours, allNames]);

  /** Which columns carry an outgoing (source) / incoming (target) handle. */
  const { sourceCols, targetCols } = useMemo(() => {
    const source = new Map<string, Set<string>>();
    const target = new Map<string, Set<string>>();
    for (const fk of schema.foreignKeys) {
      let s = source.get(fk.from);
      if (!s) {
        s = new Set();
        source.set(fk.from, s);
      }
      s.add(fk.fromColumn);
      let t = target.get(fk.to);
      if (!t) {
        t = new Set();
        target.set(fk.to, t);
      }
      t.add(fk.toColumn);
    }
    return { sourceCols: source, targetCols: target };
  }, [schema]);

  const positions = useMemo(
    () => layoutGraph(schema, collapsed),
    // Keyed on `layoutTick` on purpose: "Reset layout" bumps it to re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schema, collapsed, layoutTick],
  );

  const nextNodes = useMemo<TableNode[]>(() => {
    const dimSet =
      focus && !focusMode && focusNeighbours
        ? new Set([focus, ...focusNeighbours])
        : null;
    return schema.tables
      .filter((table) => visible.has(table.name))
      .map((table) => ({
        id: table.name,
        type: 'table' as const,
        position: positions[table.name] ?? { x: 0, y: 0 },
        data: {
          table,
          collapsed: collapsed.has(table.name),
          outgoing: sourceCols.get(table.name) ?? NO_COLS,
          incoming: targetCols.get(table.name) ?? NO_COLS,
          dimmed: Boolean(dimSet && !dimSet.has(table.name)),
          onToggle: toggleCollapsed,
        },
      }));
  }, [
    schema,
    visible,
    positions,
    collapsed,
    sourceCols,
    targetCols,
    focus,
    focusMode,
    focusNeighbours,
    toggleCollapsed,
  ]);

  const nextEdges = useMemo<Edge[]>(() => {
    return schema.foreignKeys
      .filter((fk) => visible.has(fk.from) && visible.has(fk.to))
      .map((fk) => {
        const related = Boolean(focus && (fk.from === focus || fk.to === focus));
        const stroke = related ? '#c57718' : '#43616f'; // warning base / brand-600
        return {
          id: fk.id,
          source: fk.from,
          sourceHandle: fk.fromColumn,
          target: fk.to,
          targetHandle: fk.toColumn,
          markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13, color: stroke },
          style: {
            stroke,
            strokeWidth: related ? 2.2 : 1.4,
            opacity: focus && !related ? 0.22 : 1,
          },
        };
      });
  }, [schema, visible, focus]);

  const [nodes, setNodes, onNodesChange] = useNodesState<TableNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    setNodes(nextNodes);
    setEdges(nextEdges);
  }, [nextNodes, nextEdges, setNodes, setEdges]);

  const resetLayout = useCallback(() => {
    setLayoutTick((tick) => tick + 1);
    requestAnimationFrame(() => {
      void fitView({ padding: 0.15, duration: 300 });
    });
  }, [fitView]);

  const setAllCollapsed = useCallback(
    (collapse: boolean) => {
      setCollapsed(collapse ? new Set(schema.tables.map((t) => t.name)) : new Set());
    },
    [schema],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={NODE_TYPES}
      fitView
      fitViewOptions={{ padding: 0.15 }}
      nodesConnectable={false}
      deleteKeyCode={null}
      minZoom={0.12}
      maxZoom={1.8}
      proOptions={{ hideAttribution: false }}
      onNodeClick={(_event, node) => setFocus(String(node.id))}
      onSelectionChange={({ nodes: selected }) =>
        setFocus(selected.length ? String(selected[0]!.id) : null)
      }
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#cbbfab" />

      <Panel position="top-left" className="!m-0 max-w-[calc(100%-2rem)] p-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={resetLayout}>
            Reset layout
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void fitView({ padding: 0.15, duration: 300 })}>
            Fit view
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAllCollapsed(true)}>
            Collapse all
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAllCollapsed(false)}>
            Expand all
          </Button>
          <Button
            size="sm"
            variant={focusMode ? 'primary' : 'ghost'}
            onClick={() => setFocusMode((mode) => !mode)}
            title="When on, selecting a table shows only it and its neighbours"
          >
            Focus {focusMode ? 'on' : 'off'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </Panel>

      <LegendPanel />

      <Controls position="bottom-right" showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        position="bottom-right"
        className="!bottom-14 !right-0"
        maskColor="rgba(250, 248, 244, 0.72)"
        nodeColor={(node) => NODE_COLORS[(node.data as TableData).table.kind] ?? '#9a8f79'}
      />
    </ReactFlow>
  );
}

function LegendPanel() {
  return (
    <Panel position="bottom-left" className="!m-0 p-2">
      <div className="rounded-lg border border-line bg-surface/95 p-3 text-xs leading-relaxed text-ink-muted shadow-card">
        <p className="eyebrow">Legend</p>
        <ul className="mt-1 space-y-1">
          <li className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-[3px] bg-brand-700" aria-hidden="true" />
            table
          </li>
          <li className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-[3px] bg-sage-500" aria-hidden="true" />
            view (read-only)
          </li>
          <li className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-[3px] bg-info" aria-hidden="true" />
            materialized view
          </li>
          <li>
            <span className="rounded-sm bg-warning-soft px-1 font-bold text-warning-strong">PK</span> primary
            key
          </li>
          <li className="flex items-center gap-1.5">
            <span className="font-mono text-brand-600">━━▶</span> foreign key → primary key
          </li>
        </ul>
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Table node                                                                  */
/* -------------------------------------------------------------------------- */

function SchemaTableNode({ data }: NodeProps<TableNode>) {
  const { table, collapsed, outgoing, incoming, dimmed } = data;

  return (
    <div
      className="rounded-lg border border-line bg-surface shadow-card transition-opacity"
      style={{
        width: TABLE_WIDTH,
        opacity: dimmed ? 0.3 : 1,
      }}
    >
      <div
        className={`flex items-center justify-between gap-2 rounded-t-lg px-2.5 py-2 text-white ${
          table.kind === 'table'
            ? 'bg-brand-700'
            : table.kind === 'view'
              ? 'bg-sage-600'
              : 'bg-info'
        }`}
      >
        <span className="truncate font-display text-xs font-bold tracking-[-0.01em]">
          {table.name}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <span className="rounded-sm bg-white/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide">
            {table.kind === 'matview' ? 'matview' : table.kind}
          </span>
          <button
            type="button"
            onClick={() => data.onToggle(table.name)}
            aria-label={collapsed ? `Expand ${table.name}` : `Collapse ${table.name}`}
            className="rounded-sm px-1 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
          >
            {collapsed ? '+' : '−'}
          </button>
        </span>
      </div>

      {!collapsed && table.columns.length > 0 && (
        <ul>
          {table.columns.map((column) => {
            const isSource = outgoing.has(column.name);
            const isTarget = incoming.has(column.name);
            return (
              <li
                key={column.name}
                className="relative flex items-center justify-between gap-2 border-t border-line-soft px-2 py-[2px]"
              >
                {isTarget && (
                  <Handle
                    type="target"
                    position={Position.Left}
                    id={column.name}
                    className="h-1.5 w-1.5 !border-0 !bg-brand-500"
                  />
                )}
                <span className="flex min-w-0 items-center gap-1.5">
                  {column.primary && (
                    <span className="shrink-0 rounded-[3px] bg-warning-soft px-1 text-[9px] font-bold uppercase leading-4 text-warning-strong">
                      PK
                    </span>
                  )}
                  <span className="truncate font-mono text-[11px] leading-5 text-ink">
                    {column.name}
                  </span>
                </span>
                <span className="shrink-0 pl-1 font-mono text-[10px] tabular leading-5 text-ink-faint">
                  {column.type}
                  {column.nullable ? '?' : ''}
                </span>
                {isSource && (
                  <Handle
                    type="source"
                    position={Position.Right}
                    id={column.name}
                    className="h-1.5 w-1.5 !border-0 !bg-brand-600"
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}