import { beforeEach, describe, expect, it } from 'vitest'
import type { GraphEdge, Relationship, RelationshipsResponse } from '../api/types'
import { COLUMN_LIMIT, columnHandleId, columnHandles, columnSides, columnsOf, newTableIds, findColumn, visibleColumns } from './columns'
import { deriveFlow } from './derive'
import { nameOf, schemaOf } from './format'
import { DEFAULT_FILTERS, useGraphStore } from './graphStore'
import { pairLabel, progressFraction, progressText, resultLines } from './mining'
import { toColumnEdges } from './relationships'
import type { FlowEdge, FlowNode } from './types'

const A = 'main.sales.orders'
const B = 'main.sales.customers'

const cols = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `c${i}`, type: 'int' }))

function node(id: string, extra: Partial<FlowNode['data']> = {}): FlowNode {
  return {
    id,
    type: 'table',
    position: { x: id === A ? 0 : 400, y: 0 },
    data: { name: nameOf(id), schema: schemaOf(id), kind: 'table', focus: false, selfRef: false, ...extra },
  }
}

function colEdge(over: Partial<GraphEdge> = {}): FlowEdge {
  const info: GraphEdge = {
    id: 'e_1',
    source: A,
    target: B,
    kind: 'join_mined',
    directed: false,
    status: 'proposed',
    source_column: 'customer_id',
    target_column: 'id',
    ...over,
  }
  return { id: info.id, source: info.source, target: info.target, data: { info } }
}

const tableEdge = (): FlowEdge => ({
  id: 'join_mined:a->b',
  source: A,
  target: B,
  data: { info: { id: 'join_mined:a->b', source: A, target: B, kind: 'join_mined', status: 'proposed' } },
})

function derive(nodes: FlowNode[], columnEdges: FlowEdge[], edges: FlowEdge[] = [tableEdge()]) {
  return deriveFlow({ nodes, edges, columnEdges, focusSchema: 'main.sales', filters: DEFAULT_FILTERS, hoverId: null })
}

describe('columnsOf and findColumn', () => {
  it('reads names and type text, dropping nameless entries', () => {
    const got = columnsOf({ columns: [{ name: 'id', type_text: 'bigint' }, { type_text: 'x' }, { name: 'n', type_name: 'STRING' }] })
    expect(got).toEqual([
      { name: 'id', type: 'bigint' },
      { name: 'n', type: 'STRING' },
    ])
  })
  it('finds a column whatever its case', () => {
    expect(findColumn([{ name: 'Customer_ID', type: '' }], 'customer_id')?.name).toBe('Customer_ID')
    expect(findColumn([], 'x')).toBeUndefined()
    expect(findColumn(cols(1), undefined)).toBeUndefined()
  })
})

describe('visibleColumns', () => {
  it('shows every column of a narrow table', () => {
    expect(visibleColumns(cols(COLUMN_LIMIT), [], false)).toHaveLength(COLUMN_LIMIT)
  })
  it('on a wide table keeps columns with an edge first, then the first others, in table order', () => {
    const got = visibleColumns(cols(60), ['c50', 'C55'], false).map((c) => c.name)
    expect(got).toHaveLength(COLUMN_LIMIT)
    expect(got).toContain('c50')
    expect(got).toContain('c55')
    expect(got.slice(0, 3)).toEqual(['c0', 'c1', 'c2'])
    expect(got.indexOf('c50')).toBeLessThan(got.indexOf('c55'))
  })
  it('shows all on request, and every involved column even past the limit', () => {
    expect(visibleColumns(cols(60), [], true)).toHaveLength(60)
    const many = cols(60).map((c) => c.name).slice(0, 20)
    expect(visibleColumns(cols(60), many, false)).toHaveLength(20)
  })
})

describe('column handles', () => {
  const at = (x: number, width = 200) => ({ x, width })
  const sides = (a: ReturnType<typeof at>, b: ReturnType<typeof at>) => {
    const h = columnHandles(a, b, false, 'a', 'b')
    return [h.sourceHandle, h.targetHandle]
  }

  it('face each other when the nodes sit side by side', () => {
    expect(sides(at(0), at(400))).toEqual([columnHandleId('s', 'r', 'a'), columnHandleId('t', 'l', 'b')])
    expect(sides(at(400), at(0))).toEqual([columnHandleId('s', 'l', 'a'), columnHandleId('t', 'r', 'b')])
  })

  it('face each other when the gap is a single pixel, and not when they overlap by one', () => {
    expect(columnSides(at(0), at(200), false)).toEqual({ source: 'r', target: 'l' })
    expect(columnSides(at(0), at(199), false)).toEqual({ source: 'r', target: 'r' })
    expect(columnSides(at(200), at(0), false)).toEqual({ source: 'l', target: 'r' })
  })

  it('use the same side on both nodes when they are stacked, so the edge does not curl through the nodes', () => {
    expect(columnSides(at(0), at(0), false)).toEqual({ source: 'r', target: 'r' })
    expect(columnSides(at(0), at(50), false)).toEqual({ source: 'r', target: 'r' })
    expect(columnSides(at(100), at(40), false)).toEqual({ source: 'l', target: 'l' })
    expect(columnSides(at(0, 300), at(100, 100), false)).toEqual({ source: 'r', target: 'r' }) // a narrow node under a wide one
  })

  it('loop on the right side for a self edge', () => {
    expect(columnHandles(at(0), at(0), true, 'a', 'b').targetHandle).toBe(columnHandleId('t', 'r', 'b'))
    expect(columnSides(at(0), at(0), true)).toEqual({ source: 'r', target: 'r' })
  })
})

describe('toColumnEdges', () => {
  const rel = (id: string, sc: string | null, tc: string | null, extra: Partial<Relationship> = {}): Relationship => ({
    id,
    kind: 'join_mined',
    source: { table: A, column: sc },
    target: { table: B, column: tc },
    directed: false,
    provenance: { origin: 'query_history' },
    evidence: { runs: 3, users: 2, last_seen: '2026-11-01', sample_refs: ['s1'] },
    status: 'proposed',
    note: '',
    created_at: 'x',
    updated_at: 'x',
    ...extra,
  })
  it('keeps edges with a column at both ends, each with its own id as patch id', () => {
    const resp: RelationshipsResponse = {
      table: A,
      level: 'column',
      nodes: [],
      errors: [],
      edges: [rel('e_1', 'customer_id', 'id'), rel('e_2', null, null), rel('e_3', 'a', null)],
    }
    const out = toColumnEdges(resp)
    expect(out.map((e) => e.id)).toEqual(['e_1'])
    expect(out[0]).toMatchObject({ source_column: 'customer_id', target_column: 'id', patch_ids: ['e_1'], last_seen: '2026-11-01' })
  })
  it('keeps lineage in both directions as two edges', () => {
    const l = (id: string, s: string, t: string) =>
      ({ ...rel(id, 'x', 'y'), kind: 'lineage', source: { table: s, column: 'x' }, target: { table: t, column: 'y' } }) as Relationship
    const out = toColumnEdges({ table: A, level: 'column', nodes: [], errors: [], edges: [l('l1', A, B), l('l2', B, A)] })
    expect(out).toHaveLength(2)
  })
})

describe('deriveFlow with column edges', () => {
  it('draws a column edge between column handles when both nodes show columns, and hides the table edge it refines', () => {
    const nodes = [
      node(A, { showColumns: true, columns: [{ name: 'customer_id', type: 'bigint' }] }),
      node(B, { showColumns: true, columns: [{ name: 'ID', type: 'bigint' }] }),
    ]
    const out = derive(nodes, [colEdge()])
    const col = out.edges.find((e) => e.id === 'e_1')!
    expect(col.hidden).toBe(false)
    expect(col.sourceHandle).toBe(columnHandleId('s', 'r', 'customer_id'))
    expect(col.targetHandle).toBe(columnHandleId('t', 'l', 'ID'))
    expect(col.markerEnd).toBeUndefined() // undirected: no arrowhead
    expect(out.edges.find((e) => e.id === 'join_mined:a->b')!.hidden).toBe(true)
    expect(out.nodes.find((n) => n.id === A)!.data.involved).toEqual(['customer_id'])
  })

  it('keeps the table edge and hides the column edge until both nodes show their columns', () => {
    const nodes = [node(A, { showColumns: true, columns: [{ name: 'customer_id', type: '' }] }), node(B)]
    const out = derive(nodes, [colEdge()])
    expect(out.edges.find((e) => e.id === 'e_1')!.hidden).toBe(true)
    expect(out.edges.find((e) => e.id === 'join_mined:a->b')!.hidden).toBe(false)
  })

  it('hides a column edge whose column the node does not have, and follows the kind and rejected filters', () => {
    const nodes = [
      node(A, { showColumns: true, columns: [{ name: 'customer_id', type: '' }] }),
      node(B, { showColumns: true, columns: [{ name: 'id', type: '' }] }),
    ]
    expect(derive(nodes, [colEdge({ target_column: 'nope' })]).edges.find((e) => e.id === 'e_1')!.hidden).toBe(true)
    expect(derive(nodes, [colEdge({ status: 'rejected' })]).edges.find((e) => e.id === 'e_1')!.hidden).toBe(true)
    const noJoins = deriveFlow({
      nodes, edges: [], columnEdges: [colEdge()], focusSchema: null, hoverId: null,
      filters: { ...DEFAULT_FILTERS, join_mined: false },
    })
    expect(noJoins.edges[0].hidden).toBe(true)
  })

  it('drops column edges whose node is not on the graph', () => {
    const out = derive([node(A, { showColumns: true, columns: cols(1) })], [colEdge()], [])
    expect(out.edges).toEqual([])
  })

  it('draws a directed lineage column edge with an arrowhead, however old, and a superseded one in the superseded style', () => {
    const nodes = [
      node(A, { showColumns: true, columns: [{ name: 'amount', type: '' }] }),
      node(B, { showColumns: true, columns: [{ name: 'revenue', type: '' }] }),
    ]
    const fresh = derive(nodes, [colEdge({ id: 'l1', kind: 'lineage', directed: true, status: 'derived', source_column: 'amount', target_column: 'revenue', last_seen: '2026-11-12' })], [])
    expect(fresh.edges[0].markerEnd).toBeDefined()
    expect(fresh.edges[0].type).toBe('lineage')
    const old = derive(nodes, [colEdge({ id: 'l1', kind: 'lineage', directed: true, status: 'derived', source_column: 'amount', target_column: 'revenue', last_seen: '2026-01-01' })], [])
    expect(old.edges[0].type).toBe('lineage') // age alone dims nothing
    const gone = derive(nodes, [colEdge({ id: 'l1', kind: 'lineage', directed: true, status: 'superseded', source_column: 'amount', target_column: 'revenue' })], [])
    expect(gone.edges[0].hidden).toBe(true) // hidden until "superseded edges" is on
  })
})

describe('graph store column state', () => {
  beforeEach(() => useGraphStore.getState().clear())
  it('stores columns, merges and refreshes column edges by id, and clears them', () => {
    const s = useGraphStore.getState()
    s.mergeRelations({ nodes: [{ id: A, label: 'orders', kind: 'table', focus: true }], edges: [], errors: [] })
    s.setColumns(A, cols(2))
    expect(useGraphStore.getState().nodes[0].data).toMatchObject({ showColumns: true })
    s.setShowColumns(A, false)
    expect(useGraphStore.getState().nodes[0].data.showColumns).toBe(false)
    s.setAllColumns(A, true)
    expect(useGraphStore.getState().nodes[0].data.allColumns).toBe(true)
    const e = colEdge().data!.info
    s.mergeColumnEdges([e])
    s.mergeColumnEdges([{ ...e, status: 'accepted' }])
    expect(useGraphStore.getState().columnEdges).toHaveLength(1)
    expect(useGraphStore.getState().columnEdges[0].data!.info.status).toBe('accepted')
    s.updateEdgeInfo('e_1', { note: 'n' })
    expect(useGraphStore.getState().columnEdges[0].data!.info.note).toBe('n')
    s.clear()
    expect(useGraphStore.getState().columnEdges).toEqual([])
  })
})

describe('mining text helpers', () => {
  it('describes progress, with a count only where the phase has one', () => {
    expect(progressText({ phase: 'history', progress: { done: 0, total: 0 } })).toBe('Reading query history…')
    expect(progressText({ phase: 'extract', progress: { done: 120, total: 338 } })).toBe('Extracting joins… 120 of 338')
    expect(progressFraction({ phase: 'extract', progress: { done: 1, total: 4 } })).toBe(0.25)
    expect(progressFraction({ phase: 'lineage', progress: { done: 0, total: 0 } })).toBeNull()
  })
  it('summarizes a result and leaves out zero counts', () => {
    const base = { statements: 10, parsed: 9, with_joins: 4, unparsed: 0, redacted_skipped: 0, no_lineage: 0, pairs: 3,
      skipped_fk: 0, fk_unreadable_tables: 0, invalid: 0, created: 3, updated: 0, capped: false, since: '', until: '', finished_at: '' }
    expect(resultLines(base)).toEqual(['10 statements read, 4 with joins', '3 new suggestions, 0 updated'])
    const more = resultLines({ ...base, skipped_fk: 1, unparsed: 2, redacted_skipped: 1, capped: true })
    expect(more).toHaveLength(6)
    expect(more.join(' ')).toContain('declared foreign keys')
    expect(more.join(' ')).toContain('run again')
  })
  it('labels a column pair with short table names', () => {
    expect(pairLabel({ source: { table: A, column: 'customer_id' }, target: { table: B, column: 'id' } })).toBe('orders.customer_id ↔ customers.id')
  })
})

describe('Show columns follows the global setting', () => {
  it('names the nodes that arrived since, and only while the setting is on', () => {
    const nodes = [{ id: 'a.b.t1' }, { id: 'a.b.t2' }, { id: 'ph:1234' }]
    expect(newTableIds(true, ['a.b.t1'], nodes)).toEqual(['a.b.t2'])
    expect(newTableIds(false, ['a.b.t1'], nodes)).toEqual([])
    expect(newTableIds(true, ['a.b.t1', 'a.b.t2', 'ph:1234'], nodes)).toEqual([])
  })

  it('is a store setting that survives clearing the graph', () => {
    useGraphStore.getState().setColumnsOn(true)
    useGraphStore.getState().clear()
    expect(useGraphStore.getState().columnsOn).toBe(true)
    useGraphStore.getState().setColumnsOn(false)
  })
})
