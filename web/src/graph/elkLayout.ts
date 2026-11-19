// The Graph's flow layout on ELK (elkjs): the layered algorithm, direction RIGHT, with a port for each column row a flow edge
// ends at and a box around each group. In a browser it runs in a web worker; elkjs is loaded the first time it is needed.
import type { ElkExtendedEdge, ElkNode, ElkPort } from 'elkjs/lib/elk-api'
import type { GraphLayout, LayoutEdge, LayoutNode, Point } from './layout'

export interface ElkGroupBox {
  x: number
  y: number
  width: number
  height: number
}

export interface ElkSpacing {
  /** Between nodes in one layer. */
  nodeSep: number
  /** Between layers. */
  layerSep: number
}

/** Height of a column row, and of the row under them that changes the column level (see ColumnRows and .tbl-col in index.css). */
export const ROW_HEIGHT = 16
export const MORE_ROW_HEIGHT = 20
/** Space under the last row of a node. */
const ROWS_BOTTOM = 4
/** Space around the nodes in a group's box: the top holds its name. */
const GROUP_PADDING = '[top=26,left=14,bottom=14,right=14]'

/** Where a row's centre is on its node, counted from the node's top. The rows end the node. */
export function rowCenter(node: LayoutNode, index: number): number {
  const rows = node.rows ?? []
  const below = ROWS_BOTTOM + (node.moreRow ? MORE_ROW_HEIGHT : 0) + (rows.length - index - 1) * ROW_HEIGHT
  return Math.max(0, node.height - below - ROW_HEIGHT / 2)
}

interface Elk {
  layout(graph: ElkNode): Promise<ElkNode>
}

let loaded: Promise<Elk> | null = null

/** One ELK for the page. A browser gets a worker, so the layout never blocks the Graph; anywhere else it runs in place. */
function loadElk(): Promise<Elk> {
  loaded ??= (async () => {
    if (typeof Worker !== 'undefined') {
      try {
        const { default: ELK } = await import('elkjs/lib/elk-api')
        return new ELK({ workerFactory: () => new Worker(new URL('elkjs/lib/elk-worker.min.js', import.meta.url)) })
      } catch (e) {
        console.warn('ELK worker did not start, laying out on the page', e)
      }
    }
    const { default: ELK } = await import('elkjs/lib/elk.bundled.js')
    return new ELK()
  })()
  return loaded
}

const portId = (node: string, side: 'w' | 'e', column: string): string => `${node}::${side}::${column}`

/**
 * Where each node starts, for a layout that keeps what an earlier one decided. A placed node starts where it is. A new one
 * starts one layer past (or before) a neighbour already placed, level with it, and so on outward. Null when nothing is placed.
 */
export function seedPositions(nodes: LayoutNode[], edges: LayoutEdge[], spacing: ElkSpacing): Map<string, Point> | null {
  const known = new Map<string, Point>()
  for (const n of nodes) if (n.placed) known.set(n.id, { x: n.x, y: n.y })
  if (known.size === 0) return null
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (let grew = true; grew; ) {
    grew = false
    for (const e of edges) {
      const s = byId.get(e.source)
      const t = byId.get(e.target)
      if (!s || !t || s === t) continue
      const ks = known.get(s.id)
      const kt = known.get(t.id)
      if (ks && !kt) known.set(t.id, { x: ks.x + s.width + spacing.layerSep, y: ks.y })
      else if (kt && !ks) known.set(s.id, { x: kt.x - s.width - spacing.layerSep, y: kt.y })
      else continue
      grew = true
    }
  }
  // Nodes with no flow edge to a placed one start in the first layer, below everything.
  const left = Math.min(...[...known.values()].map((p) => p.x))
  let below = Math.max(...nodes.filter((n) => known.has(n.id)).map((n) => known.get(n.id)!.y + n.height))
  for (const n of nodes) {
    if (known.has(n.id)) continue
    known.set(n.id, { x: left, y: below + spacing.nodeSep })
    below += n.height + spacing.nodeSep
  }
  return known
}

/** The ELK graph for the nodes and flow edges. */
export function buildElkGraph(nodes: LayoutNode[], edges: LayoutEdge[], spacing: ElkSpacing): ElkNode {
  const seeds = seedPositions(nodes, edges, spacing)
  const rowIndex = new Map<string, Map<string, number>>()
  for (const n of nodes) rowIndex.set(n.id, new Map((n.rows ?? []).map((r, i) => [r.toLowerCase(), i])))

  const ports = new Map<string, Map<string, ElkPort>>() // by node, then port id
  const portFor = (node: LayoutNode, side: 'w' | 'e', column: string | undefined): string | null => {
    const index = column === undefined ? undefined : rowIndex.get(node.id)?.get(column.toLowerCase())
    if (index === undefined) return null
    const id = portId(node.id, side, column!.toLowerCase())
    const mine = ports.get(node.id) ?? new Map<string, ElkPort>()
    if (!mine.has(id)) {
      mine.set(id, {
        id,
        x: side === 'w' ? 0 : node.width,
        y: rowCenter(node, index),
        width: 0,
        height: 0,
        layoutOptions: { 'elk.port.side': side === 'w' ? 'WEST' : 'EAST' },
      })
    }
    ports.set(node.id, mine)
    return id
  }

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const elkEdges: ElkExtendedEdge[] = []
  const ported = new Set<string>() // pairs a column edge already draws: their table edge adds nothing
  for (const e of edges) {
    const s = byId.get(e.source)
    const t = byId.get(e.target)
    if (!s || !t || s === t) continue
    const from = portFor(s, 'e', e.sourceColumn)
    const to = portFor(t, 'w', e.targetColumn)
    if (!from && !to) continue
    ported.add(`${e.source}|${e.target}`)
    elkEdges.push({ id: `e${elkEdges.length}`, sources: [from ?? s.id], targets: [to ?? t.id] })
  }
  for (const e of edges) {
    const s = byId.get(e.source)
    const t = byId.get(e.target)
    if (!s || !t || s === t || ported.has(`${e.source}|${e.target}`)) continue
    elkEdges.push({ id: `e${elkEdges.length}`, sources: [s.id], targets: [t.id] })
  }

  const elkNode = (n: LayoutNode): ElkNode => {
    const mine = ports.get(n.id)
    const layoutOptions: Record<string, string> = {}
    if (mine) layoutOptions['elk.portConstraints'] = 'FIXED_POS'
    const seed = seeds?.get(n.id)
    if (seed) layoutOptions['elk.position'] = `(${seed.x},${seed.y})`
    return { id: n.id, ...(seed && { x: seed.x, y: seed.y }), width: n.width, height: n.height, ...(mine && { ports: [...mine.values()] }), layoutOptions }
  }

  const children: ElkNode[] = []
  const groups = new Map<string, ElkNode>()
  for (const n of nodes) {
    if (n.group === undefined) {
      children.push(elkNode(n))
      continue
    }
    const gid = `group:${n.group}`
    let g = groups.get(gid)
    if (!g) {
      g = { id: gid, children: [], layoutOptions: { 'elk.padding': GROUP_PADDING } }
      groups.set(gid, g)
      children.push(g)
    }
    g.children!.push(elkNode(n))
  }

  return {
    id: 'root',
    children,
    edges: elkEdges,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'POLYLINE',
      'elk.spacing.nodeNode': String(spacing.nodeSep),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(spacing.layerSep),
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      ...(groups.size > 0 && { 'elk.hierarchyHandling': 'INCLUDE_CHILDREN' }),
      // An earlier layout's decisions stay: nodes keep their layer and their order within it.
      ...(seeds && {
        'elk.layered.layering.strategy': 'INTERACTIVE',
        'elk.layered.cycleBreaking.strategy': 'INTERACTIVE',
        'elk.layered.crossingMinimization.semiInteractive': 'true',
      }),
    },
  }
}

/** Top-left positions for the nodes (the flow part of a graph) and the box of each group. Rejects when elkjs cannot run. */
export async function elkLayout(nodes: LayoutNode[], edges: LayoutEdge[], spacing: ElkSpacing): Promise<GraphLayout> {
  const positions = new Map<string, Point>()
  const groups = new Map<string, ElkGroupBox>()
  if (nodes.length === 0) return { positions, groups }
  const laid = await (await loadElk()).layout(buildElkGraph(nodes, edges, spacing))
  const walk = (node: ElkNode, ox: number, oy: number): void => {
    for (const c of node.children ?? []) {
      const x = ox + (c.x ?? 0)
      const y = oy + (c.y ?? 0)
      if (c.id.startsWith('group:')) {
        groups.set(c.id.slice('group:'.length), { x, y, width: c.width ?? 0, height: c.height ?? 0 })
        walk(c, x, y)
      } else {
        positions.set(c.id, { x, y })
      }
    }
  }
  walk(laid, 0, 0)
  return { positions, groups }
}
