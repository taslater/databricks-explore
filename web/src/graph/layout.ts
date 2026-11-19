// Layout of the Graph: ELK's layered algorithm (column rows as ports, schemas as boxes), dagre as the fallback. Pure: no React Flow, no DOM.
import dagre from '@dagrejs/dagre'
import type { GraphEdgeKind } from '../api/types'
import { familyOf } from './edgeStyles'
import { elkLayout, type ElkGroupBox } from './elkLayout'
import { modelPart } from './modelLayout'

export interface LayoutNode {
  id: string
  width: number
  height: number
  /** The focus, or a node added on purpose. Never laid out as a reference-only node. */
  focus: boolean
  /** Current top-left position. Used only when a node has no dagre position. */
  x: number
  y: number
  /** The column rows the node draws, top to bottom. Each one a flow edge ends at is a port on the node's side. */
  rows?: string[]
  /** The row that changes the column level sits under the last column row. */
  moreRow?: boolean
  /** An earlier layout placed it: its order among its neighbours is kept. A node that was just added is not placed. */
  placed?: boolean
  /** The box (a schema, say) the node is laid out inside, with the others that name it. Only nodes in the flow take part. */
  group?: string
  /** The filters leave the node out of the picture (no edge of an edge family that shows, not pinned). The Model lens does not lay it out. */
  hidden?: boolean
}

export interface LayoutEdge {
  source: string
  target: string
  kind: string
  /** A column edge: the rows it joins. The table edge of the same pair then gives way to it. */
  sourceColumn?: string
  targetColumn?: string
  /** The filters leave the edge out. The Model lens counts only the edges that show. */
  hidden?: boolean
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

export type LayoutEngine = 'elk' | 'dagre'

export interface LayoutOptions {
  /** ELK unless a test wants the old layout to compare against. ELK that cannot load falls back to dagre. */
  engine?: LayoutEngine
  /** The Model lens: facts in a middle row and what they reference above and below (graph/modelLayout.ts). Give it only the nodes and reference edges that show. */
  lens?: 'model'
}

/** A group's box, from the nodes laid out inside it. */
export type GroupBox = ElkGroupBox

export interface GraphLayout {
  positions: Map<string, Point>
  /** One box per group (see LayoutNode.group) that holds at least one node in the flow. */
  groups: Map<string, GroupBox>
}

/**
 * Returns the top-left position of every node.
 *
 * Rules, from the legacy UI and the edge families (flow runs left to right, references hang above and below):
 * - Only flow edges (lineage, view dependencies) set the left-to-right rank.
 * - A reference-only node is not the focus and has at least one edge, none of them flow (foreign keys, joins and
 *   meaning links all count).
 * - Everything else goes through ELK's layered algorithm (direction RIGHT, nodesep 20, layer spacing 110). Hidden nodes
 *   are included, so showing them again does not move the layout. A node with no flow edge takes the first layer, so a
 *   reference between two main nodes never moves one right of the other. A column row that a flow edge ends at is a
 *   port on the node's side, so the nodes are ordered to cross as few column edges as the row order allows. A node
 *   that an earlier layout placed keeps its order among its neighbours.
 * - Each reference-only node sits in a row, centered under its child. The child is the source of the node's first edge.
 * - Parts of the graph with no edge between them (an object added next to the graph) are laid out one by one and
 *   stacked top to bottom, in the order of their first node, so one part's reference row never lands on another part.
 *   The first part keeps the position the rules above give it.
 */
// Python twin: graphs.layout_positions (the rules, not the positions) and graph_lens.model_layout, checked by web/src/parity.test.ts.
export async function computeLayout(nodes: LayoutNode[], edges: LayoutEdge[], opts: LayoutOptions = {}): Promise<Map<string, Point>> {
  return (await layoutGraph(nodes, edges, opts)).positions
}

/** computeLayout, and the box of each group. */
export async function layoutGraph(nodes: LayoutNode[], edges: LayoutEdge[], opts: LayoutOptions = {}): Promise<GraphLayout> {
  const ids = new Set(nodes.map((n) => n.id))
  const liveEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target))
  const out = new Map<string, Point>()
  const groups = new Map<string, GroupBox>()
  // Left edge of the first part, and the top for the next one. Later parts are moved to line up under it.
  let left = 0
  let nextTop: number | null = null
  for (const part of components(nodes, liveEdges)) {
    const members = new Set(part.map((n) => n.id))
    const laid = await layoutPart(part, liveEdges.filter((e) => members.has(e.source)), opts)
    const pos = laid.positions
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
    for (const [id, b] of laid.groups) groups.set(id, { ...b, x: b.x + dx, y: b.y + dy })
    nextTop = bottom + COMPONENT_GAP
  }
  return { positions: out, groups }
}

/** Space kept between a part that was laid out again and the parts beside it. */
const PART_MARGIN = 16

/**
 * The positions of the parts of the graph (see computeLayout) that hold any of `scope`, laid out again with each part's
 * top-left corner kept where it is. Everything else stays put. Null when a part would then overlap another one: the
 * caller lays the whole graph out instead.
 */
export async function computeScopedLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  scope: readonly string[],
  opts: LayoutOptions = {},
): Promise<Map<string, Point> | null> {
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
    const pos = (await layoutPart(part, liveEdges.filter((e) => members.has(e.source)), opts)).positions
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

/** The rules for one connected part. Every node in the result has a position. */
async function layoutPart(nodes: LayoutNode[], liveEdges: LayoutEdge[], opts: LayoutOptions): Promise<GraphLayout> {
  if (opts.lens === 'model') return { positions: modelPart(nodes, liveEdges), groups: new Map() }
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
  const flowEdges = liveEdges.filter((e) => isFlow(e.kind) && !fkOnly.has(e.source) && !fkOnly.has(e.target))
  const placed = await layoutMain(main, flowEdges, opts)
  const out = placed.positions
  let bottom = 0
  for (const n of main) bottom = Math.max(bottom, out.get(n.id)!.y + n.height)

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
  return { positions: out, groups: placed.groups }
}

/** The flow part of a layout: ELK, or dagre when asked to or when ELK cannot load. */
async function layoutMain(main: LayoutNode[], flowEdges: LayoutEdge[], opts: LayoutOptions): Promise<GraphLayout> {
  if (opts.engine !== 'dagre') {
    try {
      return await elkLayout(main, flowEdges, { nodeSep: NODE_SEP, layerSep: RANK_SEP })
    } catch (e) {
      console.warn('ELK could not lay out the graph, using dagre', e)
    }
  }
  return { positions: await dagreLayout(main, flowEdges), groups: new Map() }
}

/** The old layout: dagre knows nodes and flow edges, not where on a node an edge attaches. */
async function dagreLayout(main: LayoutNode[], flowEdges: LayoutEdge[]): Promise<Map<string, Point>> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: NODE_SEP, ranksep: RANK_SEP })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of main) g.setNode(n.id, { width: n.width, height: n.height })
  for (const e of flowEdges) g.setEdge(e.source, e.target)
  dagre.layout(g)
  const out = new Map<string, Point>()
  for (const n of main) {
    const p = g.node(n.id) as { x: number; y: number }
    out.set(n.id, { x: p.x - n.width / 2, y: p.y - n.height / 2 })
  }
  return out
}

/** Size estimate for a node that React Flow has not measured yet. Good enough for layout before the first render. Python twin: graphs.estimate_size. */
export function estimateSize(lines: string[]): { width: number; height: number } {
  const longest = Math.max(0, ...lines.map((l) => l.length))
  return {
    width: Math.min(240, Math.max(60, Math.round(longest * 6.8) + 18)),
    height: lines.length * 16 + 16,
  }
}
