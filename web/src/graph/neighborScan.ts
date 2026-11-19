// Reads the flow neighbors of the tables on the Graph and draws how many of them are not on it (counts at a node's sides).
import { useEffect, useMemo } from 'react'
import { useGraphActions } from './actions'
import { useGraphStore } from './graphStore'
import { countMore, SCAN_LIMIT, type NeighborSet } from './neighbors'
import type { EdgeFilters, FlowNode } from './types'
import { useUiStore } from '../store/uiStore'

/** The nodes with `data.more` set where a table has neighbors not on the Graph. Drawn, never saved. */
export function withNeighborCounts<N extends FlowNode>(
  nodes: N[],
  neighbors: Record<string, NeighborSet>,
  filters: EdgeFilters,
): N[] {
  const onGraph = new Set(nodes.map((n) => n.id))
  return nodes.map((n) => {
    const set = neighbors[n.id]
    if (!set) return n
    const more = countMore(set, onGraph, filters)
    return more.up + more.down > 0 ? { ...n, data: { ...n.data, more } } : n
  })
}

/** Tables to read neighbors for: real tables not read yet, at most SCAN_LIMIT per pass. */
export function unscanned(nodes: ReadonlyArray<Pick<FlowNode, 'id' | 'data'>>, known: Record<string, NeighborSet>): string[] {
  return nodes
    .filter((n) => !n.id.startsWith('ph:') && !n.data.missing && !(n.id in known))
    .map((n) => n.id)
    .slice(0, SCAN_LIMIT)
}

/** Reads, one table after another, the neighbors of every table on the Graph that has none read yet. A failure is skipped, not retried. */
export function useNeighborScan(nodes: FlowNode[]) {
  const actions = useGraphActions()
  const connected = useUiStore((s) => s.connectedProfile)
  const known = useGraphStore((s) => s.neighbors)
  const todo = useMemo(() => unscanned(nodes, known), [nodes, known])
  const key = todo.join('|')
  useEffect(() => {
    if (!connected || todo.length === 0) return
    let stop = false
    void (async () => {
      for (const id of todo) {
        if (stop) return
        try {
          if (!stop) await actions.readNeighbors(id)
        } catch {
          // Counts are a hint: a table that cannot be read just shows none.
          if (!stop) useGraphStore.getState().setNeighbors(id, { up: [], down: [] })
        }
      }
    })()
    return () => {
      stop = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connected, actions])
}
