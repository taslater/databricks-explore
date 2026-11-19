import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Relationship, RelationshipsResponse } from '../api/types'

const getRelationships = vi.fn()
vi.mock('../api/client', () => ({ getRelationships: (...a: unknown[]) => getRelationships(...a) }))

const { makeExpansion } = await import('./expansion')
const { useGraphStore } = await import('./graphStore')
const { CHAIN_CAP } = await import('./neighbors')

const T = (n: string) => `c.s.${n}`
const rel = (source: string, target: string, extra: Partial<Relationship> = {}): Relationship => ({
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
  ...extra,
})

/** A lineage chain: t0 -> t1 -> ... -> tN, with each table's response naming its own edges and its neighbors' nodes. */
function serve(edges: Relationship[]) {
  getRelationships.mockImplementation(async (table: string): Promise<RelationshipsResponse> => {
    const mine = edges.filter((e) => e.source.table === table || e.target.table === table)
    const ids = new Set([table, ...mine.flatMap((e) => [e.source.table, e.target.table])])
    return {
      table,
      level: 'table',
      nodes: [...ids].map((id) => ({ id, label: id.split('.').pop()!, kind: 'table', ...(id === table ? { focus: true } : {}) })),
      edges: mine,
      errors: [],
    }
  })
}

function setup() {
  const arrivals: string[][] = []
  const qc = new QueryClient()
  const ex = makeExpansion(qc, (before) => arrivals.push(before))
  return { ex, arrivals }
}

const ids = () => useGraphStore.getState().nodes.map((n) => n.id).sort()

beforeEach(() => {
  getRelationships.mockReset()
  useGraphStore.getState().clear()
})

describe('expandDirection', () => {
  it('reads the focus first, then adds only the chosen side one hop at a time', async () => {
    const { ex } = setup()
    serve([rel(T('a'), T('b')), rel(T('b'), T('c')), rel(T('c'), T('d')), rel(T('x'), T('b'))])
    useGraphStore.getState().mergeRelations({ nodes: [{ id: T('b'), label: 'b', kind: 'table', focus: true }], edges: [], errors: [] })
    await ex.expandDirection(T('b'), 'down')
    expect(ids()).toEqual([T('b'), T('c')])
    await ex.expandDirection(T('c'), 'down')
    expect(ids()).toEqual([T('b'), T('c'), T('d')])
    expect(useGraphStore.getState().edges.map((e) => e.id)).toEqual([`lineage:${T('b')}<->${T('c')}`, `lineage:${T('c')}<->${T('d')}`])
    expect(useGraphStore.getState().expansions[`${T('b')}|down`]).toEqual([T('c')])
  })
})

describe('readNeighbors', () => {
  it("keeps a neighbor's own facts (files, self-reference) without moving anything", async () => {
    const { ex } = setup()
    getRelationships.mockImplementation(async (table: string): Promise<RelationshipsResponse> => ({
      table,
      level: 'table',
      nodes: [{ id: table, label: 'x', kind: 'streaming_table', focus: true, files: [{ path: 's3://b/', readable: true }], self_ref: true }],
      edges: [],
      errors: [],
    }))
    useGraphStore.getState().mergeRelations({ nodes: [{ id: T('a'), label: 'a', kind: 'table', focus: true }], edges: [], errors: [] })
    await useGraphStore.getState().runLayout()
    await ex.readNeighbors(T('a'))
    const n = useGraphStore.getState().nodes[0]
    expect(n.data.files?.[0].path).toBe('s3://b/')
    expect(n.data.selfRef).toBe(true)
    expect(n.data.kind).toBe('streaming_table')
    expect(useGraphStore.getState().layoutPending).toBe(false)
    expect(useGraphStore.getState().neighbors[T('a')]).toEqual({ up: [], down: [] })
  })
})

describe('followDirection', () => {
  it('follows a chain to its end in one go and records it', async () => {
    const { ex } = setup()
    serve([rel(T('a'), T('b')), rel(T('b'), T('c')), rel(T('c'), T('d')), rel(T('x'), T('b'))])
    useGraphStore.getState().mergeRelations({ nodes: [{ id: T('b'), label: 'b', kind: 'table', focus: true }], edges: [], errors: [] })
    await ex.followDirection(T('b'), 'down')
    expect(ids()).toEqual([T('b'), T('c'), T('d')])
    expect(useGraphStore.getState().status.text).toContain('2 tables added')
    await ex.followDirection(T('b'), 'up')
    expect(ids()).toEqual([T('a'), T('b'), T('c'), T('d'), T('x')])
  })

  it('stops at the cap and says so', async () => {
    const { ex } = setup()
    const chain = Array.from({ length: CHAIN_CAP + 10 }, (_, i) => rel(T(`t${i}`), T(`t${i + 1}`)))
    serve(chain)
    useGraphStore.getState().mergeRelations({ nodes: [{ id: T('t0'), label: 't0', kind: 'table', focus: true }], edges: [], errors: [] })
    await ex.followDirection(T('t0'), 'down')
    expect(useGraphStore.getState().nodes.length).toBe(CHAIN_CAP + 1)
    expect(useGraphStore.getState().status.text).toContain(`Stopped at ${CHAIN_CAP} tables`)
  })

  it('does not loop on a cycle', async () => {
    const { ex } = setup()
    serve([rel(T('a'), T('b')), rel(T('b'), T('a'), { id: 'lineage:b->a' })])
    useGraphStore.getState().mergeRelations({ nodes: [{ id: T('a'), label: 'a', kind: 'table', focus: true }], edges: [], errors: [] })
    await ex.followDirection(T('a'), 'down')
    expect(ids()).toEqual([T('a'), T('b')])
  })
})

describe('collapseDirection', () => {
  it('removes what the expansion added, with its edges, and forgets it', async () => {
    const { ex } = setup()
    serve([rel(T('a'), T('b')), rel(T('b'), T('c')), rel(T('c'), T('d'))])
    useGraphStore.getState().mergeRelations({ nodes: [{ id: T('b'), label: 'b', kind: 'table', focus: true }], edges: [], errors: [] })
    await ex.followDirection(T('b'), 'down')
    ex.collapseDirection(T('b'), 'down')
    expect(ids()).toEqual([T('b')])
    expect(useGraphStore.getState().edges).toEqual([])
    expect(useGraphStore.getState().expansions).toEqual({})
  })

  it('keeps a table, and the way to it, when something else on the graph is connected to it', async () => {
    const { ex } = setup()
    serve([rel(T('b'), T('c')), rel(T('c'), T('d')), rel(T('x'), T('d'))])
    useGraphStore.getState().mergeRelations({ nodes: [{ id: T('b'), label: 'b', kind: 'table', focus: true }], edges: [], errors: [] })
    await ex.followDirection(T('b'), 'down')
    await ex.expandDirection(T('d'), 'up') // brings x in, which is connected to d
    ex.collapseDirection(T('b'), 'down')
    expect(ids()).toEqual([T('b'), T('c'), T('d'), T('x')])
  })
})
