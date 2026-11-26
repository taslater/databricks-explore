// Turns the stored graph (nodes, edges, filters) into what React Flow draws.
// Pure: the same inputs always give the same output, so it can be unit tested.
import { MarkerType } from '@xyflow/react'
import type { GraphEdge } from '../api/types'
import { baseType, columnHandles, findColumn, rowsOf } from './columns'
import { EDGE_COLORS } from './format'
import { graphSplits } from './anchors'
import { estimateSize } from './layout'
import { nameLine } from './nodeMarks'
import { familyOf } from './edgeStyles'
import type { EdgeFilters, FlowEdge, FlowNode } from './types'

export interface DeriveInput {
  nodes: FlowNode[]
  edges: FlowEdge[]
  /** Column-to-column edges. Drawn between column handles when both nodes show their columns. */
  columnEdges?: FlowEdge[]
  focusSchema: string | null
  filters: EdgeFilters
  hoverId: string | null
  /** Nodes to leave out whatever the filters say, with the edges that touch them (collapsed groups, elided views: graph/collapse.ts). */
  forceHidden?: ReadonlySet<string>
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
  const lines = [nameLine(n.data)]
  if (showSchema) lines.push(n.data.schema)
  if (via) lines.push(`via ${via}`)
  if (n.data.showColumns && n.data.columns) {
    const shown = rowsOf(n.data)
    lines.push(...shown.map((c) => `  ${c.name}  ${baseType(c.type)}`))
    if (shown.length < n.data.columns.length || n.data.allColumns) lines.push('+0 more')
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

/** The server says the edge no longer holds (a view's source it stopped reading, a table recreated since). Age alone never does. */
export const isSuperseded = (info: GraphEdge): boolean => info.status === 'superseded'

/** Whether the filters let an edge show: its family and its kind are on, and it is neither superseded nor rejected unless those are on too. */
export function edgeShown(info: GraphEdge, filters: EdgeFilters): boolean {
  return (
    (filters[familyOf(info.kind)] ?? false) &&
    (filters[info.kind] ?? false) &&
    !(isSuperseded(info) && !filters.showSuperseded) &&
    !(info.status === 'rejected' && !filters.showRejected)
  )
}

/** Arrowheads: flow edges have one, reference edges have none (their ends are crow's feet, later), meaning edges have one when directed. An undirected edge (directed === false) never does. */
const hasArrow = (info: GraphEdge): boolean => info.directed !== false && familyOf(info.kind) !== 'reference'

export function deriveFlow(input: DeriveInput): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const { filters, focusSchema, hoverId } = input
  const via = viaMap(input.edges)

  // Edge visibility.
  const edgeHidden = new Map<string, boolean>()
  const forced = input.forceHidden
  for (const e of input.edges) edgeHidden.set(e.id, !edgeShown(e.data!.info, filters) || !!forced?.has(e.source) || !!forced?.has(e.target))

  // Node visibility: a node is hidden when it has edges and all of them are hidden. The focus node and pinned nodes always show.
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

  // Columns that have a visible column edge, per node: they show beside the keys. An edge counts when its kind is on and both its nodes list columns.
  const involved = new Map<string, Set<string>>()
  for (const e of input.columnEdges ?? []) {
    const info = e.data!.info
    if (!edgeShown(info, filters) || !nodeById.get(e.source)?.data.showColumns || !nodeById.get(e.target)?.data.showColumns) continue
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
    const hidden = !!forced?.has(n.id) || (!n.data.focus && !n.data.pinned && edges.length > 0 && edges.every((e) => edgeHidden.get(e.id)))
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
    const row = (n: FlowNode, name: string | undefined) => findColumn(rowsOf(n.data), name)
    const from = row(src, info.source_column)
    const to = row(tgt, info.target_column)
    const superseded = isSuperseded(info)
    const filtered = !edgeShown(info, filters)
    const hidden = !from || !to || filtered || !!src.hidden || !!tgt.hidden
    if (!hidden) covered.add([info.kind, ...[e.source, e.target].sort()].join('|'))
    const color = superseded ? EDGE_COLORS.superseded : (EDGE_COLORS[info.kind] ?? 'var(--edge-superseded)')
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
      type: superseded ? 'superseded' : familyOf(info.kind),
      hidden,
      sourceHandle: handles.sourceHandle,
      targetHandle: handles.targetHandle,
      markerEnd: hasArrow(info) ? { type: MarkerType.ArrowClosed, color } : undefined,
      data: { ...e.data!, superseded, faded: hoverId !== null && e.source !== hoverId && e.target !== hoverId },
    })
  }

  const edges: FlowEdge[] = input.edges.map((e) => {
    const info = e.data!.info
    const superseded = isSuperseded(info)
    const color = superseded ? EDGE_COLORS.superseded : (EDGE_COLORS[info.kind] ?? 'var(--edge-superseded)')
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
      type: superseded ? 'superseded' : familyOf(info.kind),
      hidden: edgeHidden.get(e.id) === true || drawnInColumns,
      sourceHandle: handles.sourceHandle,
      targetHandle: handles.targetHandle,
      markerEnd: hasArrow(info) ? { type: MarkerType.ArrowClosed, color } : undefined,
      markerStart: info.bidir && hasArrow(info) ? { type: MarkerType.ArrowClosed, color } : undefined,
      data: {
        ...e.data!,
        superseded,
        faded: hoverId !== null && e.source !== hoverId && e.target !== hoverId,
      },
    }
  })

  // A side with edges both in and out anchors them apart. Hidden edges do not count.
  const all = [...edges, ...columnEdges]
  const splits = graphSplits(all)
  return { nodes: nodes.map((n) => (splits.has(n.id) ? { ...n, data: { ...n.data, anchorSplit: splits.get(n.id) } } : n)), edges: all }
}
