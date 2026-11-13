import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphEdge, Relationship, RelationshipsResponse } from '../api/types'

const getRelationships = vi.fn()
vi.mock('../api/client', () => ({ getRelationships: (...a: unknown[]) => getRelationships(...a) }))

const { fetchCurrentEdge } = await import('./actions')

const A = 'main.sales.orders'
const B = 'main.sales.customers'

function rel(id: string, note: string, source = A, target = B, kind: Relationship['kind'] = 'fk'): Relationship {
  return {
    id,
    kind,
    source: { table: source },
    target: { table: target },
    directed: true,
    provenance: { origin: 'test' },
    evidence: null,
    status: 'derived',
    note,
    created_at: 'x',
    updated_at: 'x',
  }
}
const resp = (edges: Relationship[]): RelationshipsResponse => ({ table: A, level: 'table', nodes: [], edges, errors: [] })

describe('fetchCurrentEdge (edge restored from an old diagram)', () => {
  beforeEach(() => getRelationships.mockReset())

  const old: GraphEdge = { id: `fk:${A}->${B}`, source: A, target: B, kind: 'fk' } // no status, no note

  it('returns the note the server holds, so saving cannot blank it', async () => {
    getRelationships.mockResolvedValue(resp([rel(`fk:${A}->${B}`, 'kept on the server')]))
    const fresh = await fetchCurrentEdge(old)
    expect(fresh?.note).toBe('kept on the server')
    expect(fresh?.status).toBe('derived')
    expect(getRelationships).toHaveBeenCalledWith(A)
  })

  it('tries the other end when the first table does not list the edge', async () => {
    const vd: GraphEdge = { id: `view_dep:${A}->${B}`, source: A, target: B, kind: 'view_dep' }
    getRelationships
      .mockResolvedValueOnce(resp([]))
      .mockResolvedValueOnce(resp([rel(`view_dep:${A}->${B}`, 'n', A, B, 'view_dep')]))
    expect((await fetchCurrentEdge(vd))?.note).toBe('n')
    expect(getRelationships).toHaveBeenNthCalledWith(2, B)
  })

  it('matches a merged bidirectional lineage edge by its legacy id', async () => {
    const lin: GraphEdge = { id: `lineage:${B}<->${A}`, source: A, target: B, kind: 'lineage', bidir: true }
    getRelationships.mockResolvedValue(
      resp([rel(`lineage:${A}->${B}`, '', A, B, 'lineage'), rel(`lineage:${B}->${A}`, 'both ways', B, A, 'lineage')]),
    )
    expect((await fetchCurrentEdge(lin))?.note).toBe('both ways')
  })

  it('is undefined when the server no longer has the edge', async () => {
    getRelationships.mockResolvedValue(resp([]))
    expect(await fetchCurrentEdge(old)).toBeUndefined()
  })
})
