// Drawing a column trace: the graph's nodes and column edges with the path added, the rest faded, and the trace as lines of text. Pure.
import type { ColumnTrace, TraceHop } from '../api/columnTrace'
import type { GraphEdge } from '../api/types'
import type { ColumnInfo } from './columns'
import type { FlowEdge, FlowNode } from './types'

/** A trace and what is needed to draw it. */
export interface ActiveTrace {
  data: ColumnTrace
  columns: Record<string, ColumnInfo[]>
}

const lower = (s: string) => s.toLowerCase()

/** The traced columns of each table on the path, lowercase, by lowercase table. */
export function tracedColumns(data: ColumnTrace): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const n of data.nodes) {
    const set = out.get(lower(n.table)) ?? new Set<string>()
    set.add(lower(n.column))
    out.set(lower(n.table), set)
  }
  return out
}

/** The nodes on the path list their columns (the traced ones show on top of their level). Others are untouched. */
export function traceNodes(nodes: FlowNode[], trace: ActiveTrace | null): FlowNode[] {
  if (!trace) return nodes
  const cols = tracedColumns(trace.data)
  return nodes.map((n) => {
    const traced = cols.get(lower(n.id))
    if (!traced) return n
    const columns = n.data.columns ?? trace.columns[n.id]
    return {
      ...n,
      data: {
        ...n.data,
        ...(columns ? { columns, showColumns: true } : null),
        traced: [...traced],
        ...(lower(n.id) === lower(trace.data.table) ? { traceStart: lower(trace.data.column) } : null),
      },
    }
  })
}

const hopKey = (s: string, sc: string, t: string, tc: string) => [s, sc, t, tc].map(lower).join('|')

/** A column lineage hop as the graph edge it draws. */
export function hopEdge(hop: TraceHop, ids: ReadonlyMap<string, string>): FlowEdge | null {
  const source = ids.get(lower(hop.source.table))
  const target = ids.get(lower(hop.target.table))
  if (!source || !target) return null
  const info: GraphEdge = {
    id: hop.id,
    source,
    target,
    kind: 'lineage',
    directed: true,
    status: 'derived',
    last_seen: hop.last_seen ?? undefined,
    source_column: hop.source.column,
    target_column: hop.target.column,
  }
  return { id: hop.id, source, target, data: { info, trace: hop } }
}

/** The column edges with the path's hops as edges: a hop replaces the same pair of columns already there. */
export function traceColumnEdges(edges: FlowEdge[], nodes: ReadonlyArray<{ id: string }>, trace: ActiveTrace | null): FlowEdge[] {
  if (!trace) return edges
  const ids = new Map(nodes.map((n) => [lower(n.id), n.id]))
  const mine = trace.data.hops.flatMap((h) => hopEdge(h, ids) ?? [])
  const keys = new Set(trace.data.hops.map((h) => hopKey(h.source.table, h.source.column, h.target.table, h.target.column)))
  const kept = edges.filter((e) => {
    const i = e.data!.info
    return !(i.source_column && i.target_column && keys.has(hopKey(e.source, i.source_column, e.target, i.target_column)))
  })
  return [...kept, ...mine]
}

/** Everything off the path fades, as it does on hover: tables that are not on it and edges that are not its hops. */
export function traceFade(flow: { nodes: FlowNode[]; edges: FlowEdge[] }, trace: ActiveTrace | null): { nodes: FlowNode[]; edges: FlowEdge[] } {
  if (!trace) return flow
  const on = new Set(trace.data.tables.map(lower))
  return {
    nodes: flow.nodes.map((n) => (on.has(lower(n.id)) ? n : { ...n, data: { ...n.data, faded: true } })),
    edges: flow.edges.map((e) => (e.data?.trace ? { ...e, data: { ...e.data, faded: false } } : { ...e, data: { ...e.data!, faded: true } })),
  }
}

/** The graph without what a trace added, its other tables where they stood before. */
export function withoutTrace<S extends { nodes: FlowNode[]; edges: FlowEdge[]; columnEdges: FlowEdge[]; selection: { kind: string; id: string } | null }>(
  s: S,
  added: readonly string[],
  positions: Record<string, { x: number; y: number }>,
): Pick<S, 'nodes' | 'edges' | 'columnEdges' | 'selection'> {
  const gone = new Set(added)
  const touches = (e: FlowEdge) => gone.has(e.source) || gone.has(e.target)
  return {
    nodes: s.nodes.filter((n) => !gone.has(n.id)).map((n) => (positions[n.id] ? { ...n, position: positions[n.id] } : n)),
    edges: s.edges.filter((e) => !touches(e)),
    columnEdges: s.columnEdges.filter((e) => !touches(e)),
    selection: s.selection?.kind === 'node' && gone.has(s.selection.id) ? null : s.selection,
  }
}

const short = (table: string) => table.split('.').slice(1).join('.')

/** One hop of the trace as text: `bronze.orders.amount → Σ sum → gold.daily.revenue`. A hop with no class says so. */
export interface HopLine {
  id: string
  from: string
  to: string
  label: string | null
  expr: string | null
  note: string | null
  side: 'up' | 'down'
}

/** The trace as a list, upstream first: the furthest source at the top, then each hop towards the traced column, then what is built from it. */
export function hopLines(data: ColumnTrace): HopLine[] {
  const text = (e: { table: string; column: string }) => `${short(e.table)}.${e.column}`
  const ordered = [...data.hops].sort((a, b) => {
    if (a.side !== b.side) return a.side === 'up' ? -1 : 1
    const by = a.side === 'up' ? b.hop - a.hop : a.hop - b.hop
    return by || text(a.source).localeCompare(text(b.source)) || text(a.target).localeCompare(text(b.target))
  })
  return ordered.map((h) => ({ id: h.id, from: text(h.source), to: text(h.target), label: h.label, expr: h.expr, note: h.note, side: h.side }))
}

/** Why a hop has no class, in words. */
export const NOTE_WORDS: Record<string, string> = {
  unread: "the statement that wrote it was not read",
  no_sql: 'written with no SQL statement',
  redacted: 'the statement text is hidden',
  metric_view: "a metric view's definition is YAML",
  unreadable: 'the table could not be read',
  unparsed: 'the SQL could not be read',
  not_select: 'the SQL does not make this column',
}
