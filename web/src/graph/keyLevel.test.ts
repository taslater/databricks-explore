import { beforeEach, describe, expect, it } from 'vitest'
import type { GraphEdge } from '../api/types'
import { columnHandleId, columnsOf } from './columns'
import { deriveFlow } from './derive'
import { DEFAULT_FILTERS, useGraphStore } from './graphStore'
import { computeLayout, computeScopedLayout, type LayoutNode } from './layout'
import type { FlowEdge, FlowNode } from './types'

const ORDERS = 'demo.sales.orders'
const CUSTOMERS = 'demo.sales.customers'

const orders = columnsOf({
  table_constraints: [
    { primary_key_constraint: { name: 'pk', child_columns: ['order_id'] } },
    { foreign_key_constraint: { name: 'fk', child_columns: ['customer_id'], parent_table: CUSTOMERS, parent_columns: ['customer_id'] } },
  ],
  columns: [{ name: 'order_id', type_text: 'bigint' }, { name: 'customer_id', type_text: 'bigint' }, { name: 'note', type_text: 'string' }, { name: 'total', type_text: 'double' }],
})
const customers = columnsOf({
  table_constraints: [{ primary_key_constraint: { name: 'pk', child_columns: ['customer_id'] } }],
  columns: [{ name: 'customer_id', type_text: 'bigint' }, { name: 'email', type_text: 'string' }],
})

const node = (id: string, x: number, columns: FlowNode['data']['columns'], extra: Partial<FlowNode['data']> = {}): FlowNode => ({
  id,
  type: 'table',
  position: { x, y: 0 },
  data: { name: id.split('.').pop()!, schema: 'demo.sales', kind: 'table', focus: false, selfRef: false, columns, showColumns: true, ...extra },
})

const fkInfo = (over: Partial<GraphEdge> = {}): GraphEdge => ({
  id: 'fk:col', source: ORDERS, target: CUSTOMERS, kind: 'fk', status: 'derived', source_column: 'customer_id', target_column: 'customer_id', ...over,
})
const asEdge = (info: GraphEdge): FlowEdge => ({ id: info.id, source: info.source, target: info.target, data: { info } })
const tableFk = asEdge({ id: 'fk:t', source: ORDERS, target: CUSTOMERS, kind: 'fk', status: 'derived' })

const derive = (nodes: FlowNode[], columnEdges: FlowEdge[], filters = DEFAULT_FILTERS) =>
  deriveFlow({ nodes, edges: [tableFk], columnEdges, focusSchema: 'demo.sales', filters, hoverId: null })

describe('keys-first columns in the graph', () => {
  it('shows the key columns of each table and nothing else, so the demo pair is two rows each', () => {
    const out = derive([node(ORDERS, 0, orders), node(CUSTOMERS, 400, customers)], [asEdge(fkInfo())])
    expect(out.nodes.map((n) => n.data.involved)).toEqual([['customer_id'], ['customer_id']])
    expect(orders.filter((c) => c.pk || c.fk).map((c) => c.name)).toEqual(['order_id', 'customer_id'])
  })

  it('draws a foreign key between the two key rows and lets the table edge give way', () => {
    const out = derive([node(ORDERS, 0, orders), node(CUSTOMERS, 400, customers)], [asEdge(fkInfo())])
    const col = out.edges.find((e) => e.id === 'fk:col')!
    expect(col.hidden).toBe(false)
    expect(col.type).toBe('reference')
    expect(col.sourceHandle).toBe(columnHandleId('s', 'r', 'customer_id'))
    expect(col.targetHandle).toBe(columnHandleId('t', 'l', 'customer_id'))
    expect(col.markerEnd).toBeUndefined()
    expect(out.edges.find((e) => e.id === 'fk:t')!.hidden).toBe(true)
  })

  it('draws one edge per column pair of a composite key', () => {
    const pairs = [fkInfo({ id: 'fk:1', source_column: 'order_id', target_column: 'customer_id' }), fkInfo({ id: 'fk:2' })]
    const out = derive([node(ORDERS, 0, orders), node(CUSTOMERS, 400, customers)], pairs.map(asEdge))
    expect(out.edges.filter((e) => !e.hidden).map((e) => e.id)).toEqual(['fk:1', 'fk:2'])
  })

  it('keeps the table edge while the other table lists no columns, and counts a column as connected only then', () => {
    const out = derive([node(ORDERS, 0, orders), node(CUSTOMERS, 400, customers, { showColumns: false })], [asEdge(fkInfo({ source_column: 'note', target_column: 'email' }))])
    expect(out.edges.find((e) => e.id === 'fk:t')!.hidden).toBe(false)
    expect(out.nodes[0].data.involved).toEqual([])
  })

  it('gives a row to a connected column only while its edge kind is on', () => {
    const nodes = [node(ORDERS, 0, orders), node(CUSTOMERS, 400, customers)]
    const edge = asEdge(fkInfo({ source_column: 'total', target_column: 'email' }))
    expect(derive(nodes, [edge]).nodes[0].data.involved).toEqual(['total'])
    expect(derive(nodes, [edge], { ...DEFAULT_FILTERS, fk: false }).nodes[0].data.involved).toEqual([])
  })
})

describe('layout of one part of the graph', () => {
  const n = (id: string, x: number, y: number, height = 40): LayoutNode => ({ id, width: 100, height, focus: false, x, y })
  const flow = (source: string, target: string) => ({ source, target, kind: 'lineage' })

  it('lays out again only the part that holds the node, keeping its top-left corner', async () => {
    const nodes = [n('a', 0, 0, 200), n('b', 300, 0), n('c', 0, 400), n('d', 300, 400)]
    const out = (await computeScopedLayout(nodes, [flow('a', 'b'), flow('c', 'd')], ['a']))!
    expect(out.get('c')).toEqual({ x: 0, y: 400 })
    expect(out.get('d')).toEqual({ x: 300, y: 400 })
    expect(Math.min(out.get('a')!.x, out.get('b')!.x)).toBe(0)
    expect(Math.min(out.get('a')!.y, out.get('b')!.y)).toBe(0)
    expect(out.get('b')!.x).toBeGreaterThan(out.get('a')!.x)
  })

  it('gives up when the part would run into another, so the caller lays everything out', async () => {
    const nodes = [n('a', 0, 0, 500), n('b', 300, 0), n('c', 0, 400), n('d', 300, 400)]
    expect(await computeScopedLayout(nodes, [flow('a', 'b'), flow('c', 'd')], ['a'])).toBeNull()
  })
})

describe('the reference row under a graph', () => {
  it('keeps clear of the node above it when the nodes in it are tall', async () => {
    const main: LayoutNode = { id: 'fact', width: 100, height: 100, focus: true, x: 0, y: 0 }
    const tall: LayoutNode = { id: 'dim', width: 100, height: 300, focus: false, x: 0, y: 0 }
    const pos = await computeLayout([main, tall], [{ source: 'fact', target: 'dim', kind: 'fk' }])
    expect(pos.get('dim')!.y).toBeGreaterThanOrEqual(pos.get('fact')!.y + 100 + 40)
    const short = await computeLayout([main, { ...tall, height: 40 }], [{ source: 'fact', target: 'dim', kind: 'fk' }])
    expect(short.get('dim')!.y + 20).toBe(short.get('fact')!.y + 100 + 90) // a short node is still centered 90 below, as before
  })
})

describe('layout requests', () => {
  beforeEach(() => useGraphStore.getState().clear())
  it('collects the scopes of requests made before the layout runs, and an unscoped request widens them to everything', () => {
    const s = useGraphStore.getState()
    s.requestLayout(['a'])
    s.requestLayout(['b'])
    expect(useGraphStore.getState().layoutScope).toEqual(['a', 'b'])
    s.requestLayout()
    expect(useGraphStore.getState().layoutScope).toBeNull()
    s.requestLayout(['c']) // a full layout is already waiting
    expect(useGraphStore.getState().layoutScope).toBeNull()
    expect(useGraphStore.getState().layoutPending).toBe(true)
  })
})
