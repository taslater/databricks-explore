// Neighbors a node has that are not on the Graph yet, and expanding or collapsing them one direction at a time. Pure.
// "Neighbors" here are the flow neighbors: lineage and view dependencies, upstream (data comes from them) and downstream.
import type { GraphEdge, GraphNode, RelationsResponse } from '../api/types'
import { edgeShown } from './derive'
import type { EdgeFilters } from './types'

export type Direction = 'up' | 'down'

export interface Neighbor {
  id: string
  edge: GraphEdge
}

/** A table's flow neighbors by side, as its /api/relationships response names them. */
export interface NeighborSet {
  up: Neighbor[]
  down: Neighbor[]
}

/** The most tables one "follow to the end" adds, as many as lineage.walk reaches. */
export const CHAIN_CAP = 60

/** The most tables the page reads neighbors for in one pass, so opening a big graph stays quick. */
export const SCAN_LIMIT = 40

const isFlow = (e: GraphEdge): boolean => e.kind === 'lineage' || e.kind === 'view_dep'

/** The upstream and downstream neighbors of `id` in one relationships response (a lineage edge seen both ways is both). */
export function neighborSet(resp: RelationsResponse, id: string): NeighborSet {
  const up = new Map<string, Neighbor>()
  const down = new Map<string, Neighbor>()
  for (const e of resp.edges) {
    if (!isFlow(e) || e.source === e.target) continue
    if (e.target === id || (e.bidir && e.source === id)) {
      const other = e.target === id ? e.source : e.target
      if (!up.has(other)) up.set(other, { id: other, edge: e })
    }
    if (e.source === id || (e.bidir && e.target === id)) {
      const other = e.source === id ? e.target : e.source
      if (!down.has(other)) down.set(other, { id: other, edge: e })
    }
  }
  return { up: [...up.values()], down: [...down.values()] }
}

/** The neighbors on one side that the filters let show. */
export const shownNeighbors = (set: NeighborSet, dir: Direction, filters: EdgeFilters): Neighbor[] =>
  set[dir].filter((n) => edgeShown(n.edge, filters))

/** How many neighbors per side are not on the Graph, among the ones the filters let show. */
export function countMore(set: NeighborSet, onGraph: ReadonlySet<string>, filters: EdgeFilters): { up: number; down: number } {
  const count = (dir: Direction) => shownNeighbors(set, dir, filters).filter((n) => !onGraph.has(n.id)).length
  return { up: count('up'), down: count('down') }
}

/** The part of a relationships response that adds just these neighbors: their nodes and the edges that reach them. */
export function sliceOf(resp: RelationsResponse, wanted: readonly Neighbor[]): RelationsResponse {
  const ids = new Set(wanted.map((n) => n.id))
  const edges = new Map(wanted.map((n) => [n.edge.id, n.edge]))
  return { nodes: resp.nodes.filter((n: GraphNode) => ids.has(n.id)), edges: [...edges.values()], errors: [] }
}

/**
 * Which of the tables an expansion added can go when it is collapsed: not the focus or a pinned one, and none that
 * another table staying on the Graph is connected to. `links` are the edges on screen.
 */
export function collapsible(
  added: readonly string[],
  origin: string,
  links: ReadonlyArray<{ source: string; target: string }>,
  keep: ReadonlySet<string>,
): string[] {
  const out = new Set(added.filter((id) => id !== origin && !keep.has(id)))
  for (let changed = true; changed; ) {
    changed = false
    for (const id of [...out]) {
      const needed = links.some((l) => {
        const other = l.source === id ? l.target : l.target === id ? l.source : null
        return other !== null && other !== id && other !== origin && !out.has(other)
      })
      if (needed) {
        out.delete(id)
        changed = true
      }
    }
  }
  return [...out]
}

/** The key an expansion is recorded under. */
export const expansionKey = (id: string, dir: Direction): string => `${id}|${dir}`
