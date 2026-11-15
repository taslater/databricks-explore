// Turns the stored graph (nodes, edges, filters) into what React Flow draws.
// Pure: the same inputs always give the same output, so it can be unit tested.
import { MarkerType } from '@xyflow/react'
import type { GraphEdge } from '../api/types'
import { columnHandles, findColumn, visibleColumns } from './columns'
import { ageDays, EDGE_COLORS } from './format'
import { estimateSize } from './layout'
import type { EdgeFilters, FlowEdge, FlowNode } from './types'

export interface DeriveInput {
  nodes: FlowNode[]
  edges: FlowEdge[]
  /** Column-to-column edges. Drawn between column handles when both nodes show their columns. */
  columnEdges?: FlowEdge[]
  focusSchema: string | null
  filters: EdgeFilters
  staleDays: number
  hoverId: string | null
  now?: number
}

/** Edge `via` labels: for each FK parent, the child columns of the last fk edge that points at it. */
export function viaMap(edges: FlowEdge[]): Map<string, string> {
  const via = new Map<string, string>()
  for (const e of edges) {
    if (e.data?.info.kind === 'fk') via.set(e.target, (e.data.info.child_columns ?? []).join(', '))
  }
  return via
}

function nodeLines(n: FlowNode, showSchema: boolean, via: string | undefined): string[] {
  const lines = [`${n.data.selfRef ? '↻ ' : ''}${n.data.name}`]
  if (showSchema) lines.push(n.data.schema)
  if (via) lines.push(`via ${via}`)
  if (n.data.showColumns && n.data.columns) {
    const shown = visibleColumns(n.data.columns, n.data.involved ?? [], !!n.data.allColumns)
    lines.push(...shown.map((c) => `${c.name}  ${c.type}`))
  }
  return lines
}

/** Measured size if React Flow has rendered the node, otherwise an estimate. */
export function nodeSize(
  n: FlowNode,
  focusSchema: string | null,
  via: string | undefined,
): { width: number; height: number } {
  if (n.measured?.width && n.measured?.height) return { width: n.measured.width, height: n.measured.height }
  return estimateSize(nodeLines(n, n.data.schema !== focusSchema, via))
}

export function nodeCenter(n: FlowNode, size: { width: number; height: number }) {
  return { x: n.position.x + size.width / 2, y: n.position.y + size.height / 2 }
}

/** Picks the handle pair so the edge runs along the dominant axis. Layout is LR, so most edges use left/right. */
export function handlesFor(
  source: { x: number; y: number },
  target: { x: number; y: number },
  selfLoop: boolean,
): { sourceHandle: string; targetHandle: string } {
  if (selfLoop) return { sourceHandle: 'src-r', targetHandle: 'tgt-r' }
  const dx = target.x - source.x
  const dy = target.y - source.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: 'src-r', targetHandle: 'tgt-l' }
      : { sourceHandle: 'src-l', targetHandle: 'tgt-r' }
  }
  return dy >= 0
    ? { sourceHandle: 'src-b', targetHandle: 'tgt-t' }
    : { sourceHandle: 'src-t', targetHandle: 'tgt-b' }
}

/** Lineage whose last_seen is older than `staleDays`. */
export function isStale(info: GraphEdge, staleDays: number, now: number): boolean {
  return info.kind === 'lineage' && (ageDays(info.last_seen, now) ?? -1) > staleDays
}

/** Whether the filters let an edge show: its kind is on, and it is neither stale nor rejected unless those are on too. */
export function edgeShown(info: GraphEdge, filters: EdgeFilters, staleDays: number, now: number): boolean {
  const stale = isStale(info, staleDays, now)
  return (filters[info.kind] ?? false) && !(stale && !filters.showStale) && !(info.status === 'rejected' && !filters.showRejected)
}

export function deriveFlow(input: DeriveInput): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const now = input.now ?? Date.now()
  const { filters, focusSchema, hoverId } = input
  const via = viaMap(input.edges)

  // Edge visibility and stale flags. Stale means lineage whose last_seen is older than staleDays.
  const edgeHidden = new Map<string, boolean>()
  const edgeStale = new Map<string, boolean>()
  for (const e of input.edges) {
    const info = e.data!.info
    edgeStale.set(e.id, isStale(info, input.staleDays, now))
    edgeHidden.set(e.id, !edgeShown(info, filters, input.staleDays, now))
  }

  // Node visibility: a node is hidden when it has edges and all of them are hidden. The focus node always shows.
  const edgesByNode = new Map<string, FlowEdge[]>()
  for (const e of input.edges) {
    for (const id of new Set([e.source, e.target])) {
      const list = edgesByNode.get(id) ?? []
      list.push(e)
      edgesByNode.set(id, list)
    }
  }

  // Hover: keep the hovered node, its neighbors, and the edges touching it. Everything else fades.
  const neighborhood = new Set<string>()
  if (hoverId) {
    neighborhood.add(hoverId)
    for (const e of edgesByNode.get(hoverId) ?? []) neighborhood.add(e.source === hoverId ? e.target : e.source)
  }

  const nodeById = new Map(input.nodes.map((n) => [n.id, n]))
  const sizeById = new Map<string, { width: number; height: number }>()
  for (const n of input.nodes) sizeById.set(n.id, nodeSize(n, focusSchema, via.get(n.id)))

  // Columns that have a column edge, per node: they always show, even on a wide table.
  const involved = new Map<string, Set<string>>()
  for (const e of input.columnEdges ?? []) {
    const info = e.data!.info
    for (const [id, col] of [
      [e.source, info.source_column],
      [e.target, info.target_column],
    ] as const) {
      if (!col) continue
      const set = involved.get(id) ?? new Set<string>()
      set.add(col)
      involved.set(id, set)
    }
  }

  const nodes: FlowNode[] = input.nodes.map((n) => {
    const edges = edgesByNode.get(n.id) ?? []
    const hidden = !n.data.focus && edges.length > 0 && edges.every((e) => edgeHidden.get(e.id))
    const external = n.data.schema !== focusSchema
    return {
      ...n,
      hidden,
      data: {
        ...n.data,
        showSchema: external,
        external,
        via: via.get(n.id) || undefined,
        faded: hoverId !== null && !neighborhood.has(n.id),
        involved: n.data.showColumns ? [...(involved.get(n.id) ?? [])] : undefined,
      },
    }
  })
  const outNode = new Map(nodes.map((n) => [n.id, n]))

  // Column edges: drawn only when both nodes show a row for their column.
  const columnEdges: FlowEdge[] = []
  const covered = new Set<string>() // kind|a|b of table pairs a visible column edge already draws
  for (const e of input.columnEdges ?? []) {
    const info = e.data!.info
    const src = outNode.get(e.source)
    const tgt = outNode.get(e.target)
    if (!src || !tgt) continue
    const row = (n: FlowNode, name: string | undefined) =>
      n.data.showColumns && n.data.columns
        ? findColumn(visibleColumns(n.data.columns, n.data.involved ?? [], !!n.data.allColumns), name)
        : undefined
    const from = row(src, info.source_column)
    const to = row(tgt, info.target_column)
    const stale = info.kind === 'lineage' && (ageDays(info.last_seen, now) ?? -1) > input.staleDays
    const filtered =
      !(filters[info.kind] ?? false) ||
      (stale && !filters.showStale) ||
      (info.status === 'rejected' && !filters.showRejected)
    const hidden = !from || !to || filtered || !!src.hidden || !!tgt.hidden
    if (!hidden) covered.add([info.kind, ...[e.source, e.target].sort()].join('|'))
    const color = stale ? EDGE_COLORS.stale : (EDGE_COLORS[info.kind] ?? '#999')
    const srcSize = sizeById.get(e.source) ?? { width: 0, height: 0 }
    const tgtSize = sizeById.get(e.target) ?? { width: 0, height: 0 }
    const handles = columnHandles(
      { x: src.position.x, width: srcSize.width },
      { x: tgt.position.x, width: tgtSize.width },
      e.source === e.target,
      from?.name ?? info.source_column ?? '',
      to?.name ?? info.target_column ?? '',
    )
    columnEdges.push({
      ...e,
      type: stale ? 'stale' : info.kind,
      hidden,
      sourceHandle: handles.sourceHandle,
      targetHandle: handles.targetHandle,
      markerEnd: info.directed === false ? undefined : { type: MarkerType.ArrowClosed, color },
      data: { ...e.data!, stale, faded: hoverId !== null && e.source !== hoverId && e.target !== hoverId },
    })
  }

  const edges: FlowEdge[] = input.edges.map((e) => {
    const info = e.data!.info
    const stale = edgeStale.get(e.id) === true
    const color = stale ? EDGE_COLORS.stale : (EDGE_COLORS[info.kind] ?? '#999')
    const src = nodeById.get(e.source)
    const tgt = nodeById.get(e.target)
    const srcSize = sizeById.get(e.source) ?? { width: 0, height: 0 }
    const tgtSize = sizeById.get(e.target) ?? { width: 0, height: 0 }
    const handles =
      src && tgt
        ? handlesFor(nodeCenter(src, srcSize), nodeCenter(tgt, tgtSize), e.source === e.target)
        : { sourceHandle: 'src-r', targetHandle: 'tgt-l' }
    // A table edge gives way to the column edges of the same kind that now draw the same link in more detail.
    const drawnInColumns = covered.has([info.kind, ...[e.source, e.target].sort()].join('|'))
    return {
      ...e,
      type: stale ? 'stale' : info.kind,
      hidden: edgeHidden.get(e.id) === true || drawnInColumns,
      sourceHandle: handles.sourceHandle,
      targetHandle: handles.targetHandle,
      // An undirected edge (directed === false) has no arrowheads.
      markerEnd: info.directed === false ? undefined : { type: MarkerType.ArrowClosed, color },
      markerStart: info.bidir ? { type: MarkerType.ArrowClosed, color } : undefined,
      data: {
        ...e.data!,
        stale,
        faded: hoverId !== null && e.source !== hoverId && e.target !== hoverId,
      },
    }
  })

  return { nodes, edges: [...edges, ...columnEdges] }
}
