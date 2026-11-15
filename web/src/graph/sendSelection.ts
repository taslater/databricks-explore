// Sending Graph tables to the Canvas: which tables a lineage path means, where their cards go (left to right by
// dependency) and which connectors join them. Pure: no store, no fetch.
import dagre from '@dagrejs/dagre'
import type { CanvasConnector, GraphEdge } from '../api/types'

export type PathDirection = 'downstream' | 'upstream'

/** The edge kinds that say where data comes from: a path follows these and no others. */
const PATH_KINDS: ReadonlySet<string> = new Set(['lineage', 'view_dep'])

/** The label a lineage or view-dependency connector carries, as the server's connect_known labels it. */
const PATH_LABEL = { lineage: 'lineage', view_dep: 'view' } as const

/** Gap between cards in a layer and between layers, in canvas px. */
export const CARD_GAP = 40
export const LAYER_GAP = 80

export interface PathResult {
  /** The start table first, then the tables reached, nearest first. */
  tables: string[]
  /** The lineage and view-dependency edges walked, source to target as data flows. */
  edges: GraphEdge[]
}

/**
 * The chain of lineage and view dependencies from `start` on the edges given (the ones the graph shows): everything
 * downstream (what is built from it) or upstream (what it is built from), however many hops the graph has loaded.
 * A cycle ends the walk. An edge that lineage saw both ways (`bidir`) leads either way.
 */
export function lineagePath(start: string, direction: PathDirection, edges: readonly GraphEdge[]): PathResult {
  const usable = edges.filter((e) => PATH_KINDS.has(e.kind) && e.source !== e.target)
  const next = (table: string): Array<{ other: string; edge: GraphEdge }> => {
    const out: Array<{ other: string; edge: GraphEdge }> = []
    for (const e of usable) {
      const [from, to] = direction === 'downstream' ? [e.source, e.target] : [e.target, e.source]
      if (from === table) out.push({ other: to, edge: e })
      else if (e.bidir && to === table) out.push({ other: from, edge: e })
    }
    return out
  }
  const tables = [start]
  const seen = new Set([start])
  const walked = new Map<string, GraphEdge>()
  for (let i = 0; i < tables.length; i++) {
    for (const { other, edge } of next(tables[i])) {
      walked.set(edge.id, edge)
      if (!seen.has(other)) {
        seen.add(other)
        tables.push(other)
      }
    }
  }
  return { tables, edges: [...walked.values()] }
}

/**
 * One connector per pair of tables from lineage and view-dependency edges: the fallback when the server cannot plan
 * them. Labeled `lineage`, or `view` when the pair has a view dependency, like the server's plan.
 */
export function pathConnectors(edges: readonly GraphEdge[]): CanvasConnector[] {
  const byPair = new Map<string, GraphEdge[]>()
  for (const e of edges) {
    if (!PATH_KINDS.has(e.kind) || e.source === e.target) continue
    const key = [e.source.toLowerCase(), e.target.toLowerCase()].sort().join('|')
    byPair.set(key, [...(byPair.get(key) ?? []), e])
  }
  return [...byPair.values()].map((es) => {
    const sorted = [...es].sort((a, b) => Number(b.kind === 'view_dep') - Number(a.kind === 'view_dep'))
    const first = sorted[0]
    const kinds = [...new Set(sorted.map((e) => e.kind))]
    return {
      source: first.source,
      target: first.target,
      label: PATH_LABEL[first.kind as keyof typeof PATH_LABEL],
      directed: true,
      proposed: false,
      bidir: es.some((e) => e.source.toLowerCase() !== first.source.toLowerCase()) || !!first.bidir,
      kinds,
    }
  })
}

export interface Box {
  id: string
  w: number
  h: number
}

/**
 * Top-left positions that put each box in a column by dependency, sources on the left, with the whole block's
 * top-left corner at (0, 0). Boxes with no connector among them stack in the first column. Cycles are broken the
 * way dagre does it. Deterministic for the same input.
 */
export function layeredPositions(
  boxes: readonly Box[],
  links: ReadonlyArray<{ source: string; target: string }>,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  if (boxes.length === 0) return out
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: CARD_GAP, ranksep: LAYER_GAP })
  g.setDefaultEdgeLabel(() => ({}))
  const ids = new Set(boxes.map((b) => b.id))
  for (const b of boxes) g.setNode(b.id, { width: b.w, height: b.h })
  const seen = new Set<string>()
  for (const l of links) {
    const key = `${l.source}\u0000${l.target}`
    if (l.source === l.target || !ids.has(l.source) || !ids.has(l.target) || seen.has(key)) continue
    seen.add(key)
    g.setEdge(l.source, l.target)
  }
  dagre.layout(g)
  let minX = Infinity
  let minY = Infinity
  for (const b of boxes) {
    const p = g.node(b.id) as { x: number; y: number }
    out.set(b.id, { x: p.x - b.w / 2, y: p.y - b.h / 2 })
    minX = Math.min(minX, p.x - b.w / 2)
    minY = Math.min(minY, p.y - b.h / 2)
  }
  for (const [id, p] of out) out.set(id, { x: Math.round(p.x - minX), y: Math.round(p.y - minY) })
  return out
}

export interface SendPlan {
  /** Cards to add, with their canvas positions. */
  cards: Array<{ table: string; position: { x: number; y: number } }>
  /** Connectors to draw between the tables (by name; the caller maps them to card ids). */
  links: CanvasConnector[]
  /** Tables that already had a card, and so got none. */
  existing: string[]
}

/**
 * What sending `tables` to a canvas does: a card for each table without one, laid out left to right by the
 * connectors among the new ones with the block's top-left corner at `origin`, and the connectors whose two ends are
 * among `tables` (to a new card or one already there). `have` holds the tables that already have a card, lower case.
 */
export function planSend(
  tables: readonly string[],
  have: ReadonlySet<string>,
  connectors: readonly CanvasConnector[],
  origin: { x: number; y: number },
  size: { w: number; h: number },
): SendPlan {
  const wanted = new Set<string>()
  const ordered: string[] = []
  for (const t of tables) {
    if (!wanted.has(t.toLowerCase())) {
      wanted.add(t.toLowerCase())
      ordered.push(t)
    }
  }
  const fresh = ordered.filter((t) => !have.has(t.toLowerCase()))
  const links = connectors.filter((c) => wanted.has(c.source.toLowerCase()) && wanted.has(c.target.toLowerCase()))
  const pos = layeredPositions(
    fresh.map((t) => ({ id: t, w: size.w, h: size.h })),
    links,
  )
  return {
    cards: fresh.map((t) => {
      const p = pos.get(t) ?? { x: 0, y: 0 }
      return { table: t, position: { x: origin.x + p.x, y: origin.y + p.y } }
    }),
    links,
    existing: ordered.filter((t) => have.has(t.toLowerCase())),
  }
}

/** The status line after a send. */
export function sendSummary(plan: SendPlan, drawn: number, skipped: { proposed?: number } = {}): string {
  const cards = plan.cards.length
  const connectors = drawn > 0 ? ` with ${drawn} connector${drawn === 1 ? '' : 's'}` : ''
  const notes: string[] = []
  if (cards > 0 && plan.existing.length > 0) notes.push(`${plan.existing.length} already there`)
  if (skipped.proposed) notes.push(`${skipped.proposed} proposed join${skipped.proposed === 1 ? '' : 's'} not drawn`)
  const tail = notes.length > 0 ? ` (${notes.join(', ')})` : ''
  if (cards === 0) {
    const n = plan.existing.length
    return `${n === 1 ? 'That table is' : `All ${n} tables are`} already on the canvas${drawn > 0 ? `; added ${drawn} connector${drawn === 1 ? '' : 's'}` : ''}${tail}`
  }
  return `Sent ${cards} table${cards === 1 ? '' : 's'} to the canvas${connectors}${tail}`
}
