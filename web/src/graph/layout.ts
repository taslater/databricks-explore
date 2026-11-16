// Layout ported from relayout() in static/app.js. Pure: no React Flow, no DOM.
import dagre from '@dagrejs/dagre'

export interface LayoutNode {
  id: string
  width: number
  height: number
  /** The focus, or a node added on purpose. Never laid out as an FK-only node. */
  focus: boolean
  /** Current top-left position. Used only when a node has no dagre position. */
  x: number
  y: number
}

export interface LayoutEdge {
  source: string
  target: string
  kind: string
}

export interface Point {
  x: number
  y: number
}

const RANK_SEP = 110
const NODE_SEP = 20
/** Gap between FK-only nodes in their row. */
const KID_GAP = 24
/** Distance below the lowest main node for the FK-only row (center to center, as in the legacy code). */
const FK_ROW_OFFSET = 90
/** Vertical gap between the bands of unconnected parts of the graph. */
const COMPONENT_GAP = 60

/**
 * Returns the top-left position of every node.
 *
 * Rules, same as the legacy UI:
 * - An FK-only node is not the focus and has at least one edge, and all its edges are `fk`.
 * - Everything else goes through dagre (rankdir LR, nodesep 20, ranksep 110). Hidden nodes are included,
 *   so showing them again does not move the layout.
 * - Each FK-only node sits in a row, centered under its child. The child is the source of the node's first edge.
 * - Parts of the graph with no edge between them (an object added next to the graph) are laid out one by one and
 *   stacked top to bottom, in the order of their first node, so one part's FK row never lands on another part.
 *   The first part keeps the position the rules above give it.
 */
export function computeLayout(nodes: LayoutNode[], edges: LayoutEdge[]): Map<string, Point> {
  const ids = new Set(nodes.map((n) => n.id))
  const liveEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target))
  const out = new Map<string, Point>()
  // Left edge of the first part, and the top for the next one. Later parts are moved to line up under it.
  let left = 0
  let nextTop: number | null = null
  for (const part of components(nodes, liveEdges)) {
    const members = new Set(part.map((n) => n.id))
    const pos = layoutPart(part, liveEdges.filter((e) => members.has(e.source)))
    const partLeft = Math.min(...part.map((n) => pos.get(n.id)!.x))
    const partTop = Math.min(...part.map((n) => pos.get(n.id)!.y))
    if (nextTop === null) left = partLeft
    const dx = nextTop === null ? 0 : left - partLeft
    const dy = nextTop === null ? 0 : nextTop - partTop
    let bottom = -Infinity
    for (const n of part) {
      const p = pos.get(n.id)!
      out.set(n.id, { x: p.x + dx, y: p.y + dy })
      bottom = Math.max(bottom, p.y + dy + n.height)
    }
    nextTop = bottom + COMPONENT_GAP
  }
  return out
}

/** Groups nodes joined by edges, in the order of each group's first node. */
function components(nodes: LayoutNode[], edges: LayoutEdge[]): LayoutNode[][] {
  const parent = new Map(nodes.map((n) => [n.id, n.id]))
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)!
    parent.set(id, root)
    return root
  }
  for (const e of edges) parent.set(find(e.source), find(e.target))
  const groups = new Map<string, LayoutNode[]>()
  for (const n of nodes) {
    const root = find(n.id)
    const list = groups.get(root) ?? []
    list.push(n)
    groups.set(root, list)
  }
  return [...groups.values()]
}

/** The legacy rules for one connected part. Every node in the result has a position. */
function layoutPart(nodes: LayoutNode[], liveEdges: LayoutEdge[]): Map<string, Point> {
  const byId = new Map(nodes.map((n) => [n.id, n]))

  const kindsByNode = new Map<string, string[]>()
  for (const e of liveEdges) {
    for (const id of new Set([e.source, e.target])) {
      const list = kindsByNode.get(id) ?? []
      list.push(e.kind)
      kindsByNode.set(id, list)
    }
  }

  const fkOnly = new Set<string>()
  for (const n of nodes) {
    const kinds = kindsByNode.get(n.id) ?? []
    if (!n.focus && kinds.length > 0 && kinds.every((k) => k === 'fk')) fkOnly.add(n.id)
  }
  // A part made only of FK edges, with no focus in it, has no node for its FK row to hang under: lay it all out.
  if (fkOnly.size === nodes.length) fkOnly.clear()

  const main = nodes.filter((n) => !fkOnly.has(n.id))
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: NODE_SEP, ranksep: RANK_SEP })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of main) g.setNode(n.id, { width: n.width, height: n.height })
  for (const e of liveEdges) {
    if (!fkOnly.has(e.source) && !fkOnly.has(e.target)) g.setEdge(e.source, e.target)
  }
  dagre.layout(g)

  const out = new Map<string, Point>()
  let bottom = 0
  for (const n of main) {
    const p = g.node(n.id) as { x: number; y: number }
    out.set(n.id, { x: p.x - n.width / 2, y: p.y - n.height / 2 })
    bottom = Math.max(bottom, p.y + n.height / 2)
  }

  // Group FK-only nodes by child. Insertion order is kept, as in the legacy code.
  const groups = new Map<string, LayoutNode[]>()
  for (const n of nodes) {
    if (!fkOnly.has(n.id)) continue
    const first = liveEdges.find((e) => e.source === n.id || e.target === n.id)
    if (!first) continue
    const kids = groups.get(first.source) ?? []
    kids.push(n)
    groups.set(first.source, kids)
  }

  for (const [childId, kids] of groups) {
    const child = byId.get(childId)
    if (!child) continue
    const childTopLeft = out.get(childId) ?? { x: child.x, y: child.y }
    const centerX = childTopLeft.x + child.width / 2
    const totalWidth = kids.reduce((sum, k) => sum + k.width, 0) + KID_GAP * (kids.length - 1)
    let x = centerX - totalWidth / 2
    for (const k of kids) {
      out.set(k.id, { x, y: bottom + FK_ROW_OFFSET - k.height / 2 })
      x += k.width + KID_GAP
    }
  }

  // An FK-only node whose child is not laid out (or is itself FK-only, with no position) keeps its place.
  for (const n of nodes) if (!out.has(n.id)) out.set(n.id, { x: n.x, y: n.y })
  return out
}

/** Size estimate for a node that React Flow has not measured yet. Good enough for layout before the first render. */
export function estimateSize(lines: string[]): { width: number; height: number } {
  const longest = Math.max(0, ...lines.map((l) => l.length))
  return {
    width: Math.min(240, Math.max(60, Math.round(longest * 6.8) + 18)),
    height: lines.length * 16 + 16,
  }
}
