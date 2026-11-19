// The ELK layout: column ports, stability after an expansion, groups, and no more edge crossings than dagre on the demo graphs.
import { describe, expect, it } from 'vitest'
import { computeLayout, layoutGraph, type LayoutEdge, type LayoutNode, type Point } from './layout'
import { buildElkGraph, rowCenter, seedPositions } from './elkLayout'

const node = (id: string, extra: Partial<LayoutNode> = {}): LayoutNode => ({ id, width: 180, height: 40, focus: false, x: 0, y: 0, ...extra })
const flow = (source: string, target: string, sourceColumn?: string, targetColumn?: string): LayoutEdge => ({
  source,
  target,
  kind: 'lineage',
  ...(sourceColumn !== undefined && { sourceColumn, targetColumn }),
})
const fk = (source: string, target: string): LayoutEdge => ({ source, target, kind: 'fk' })
/** A node that draws these column rows. */
const wide = (id: string, rows: string[], extra: Partial<LayoutNode> = {}): LayoutNode =>
  node(id, { rows, height: 40 + rows.length * 16 + 8, ...extra })

type Seg = [Point, Point]

/** Where an edge leaves and enters, as the Graph draws it: a row's side when the edge joins rows, else the middle of the side. */
function segment(e: LayoutEdge, nodes: Map<string, LayoutNode>, pos: Map<string, Point>): Seg {
  const s = nodes.get(e.source)!
  const t = nodes.get(e.target)!
  const ps = pos.get(s.id)!
  const pt = pos.get(t.id)!
  const forward = ps.x + s.width / 2 <= pt.x + t.width / 2
  const at = (n: LayoutNode, p: Point, column: string | undefined, east: boolean): Point => {
    const i = column === undefined ? -1 : (n.rows ?? []).findIndex((r) => r.toLowerCase() === column.toLowerCase())
    return { x: p.x + (east ? n.width : 0), y: p.y + (i < 0 ? n.height / 2 : rowCenter(n, i)) }
  }
  return [at(s, ps, e.sourceColumn, forward), at(t, pt, e.targetColumn, !forward)]
}

const cross = (a: Point, b: Point, c: Point): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
const same = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5

/** How many pairs of edges cross: segments that meet at a shared end do not count. */
export function countCrossings(nodes: LayoutNode[], edges: LayoutEdge[], pos: Map<string, Point>): number {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const segs = edges.filter((e) => e.source !== e.target).map((e) => segment(e, byId, pos))
  let n = 0
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const [a, b] = segs[i]
      const [c, d] = segs[j]
      if (same(a, c) || same(a, d) || same(b, c) || same(b, d)) continue
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) n++
    }
  }
  return n
}

// The demo lakehouse's lineage (demo_lake.py SOURCES, and its two pass-through views).
const SOURCES: Record<string, string[]> = {
  'silver.orders': ['bronze.raw_orders'],
  'silver.order_lines': ['bronze.raw_order_lines'],
  'silver.customers': ['bronze.raw_customers'],
  'silver.products': ['bronze.raw_products'],
  'silver.stores': ['bronze.raw_stores'],
  'silver.returns': ['bronze.raw_returns'],
  'silver.shipments': ['bronze.raw_shipments'],
  'silver.sessions': ['bronze.raw_clickstream'],
  'silver.v_orders': ['silver.orders'],
  'silver.v_orders_current': ['silver.v_orders'],
  'gold.fact_order_lines': ['silver.order_lines', 'silver.v_orders_current'],
  'gold.dim_customer': ['silver.customers'],
  'gold.dim_product': ['silver.products'],
  'gold.dim_store': ['silver.stores'],
  'gold.fact_returns': ['silver.returns', 'gold.fact_order_lines'],
  'gold.fact_shipments': ['silver.shipments', 'silver.v_orders_current'],
  'gold.daily_revenue': ['gold.fact_order_lines', 'gold.dim_date'],
  'gold.session_funnel': ['silver.sessions'],
}
function demoLineage(): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const edges = Object.entries(SOURCES).flatMap(([t, srcs]) => srcs.map((s) => flow(s, t)))
  const ids = [...new Set(edges.flatMap((e) => [e.source, e.target]))]
  return { nodes: ids.map((id) => node(id, { focus: id === 'gold.fact_order_lines' })), edges }
}

/** 30 tables in a chain, every fifth one also read two steps on, so there is something to cross. */
function chain(): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const ids = Array.from({ length: 30 }, (_, i) => 't' + i)
  const edges = ids.slice(1).map((id, i) => flow(ids[i], id))
  for (let i = 0; i + 3 < ids.length; i += 5) edges.push(flow(ids[i], ids[i + 3]))
  return { nodes: ids.map((id) => node(id, { focus: id === 't0' })), edges }
}

function star(): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const dims = Array.from({ length: 8 }, (_, i) => 'dim_' + i)
  return { nodes: [node('fact', { focus: true }), ...dims.map((d) => node(d))], edges: dims.map((d) => fk('fact', d)) }
}

describe('ELK layout against dagre', () => {
  const cases: Array<[string, () => { nodes: LayoutNode[]; edges: LayoutEdge[] }]> = [
    ['the demo lineage', demoLineage],
    ['a 30-table lineage chain', chain],
    ['a fact with 8 dimensions', star],
  ]
  for (const [name, make] of cases) {
    it('has no more crossings than dagre on ' + name, async () => {
      const { nodes, edges } = make()
      const elk = countCrossings(nodes, edges, await computeLayout(nodes, edges))
      const dagre = countCrossings(nodes, edges, await computeLayout(nodes, edges, { engine: 'dagre' }))
      expect(elk).toBeLessThanOrEqual(dagre)
    })
  }

  it('flows left to right on the demo lineage', async () => {
    const { nodes, edges } = demoLineage()
    const pos = await computeLayout(nodes, edges)
    for (const e of edges) expect(pos.get(e.target)!.x).toBeGreaterThan(pos.get(e.source)!.x)
  })

  it('keeps nodes in one layer apart', async () => {
    const { nodes, edges } = demoLineage()
    const pos = await computeLayout(nodes, edges)
    for (const a of nodes) {
      for (const b of nodes) {
        if (a.id >= b.id) continue
        const pa = pos.get(a.id)!
        const pb = pos.get(b.id)!
        const overlap = pa.x < pb.x + b.width && pb.x < pa.x + a.width && pa.y < pb.y + b.height && pb.y < pa.y + a.height
        expect(overlap).toBe(false)
      }
    }
  })
})

describe('column rows as ports', () => {
  it('puts the targets in the order of the rows their edges leave from', async () => {
    // s1 feeds Y and s3 feeds X: Y goes above X, whatever the order the nodes arrive in.
    const nodes = [wide('S', ['s1', 's2', 's3']), wide('X', ['x']), wide('Y', ['y'])]
    const edges = [flow('S', 'X', 's3', 'x'), flow('S', 'Y', 's1', 'y')]
    const pos = await computeLayout(nodes, edges)
    expect(pos.get('Y')!.y).toBeLessThan(pos.get('X')!.y)
    expect(countCrossings(nodes, edges, pos)).toBe(0)
  })

  it('does not cross column edges between wide tables when the row order allows it', async () => {
    const rows = (p: string) => Array.from({ length: 6 }, (_, i) => p + i)
    const nodes = [wide('A', rows('a')), wide('B', rows('b')), wide('C', rows('c')), wide('D', rows('d'))]
    // A's rows read in order by C, D, B (from the top), but the nodes arrive as B, C, D.
    const edges = [flow('A', 'C', 'a0', 'c0'), flow('A', 'C', 'a1', 'c1'), flow('A', 'D', 'a2', 'd0'), flow('A', 'D', 'a3', 'd2'), flow('A', 'B', 'a4', 'b4'), flow('A', 'B', 'a5', 'b5')]
    const reordered = [nodes[0], nodes[1], nodes[2], nodes[3]]
    const pos = await computeLayout(reordered, edges)
    expect(countCrossings(reordered, edges, pos)).toBe(0)
  })

  it('lays out a table edge once a column edge draws the pair', async () => {
    const nodes = [wide('A', ['a1', 'a2']), wide('B', ['b1', 'b2'])]
    const edges = [flow('A', 'B'), flow('A', 'B', 'a2', 'b1')]
    const pos = await computeLayout(nodes, edges)
    expect(pos.get('B')!.x).toBeGreaterThan(pos.get('A')!.x)
  })

  it('ignores a column that has no row', async () => {
    const nodes = [wide('A', ['a1']), wide('B', ['b1'])]
    const pos = await computeLayout(nodes, [flow('A', 'B', 'missing', 'b1')])
    expect(pos.get('B')!.x).toBeGreaterThan(pos.get('A')!.x)
  })

  it('finds a row by its name in any case', async () => {
    const nodes = [wide('A', ['Order_ID']), wide('B', ['b1'])]
    const pos = await computeLayout(nodes, [flow('A', 'B', 'order_id', 'b1')])
    expect(pos.get('B')!.x).toBeGreaterThan(pos.get('A')!.x)
  })
})

describe('layering by flow only', () => {
  it('hangs reference-only tables under the table that references them, and never right of it', async () => {
    const { nodes, edges } = star()
    const pos = await computeLayout(nodes, edges)
    const fact = pos.get('fact')!
    for (const d of nodes.slice(1)) expect(pos.get(d.id)!.y).toBeGreaterThan(fact.y + 40)
  })

  it('keeps a reference between two flow tables from moving one right of the other', async () => {
    const nodes = [node('a', { focus: true }), node('b', { focus: true })]
    const pos = await computeLayout(nodes, [fk('a', 'b')])
    expect(pos.get('a')!.x).toBe(pos.get('b')!.x)
  })
})

describe('stability', () => {
  /** The nodes of each layer from the top, as laid out. */
  const layers = (pos: Map<string, Point>, ids: string[]): string[][] => {
    const byX = new Map<number, string[]>()
    // A layer's nodes are within a pixel of one x; layers are at least a node width apart.
    for (const id of ids) byX.set(Math.round(pos.get(id)!.x / 100), [...(byX.get(Math.round(pos.get(id)!.x / 100)) ?? []), id])
    return [...byX.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list.sort((a, b) => pos.get(a)!.y - pos.get(b)!.y))
  }

  it('keeps the order of the nodes already on the graph when one is added', async () => {
    const { nodes, edges } = demoLineage()
    const first = await computeLayout(nodes, edges)
    const placed = nodes.map((n) => ({ ...n, x: first.get(n.id)!.x, y: first.get(n.id)!.y, placed: true }))
    // Expand downstream: tables that read gold.fact_returns, silver.stores and silver.customers.
    const added = [...placed, node('gold.returns_report'), node('gold.stores_mart'), node('gold.customers_mart')]
    const more = [
      ...edges,
      flow('gold.fact_returns', 'gold.returns_report'),
      flow('silver.stores', 'gold.stores_mart'),
      flow('silver.customers', 'gold.customers_mart'),
    ]
    const second = await computeLayout(added, more)
    const old = nodes.map((n) => n.id)
    const before = layers(first, old)
    const after = layers(second, old)
    // Each layer's nodes that were there still read in the same order.
    const order = (layer: string[], within: Set<string>) => layer.filter((id) => within.has(id))
    for (const layer of before) {
      const ids = new Set(layer)
      const holder = after.find((l) => l.some((id) => ids.has(id)))!
      expect(order(holder, ids)).toEqual(layer)
    }
  })
})

describe('stability with ports', () => {
  it('keeps targets in order when column edges are laid out again with a new node', async () => {
    const nodes = [wide('S', ['s1', 's2', 's3']), wide('X', ['x']), wide('Y', ['y'])]
    const edges = [flow('S', 'X', 's3', 'x'), flow('S', 'Y', 's1', 'y')]
    const first = await computeLayout(nodes, edges)
    const placed = nodes.map((n) => ({ ...n, x: first.get(n.id)!.x, y: first.get(n.id)!.y, placed: true }))
    const second = await computeLayout([...placed, wide('Z', ['z'])], [...edges, flow('S', 'Z', 's2', 'z')])
    expect(second.get('Y')!.y).toBeLessThan(second.get('X')!.y)
    expect(countCrossings([...placed, wide('Z', ['z'])], [...edges, flow('S', 'Z', 's2', 'z')], second)).toBe(0)
  })
})

describe('the ELK graph', () => {
  const spacing = { nodeSep: 20, layerSep: 110 }
  it('starts a new node one layer past a placed neighbour, level with it', () => {
    const nodes = [node('a', { x: 100, y: 50, placed: true }), node('b'), node('c')]
    const seeds = seedPositions(nodes, [flow('a', 'b'), flow('c', 'a')], spacing)!
    expect(seeds.get('a')).toEqual({ x: 100, y: 50 })
    expect(seeds.get('b')).toEqual({ x: 100 + 180 + 110, y: 50 })
    expect(seeds.get('c')).toEqual({ x: 100 - 180 - 110, y: 50 })
  })

  it('seeds nothing when no node is placed', () => {
    expect(seedPositions([node('a'), node('b')], [flow('a', 'b')], spacing)).toBeNull()
  })

  it('puts a port at the middle of each row it joins, on the side the edge leaves', () => {
    const a = wide('A', ['a1', 'a2'], { moreRow: true })
    const g = buildElkGraph([a, wide('B', ['b1'])], [flow('A', 'B', 'a2', 'b1')], spacing)
    const ports = g.children!.find((c) => c.id === 'A')!.ports!
    expect(ports).toHaveLength(1)
    expect(ports[0]).toMatchObject({ x: 180, y: rowCenter(a, 1) })
    expect(rowCenter(a, 1)).toBeGreaterThan(rowCenter(a, 0))
    expect(rowCenter(a, 1) + 8 + 20 + 4).toBe(a.height) // the last row, the row that changes the level, then the margin
  })
})

describe('groups', () => {
  it('lays out the nodes of a group inside its box', async () => {
    const nodes = [node('a', { group: 'bronze' }), node('b', { group: 'silver' }), node('c', { group: 'silver' }), node('d')]
    const edges = [flow('a', 'b'), flow('a', 'c'), flow('b', 'd')]
    const { positions, groups } = await layoutGraph(nodes, edges)
    expect([...groups.keys()].sort()).toEqual(['bronze', 'silver'])
    const silver = groups.get('silver')!
    for (const id of ['b', 'c']) {
      const p = positions.get(id)!
      expect(p.x).toBeGreaterThanOrEqual(silver.x)
      expect(p.y).toBeGreaterThanOrEqual(silver.y)
      expect(p.x + 180).toBeLessThanOrEqual(silver.x + silver.width)
      expect(p.y + 40).toBeLessThanOrEqual(silver.y + silver.height)
    }
    expect(positions.get('d')!.x).toBeGreaterThan(silver.x + silver.width - 1)
  })
})
