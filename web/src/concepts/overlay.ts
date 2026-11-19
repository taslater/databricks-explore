// The Concepts overlay on the graph: for the tables on screen, their linked concepts and an edge from each to its table
// (or to the column's handle when that column is showing). Pure, so it can be unit tested. Nothing here is stored.
import { MarkerType, Position } from '@xyflow/react'
import type { ConceptsForTables } from '../api/concepts'
import { columnHandleId, findColumn, visibleColumns } from '../graph/columns'
import { EDGE_COLORS } from '../graph/format'
import type { ConceptFlowNode, FlowEdge, FlowNode } from '../graph/types'

export const CONCEPT_W = 170
export const CONCEPT_H = 46
const GAP_X = 12
const GAP_Y = 36
const HANDLE = 6

/**
 * Handles are declared and the size given up front. These nodes are rebuilt on every render and their resize changes are
 * not kept (they are not in the graph store), so React Flow could not otherwise find the handles to draw the edges to.
 */
const HANDLES = [
  { id: 'src-b', type: 'source' as const, position: Position.Bottom, x: CONCEPT_W / 2 - HANDLE / 2, y: CONCEPT_H - HANDLE / 2, width: HANDLE, height: HANDLE },
  { id: 'src-t', type: 'source' as const, position: Position.Top, x: CONCEPT_W / 2 - HANDLE / 2, y: -HANDLE / 2, width: HANDLE, height: HANDLE },
]

export const CONCEPT_EDGE_PREFIX = 'cl:'

/** True for the id of an edge this overlay made. */
export const isConceptEdge = (id: string): boolean => id.startsWith(CONCEPT_EDGE_PREFIX)

/**
 * Concept nodes and edges for the visible tables. A concept appears once, above the first table it links to on the
 * graph (in node order), side by side with any others that share that table. Concepts with no link to a visible table
 * are left out. A link to a column draws to that column's handle when the table shows the column, else to the table.
 */
export function conceptOverlay(
  nodes: readonly FlowNode[],
  data: ConceptsForTables | undefined,
): { nodes: ConceptFlowNode[]; edges: FlowEdge[] } {
  if (!data || data.concepts.length === 0) return { nodes: [], edges: [] }
  const tables = new Map(nodes.filter((n) => !n.hidden).map((n) => [n.id, n]))
  const order = new Map(nodes.map((n, i) => [n.id, i]))
  const concepts = new Map(data.concepts.map((c) => [c.id, c]))

  const byConcept = new Map<string, typeof data.links>()
  for (const link of data.links) {
    const id = link.source.table.replace(/^concept:/, '')
    if (!concepts.has(id) || !tables.has(link.target.table)) continue
    byConcept.set(id, [...(byConcept.get(id) ?? []), link])
  }

  // Anchor each concept at the first visible table it links to, then lay the concepts of one anchor in a row.
  const perAnchor = new Map<string, string[]>()
  for (const [id, links] of byConcept) {
    const anchor = links.map((l) => l.target.table).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))[0]
    perAnchor.set(anchor, [...(perAnchor.get(anchor) ?? []), id])
  }

  const outNodes: ConceptFlowNode[] = []
  const outEdges: FlowEdge[] = []
  for (const [anchor, ids] of perAnchor) {
    const at = tables.get(anchor)!
    ids.sort((a, b) => concepts.get(a)!.name.localeCompare(concepts.get(b)!.name))
    ids.forEach((id, i) => {
      const c = concepts.get(id)!
      const links = byConcept.get(id)!
      outNodes.push({
        id: `concept:${id}`,
        type: 'concept',
        position: { x: at.position.x + i * (CONCEPT_W + GAP_X), y: at.position.y - CONCEPT_H - GAP_Y },
        width: CONCEPT_W,
        height: CONCEPT_H,
        measured: { width: CONCEPT_W, height: CONCEPT_H },
        handles: HANDLES,
        draggable: false,
        data: {
          conceptId: id,
          name: c.name,
          status: c.status,
          domain: c.domain,
          targets: links.map((l) => `${l.relation ?? 'describes'} ${l.target.table.split('.').pop()}${l.target.column ? `.${l.target.column}` : ''}`),
        },
      })
      for (const link of links) {
        const table = tables.get(link.target.table)!
        const column =
          link.target.column && table.data.showColumns && table.data.columns
            ? findColumn(visibleColumns(table.data.columns, table.data.involved ?? [], !!table.data.allColumns), link.target.column)
            : undefined
        outEdges.push({
          id: `${CONCEPT_EDGE_PREFIX}${link.id}`,
          source: `concept:${id}`,
          target: table.id,
          sourceHandle: 'src-b',
          targetHandle: column ? columnHandleId('t', 'l', column.name) : 'tgt-t',
          type: 'meaning',
          selectable: false,
          focusable: false,
          markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLORS.concept_link },
          data: {
            info: {
              id: link.id,
              source: `concept:${id}`,
              target: table.id,
              kind: 'concept_link',
              status: 'accepted',
              label: link.relation ?? undefined,
            },
          },
        })
      }
    })
  }
  return { nodes: outNodes, edges: outEdges }
}
