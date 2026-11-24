// Taking tables off the graph by hand: the Remove button in the details panel and the Delete key on the graph.
import { useGraphStore } from './graphStore'
import type { FlowNode, Selection } from './types'

/** Keys that remove the selected tables from the graph. */
export const REMOVE_KEYS = ['Delete', 'Backspace']

/** The tables a removal would take: those ticked on the graph, or else the one whose details are open. */
export function removalTargets(nodes: FlowNode[], selection: Selection): string[] {
  const ticked = nodes.filter((n) => n.selected).map((n) => n.id)
  if (ticked.length > 0) return ticked
  return selection?.kind === 'node' && nodes.some((n) => n.id === selection.id) ? [selection.id] : []
}

/**
 * Takes tables off the graph, with their edges, and says so in the status line. Ids that are not stored nodes (a
 * concept, a collapsed group, a group's box) are ignored. Nothing is read from or written to Databricks; a neighbor's
 * count, the picker or Add to graph brings a table back.
 */
export function removeFromGraph(ids: string[]): number {
  const s = useGraphStore.getState()
  const stored = new Set(s.nodes.map((n) => n.id))
  const gone = [...new Set(ids)].filter((id) => stored.has(id))
  if (gone.length === 0) return 0
  s.removeNodes(gone)
  s.setStatus(gone.length === 1 ? `removed ${gone[0]} from the graph` : `removed ${gone.length} tables from the graph`)
  return gone.length
}

/** Removes the tables a removal would take now (see removalTargets). */
export function removeSelected(): number {
  const s = useGraphStore.getState()
  return removeFromGraph(removalTargets(s.nodes, s.selection))
}
