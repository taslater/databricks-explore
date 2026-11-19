// Layout ported from relayout() in static/app.js. Pure: no React Flow, no DOM.
import dagre from '@dagrejs/dagre'
import type { GraphEdgeKind } from '../api/types'
import { familyOf } from './edgeStyles'

export interface LayoutNode {
  id: string
  width: number
  height: number
  /** The focus, or a node added on purpose. Never laid out as a reference-only node. */
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
/** Gap between reference-only nodes in their row. */
const KID_GAP = 24
/** Distance below the lowest main node for the reference-only row (center to center, as in the legacy code). */
const FK_ROW_OFFSET = 90
/** The least space between the lowest main node and the reference-only row, so a tall node (one listing columns) never overlaps it. */
const FK_ROW_MIN_GAP = 40
/** Vertical gap between the bands of unconnected parts of the graph. */
const COMPONENT_GAP = 60

/**
 * Returns the top-left position of every node.
 *
 * Rules, from the legacy UI and the edge families (flow runs left to right, references hang above and below):
 * - Only flow edges (lineage, view dependencies) set the left-to-right rank.
 * - A reference-only node is not the focus and has at least one edge, none of them flow (foreign keys, joins and
 *   meaning links all count).
 * - Everything else goes through dagre (rankdir LR, nodesep 20, ranksep 110). Hidden nodes are included,
 *   so showing them again does not move the layout. A node with no flow edge takes the first rank, so a reference
 *   between two main nodes never moves one right of the other.
 * - Each reference-only node sits in a row, centered under its child. The child is the source of the node's first edge.
 * - Parts of the graph with no edge between them (an object added next to the graph) are laid out one by one and
 *   stacked top to bottom, in the order of their first node, so one part's reference row never lands on another part.
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

/** Space kept between a part that was laid out again and the parts beside it. */
const PART_MARGIN = 16

/**
 * The positions of the parts of the graph (see computeLayout) that hold any of `scope`, laid out again with each part's
 * top-left corner kept where it is. Everything else stays put. Null when a part would then overlap another one: the
 * caller lays the whole graph out instead.
 */
export function computeScopedLayout(nodes: LayoutNode[], edges: LayoutEdge[], scope: readonly string[]): Map<string, Point> | null {
  const ids = new Set(nodes.map((n) => n.id))
  const liveEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target))
  const wanted = new Set(scope)
  type Box = { left: number; top: number; right: number; bottom: number }
  const boxOf = (part: LayoutNode[], at: (n: LayoutNode) => Point): Box => ({
    left: Math.min(...part.map((n) => at(n).x)),
    top: Math.min(...part.map((n) => at(n).y)),
    right: Math.max(...part.map((n) => at(n).x + n.width)),
    bottom: Math.max(...part.map((n) => at(n).y + n.height)),
  })
  const out = new Map<string, Point>()
  const boxes: Box[] = []
  for (const part of components(nodes, liveEdges)) {
    const here = boxOf(part, (n) => ({ x: n.x, y: n.y }))
    if (!part.some((n) => wanted.has(n.id))) {
      for (const n of part) out.set(n.id, { x: n.x, y: n.y })
      boxes.push(here)
      continue
    }
    const members = new Set(part.map((n) => n.id))
    const pos = layoutPart(part, liveEdges.filter((e) => members.has(e.source)))
    const fresh = boxOf(part, (n) => pos.get(n.id)!)
    const dx = here.left - fresh.left
    const dy = here.top - fresh.top
    for (const n of part) out.set(n.id, { x: pos.get(n.id)!.x + dx, y: pos.get(n.id)!.y + dy })
    boxes.push({ left: fresh.left + dx, top: fresh.top + dy, right: fresh.right + dx, bottom: fresh.bottom + dy })
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      if (a.left < b.right + PART_MARGIN && b.left < a.right + PART_MARGIN && a.top < b.bottom + PART_MARGIN && b.top < a.bottom + PART_MARGIN) return null
    }
  }
  return out
}

const isFlow = (kind: string): boolean => familyOf(kind as GraphEdgeKind) === 'flow'

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

  const fkOnly = new Set<string>() // reference-only nodes (the name is from when only foreign keys hung below)
  for (const n of nodes) {
    const kinds = kindsByNode.get(n.id) ?? []
    if (!n.focus && kinds.length > 0 && !kinds.some(isFlow)) fkOnly.add(n.id)
  }
  // A part with no flow edge and no focus has no node for its reference row to hang under: lay it all out.
  if (fkOnly.size === nodes.length) fkOnly.clear()

  const main = nodes.filter((n) => !fkOnly.has(n.id))
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: NODE_SEP, ranksep: RANK_SEP })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of main) g.setNode(n.id, { width: n.width, height: n.height })
  for (const e of liveEdges) {
    if (isFlow(e.kind) && !fkOnly.has(e.source) && !fkOnly.has(e.target)) g.setEdge(e.source, e.target)
  }
  dagre.layout(g)

  const out = new Map<string, Point>()
  let bottom = 0
  for (const n of main) {
    const p = g.node(n.id) as { x: number; y: number }
    out.set(n.id, { x: p.x - n.width / 2, y: p.y - n.height / 2 })
    bottom = Math.max(bottom, p.y + n.height / 2)
  }

  // Group reference-only nodes by child. Insertion order is kept, as in the legacy code.
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
      out.set(k.id, { x, y: bottom + Math.max(FK_ROW_OFFSET - k.height / 2, FK_ROW_MIN_GAP) })
      x += k.width + KID_GAP
    }
  }

  // A reference-only node whose child is not laid out (or is itself reference-only, with no position) keeps its place.
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
