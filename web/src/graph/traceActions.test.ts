import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ColumnTrace } from '../api/columnTrace'
import type { Relationship, RelationshipsResponse } from '../api/types'

const getRelationships = vi.fn()
const getObject = vi.fn()
vi.mock('../api/client', () => ({
  getRelationships: (...a: unknown[]) => getRelationships(...a),
  getObject: (...a: unknown[]) => getObject(...a),
  ApiError: class extends Error {},
}))
const getColumnTrace = vi.fn()
vi.mock('../api/columnTrace', async (orig) => ({ ...(await orig<typeof import('../api/columnTrace')>()), getColumnTrace: (...a: unknown[]) => getColumnTrace(...a) }))

const { makeTraceActions } = await import('./traceActions')
const { useGraphStore } = await import('./graphStore')
const { useTraceStore } = await import('./traceStore')

const T = (n: string) => `c.s.${n}`
const lineage = (source: string, target: string): Relationship => ({
  id: `lineage:${source}->${target}`,
  kind: 'lineage',
  source: { table: source },
  target: { table: target },
  directed: true,
  provenance: { origin: 'test' },
  evidence: null,
  status: 'derived',
  note: '',
  created_at: 'x',
  updated_at: 'x',
})

function serve(edges: Relationship[]) {
  getRelationships.mockImplementation(async (table: string): Promise<RelationshipsResponse> => {
    const mine = edges.filter((e) => e.source.table === table || e.target.table === table)
    const ids = new Set([table, ...mine.flatMap((e) => [e.source.table, e.target.table])])
    return { table, level: 'table', nodes: [...ids].map((id) => ({ id, label: id.split('.').pop()!, kind: 'table', ...(id === table ? { focus: true } : {}) })), edges: mine, errors: [] }
  })
}

const answer = (over: Partial<ColumnTrace> = {}): ColumnTrace => ({
  table: T('c'),
  column: 'v',
  direction: 'upstream',
  depth: 4,
  nodes: [],
  hops: [
    { id: `lineage:${T('b')}#v->${T('c')}#v`, source: { table: T('b'), column: 'v' }, target: { table: T('c'), column: 'v' }, hop: 1, side: 'up', last_seen: null, class: 'same', label: '=', expr: null, note: null },
    { id: `lineage:${T('a')}#v->${T('b')}#v`, source: { table: T('a'), column: 'v' }, target: { table: T('b'), column: 'v' }, hop: 2, side: 'up', last_seen: null, class: 'same', label: '=', expr: null, note: null },
  ],
  tables: [T('c'), T('b'), T('a')],
  readers: [],
  unread: [],
  truncated: false,
  errors: [],
  ...over,
})

const ids = () => useGraphStore.getState().nodes.map((n) => n.id).sort()

beforeEach(() => {
  getRelationships.mockReset()
  getObject.mockReset()
  getColumnTrace.mockReset()
  getObject.mockResolvedValue({ fetched_at: 'x', data: { columns: [{ name: 'v', type_text: 'int' }] } })
  useGraphStore.getState().clear()
  useTraceStore.getState().reset()
})

describe('a column trace on the graph', () => {
  it('adds the tables it reaches that are not there, pinned, loads their columns, and clearing takes them off and puts the others back', async () => {
    serve([lineage(T('a'), T('b')), lineage(T('b'), T('c')), lineage(T('x'), T('c'))])
    getColumnTrace.mockResolvedValue(answer())
    const g = useGraphStore.getState()
    g.mergeRelations({ nodes: [{ id: T('c'), label: 'c', kind: 'table', focus: true }, { id: T('x'), label: 'x', kind: 'table' }], edges: [], errors: [] })
    useGraphStore.setState((s) => ({ nodes: s.nodes.map((n) => ({ ...n, position: { x: 7, y: 8 } })), layoutPending: false }))
    const { start, stop } = makeTraceActions(new QueryClient())

    await start(T('c'), 'v', 'upstream')
    expect(ids()).toEqual([T('a'), T('b'), T('c'), T('x')])
    expect(useTraceStore.getState().added.sort()).toEqual([T('a'), T('b')])
    expect(useGraphStore.getState().nodes.filter((n) => n.data.pinned).map((n) => n.id).sort()).toEqual([T('a'), T('b')])
    expect(useGraphStore.getState().edges.map((e) => e.id).sort()).toEqual([`lineage:${T('a')}<->${T('b')}`, `lineage:${T('b')}<->${T('c')}`])
    expect(Object.keys(useTraceStore.getState().columns).sort()).toEqual([T('a'), T('b'), T('c')])
    expect(useGraphStore.getState().nodes.find((n) => n.id === T('c'))!.data.columns).toBeUndefined() // the trace draws columns, it does not put them on the node

    useGraphStore.setState((s) => ({ nodes: s.nodes.map((n) => ({ ...n, position: { x: 99, y: 99 } })) }))
    stop()
    expect(ids()).toEqual([T('c'), T('x')])
    expect(useGraphStore.getState().nodes.map((n) => n.position)).toEqual([{ x: 7, y: 8 }, { x: 7, y: 8 }])
    expect(useGraphStore.getState().edges.every((e) => ![e.source, e.target].some((i) => i === T('a') || i === T('b')))).toBe(true)
    expect(useGraphStore.getState().layoutPending).toBe(false)
    expect(useTraceStore.getState().request).toBeNull()
  })

  it('adds nothing for a table already there, and starting another trace first ends the one before', async () => {
    serve([lineage(T('a'), T('b')), lineage(T('b'), T('c'))])
    getColumnTrace.mockResolvedValueOnce(answer()).mockResolvedValueOnce(answer({ tables: [T('c'), T('b')], hops: answer().hops.slice(0, 1) }))
    useGraphStore.getState().mergeRelations({ nodes: [{ id: T('c'), label: 'c', kind: 'table', focus: true }, { id: T('b'), label: 'b', kind: 'table' }], edges: [], errors: [] })
    const { start } = makeTraceActions(new QueryClient())
    await start(T('c'), 'v', 'upstream')
    expect(useTraceStore.getState().added).toEqual([T('a')])
    await start(T('c'), 'v', 'both')
    expect(ids()).toEqual([T('b'), T('c')])
    expect(useTraceStore.getState().added).toEqual([])
    expect(useTraceStore.getState().request).toMatchObject({ direction: 'both' })
  })

  it('ends the trace and says why when the server cannot read it', async () => {
    getColumnTrace.mockRejectedValue(new Error('c.s.c has no column v'))
    useGraphStore.getState().mergeRelations({ nodes: [{ id: T('c'), label: 'c', kind: 'table', focus: true }], edges: [], errors: [] })
    await makeTraceActions(new QueryClient()).start(T('c'), 'v', 'upstream')
    expect(useTraceStore.getState().request).toBeNull()
    expect(useGraphStore.getState().status).toEqual({ text: 'c.s.c has no column v', error: true })
  })
})
