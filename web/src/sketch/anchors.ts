// Connectors that meet a node side both ways draw at two points on it (see shared/anchors.ts). The saved
// connector keeps its side (t, r, b or l); only the handle React Flow draws it to changes, to `<side>-in` or `<side>-out`.
import type { Edge } from '@xyflow/react'
import { isSide } from './model'
import { splitSides, type AnchorEnd, type AnchorRole } from '../shared/anchors'

/** An arrowhead marks the end an edge flows into; the other end of an edge with one arrow flows out. An edge with no arrowhead has no direction and is left alone. */
function roles(e: Pick<Edge, 'markerStart' | 'markerEnd'>): [AnchorRole, AnchorRole] | null {
  const start = !!e.markerStart
  const end = !!e.markerEnd
  if (!start && !end) return null
  return [start ? 'in' : 'out', end ? 'in' : 'out']
}

/** The edges with each end moved to its in or out anchor where its node side carries both. */
export function anchorEdges<E extends Edge>(edges: readonly E[]): E[] {
  const ends: AnchorEnd[] = []
  for (const e of edges) {
    const r = roles(e)
    if (!r) continue
    if (isSide(e.sourceHandle)) ends.push({ node: e.source, key: e.sourceHandle, role: r[0] })
    if (isSide(e.targetHandle)) ends.push({ node: e.target, key: e.targetHandle, role: r[1] })
  }
  const split = splitSides(ends)
  if (split.size === 0) return [...edges]
  const at = (node: string, handle: string | null | undefined, role: AnchorRole) =>
    isSide(handle) && split.get(node)?.includes(handle) ? `${handle}-${role}` : handle
  return edges.map((e) => {
    const r = roles(e)
    if (!r) return e
    const sourceHandle = at(e.source, e.sourceHandle, r[0])
    const targetHandle = at(e.target, e.targetHandle, r[1])
    return sourceHandle === e.sourceHandle && targetHandle === e.targetHandle ? e : { ...e, sourceHandle, targetHandle }
  })
}
