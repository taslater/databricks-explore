// What the layout reads from the Graph's state: node sizes, the column rows each node draws, and the visible edges. Pure.
import { rowsOf } from './columns'
import { deriveFlow, nodeSize, viaMap } from './derive'
import type { LayoutEdge, LayoutNode } from './layout'
import type { EdgeFilters, FlowEdge, FlowNode } from './types'

export interface LayoutState {
  nodes: FlowNode[]
  edges: FlowEdge[]
  columnEdges: FlowEdge[]
  focusSchema: string | null
  filters: EdgeFilters
}

/**
 * The nodes and links to lay out. Column rows come from what the Graph draws (the keys and the columns a visible column edge
 * ends at), so a flow edge between two rows is a port to the layout. `placed` holds the nodes an earlier layout positioned.
 */
export function layoutInput(s: LayoutState, placed: ReadonlySet<string>): { nodes: LayoutNode[]; links: LayoutEdge[] } {
  const via = viaMap(s.edges)
  const drawn = deriveFlow({ nodes: s.nodes, edges: s.edges, columnEdges: s.columnEdges, focusSchema: s.focusSchema, filters: s.filters, hoverId: null })
  const drawnById = new Map(drawn.nodes.map((n) => [n.id, n]))
  const nodes = s.nodes.map((n) => {
    const size = nodeSize(n, s.focusSchema, via.get(n.id))
    const data = drawnById.get(n.id)?.data ?? n.data
    const rows = rowsOf(data)
    return {
      id: n.id,
      width: size.width,
      height: size.height,
      focus: n.data.focus || !!n.data.pinned,
      x: n.position.x,
      y: n.position.y,
      ...(rows.length > 0 && { rows: rows.map((r) => r.name), moreRow: !!data.allColumns || rows.length < (data.columns?.length ?? 0) }),
      ...(placed.has(n.id) && { placed: true }),
    }
  })
  const columnIds = new Set(s.columnEdges.map((e) => e.id))
  const links = drawn.edges.flatMap((e): LayoutEdge[] => {
    const info = e.data!.info
    if (columnIds.has(e.id)) {
      // A column edge counts when both its rows are drawn (deriveFlow hides it otherwise).
      return e.hidden ? [] : [{ source: e.source, target: e.target, kind: info.kind, sourceColumn: info.source_column, targetColumn: info.target_column }]
    }
    return [{ source: e.source, target: e.target, kind: info.kind }]
  })
  return { nodes, links }
}
