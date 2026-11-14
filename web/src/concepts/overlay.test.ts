import { describe, expect, it } from 'vitest'
import type { Concept, ConceptsForTables } from '../api/concepts'
import type { Relationship } from '../api/types'
import type { FlowNode } from '../graph/types'
import { CONCEPT_H, CONCEPT_W, conceptOverlay, isConceptEdge } from './overlay'

const ID1 = '7f0c2d3e-1111-4222-8333-444455556666'
const ID2 = '8a0c2d3e-1111-4222-8333-444455556666'

function concept(id: string, name: string, extra: Partial<Concept> = {}): Concept {
  return {
    id,
    name,
    definition: '',
    synonyms: [],
    domain: null,
    status: 'draft',
    tags: [],
    provenance: { origin: 'manual' },
    created_at: 't',
    updated_at: 't',
    ...extra,
  }
}

function link(id: string, conceptId: string, table: string, relation: string, column: string | null = null): Relationship {
  return {
    id,
    kind: 'concept_link',
    source: { table: `concept:${conceptId}` },
    target: { table, column },
    directed: true,
    provenance: { origin: 'user' },
    evidence: null,
    status: 'accepted',
    note: '',
    relation,
    created_at: 't',
    updated_at: 't',
  }
}

function table(id: string, x: number, y: number, extra: Partial<FlowNode['data']> = {}, hidden = false): FlowNode {
  const parts = id.split('.')
  return {
    id,
    type: 'table',
    position: { x, y },
    hidden,
    data: { name: parts[2], schema: `${parts[0]}.${parts[1]}`, kind: 'table', focus: false, selfRef: false, ...extra },
  }
}

const A = 'main.sales.orders'
const B = 'main.sales.customers'

describe('conceptOverlay', () => {
  const data = (concepts: Concept[], links: Relationship[]): ConceptsForTables => ({ concepts, links })

  it('draws nothing without data', () => {
    expect(conceptOverlay([table(A, 0, 0)], undefined)).toEqual({ nodes: [], edges: [] })
    expect(conceptOverlay([table(A, 0, 0)], data([], []))).toEqual({ nodes: [], edges: [] })
  })

  it('puts a concept above its table, with an edge into the table', () => {
    const out = conceptOverlay([table(A, 100, 200)], data([concept(ID1, 'Order')], [link('e1', ID1, A, 'defines')]))
    expect(out.nodes).toHaveLength(1)
    const n = out.nodes[0]
    expect(n).toMatchObject({ id: `concept:${ID1}`, type: 'concept', draggable: false, width: CONCEPT_W, height: CONCEPT_H })
    expect(n.position.x).toBe(100)
    expect(n.position.y).toBeLessThan(200 - CONCEPT_H)
    expect(n.data).toMatchObject({ conceptId: ID1, name: 'Order', targets: ['defines orders'] })
    expect(out.edges).toHaveLength(1)
    expect(out.edges[0]).toMatchObject({
      id: 'cl:e1',
      source: `concept:${ID1}`,
      target: A,
      sourceHandle: 'src-b',
      targetHandle: 'tgt-t',
      type: 'concept_link',
      selectable: false,
    })
    expect(isConceptEdge(out.edges[0].id)).toBe(true)
    expect(isConceptEdge('fk:x')).toBe(false)
  })

  it('draws one node for a concept linked to two tables, at the first one', () => {
    const out = conceptOverlay(
      [table(A, 0, 0), table(B, 300, 0)],
      data([concept(ID1, 'Order')], [link('e1', ID1, B, 'describes'), link('e2', ID1, A, 'defines')]),
    )
    expect(out.nodes).toHaveLength(1)
    expect(out.nodes[0].position.x).toBe(0)
    expect(out.edges.map((e) => e.target).sort()).toEqual([B, A])  // customers sorts before orders
  })

  it('spreads concepts that share a table, by name', () => {
    const out = conceptOverlay(
      [table(A, 50, 80)],
      data([concept(ID1, 'Zebra'), concept(ID2, 'Apple')], [link('e1', ID1, A, 'defines'), link('e2', ID2, A, 'describes')]),
    )
    expect(out.nodes.map((n) => n.data.name)).toEqual(['Apple', 'Zebra'])
    expect(out.nodes[1].position.x - out.nodes[0].position.x).toBeGreaterThanOrEqual(CONCEPT_W)
    expect(out.nodes[0].position.y).toBe(out.nodes[1].position.y)
  })

  it('leaves out links to tables that are not shown, and concepts left with none', () => {
    const out = conceptOverlay(
      [table(A, 0, 0, {}, true), table(B, 300, 0)],
      data([concept(ID1, 'Order'), concept(ID2, 'Customer')], [link('e1', ID1, A, 'defines'), link('e2', ID2, B, 'defines')]),
    )
    expect(out.nodes.map((n) => n.data.name)).toEqual(['Customer'])
    expect(out.edges).toHaveLength(1)
    expect(conceptOverlay([table(A, 0, 0)], data([concept(ID1, 'Order')], [link('e1', ID1, 'main.other.t', 'defines')]))).toEqual({
      nodes: [],
      edges: [],
    })
  })

  it('draws a column link to the column handle when the column is showing, else to the table', () => {
    const cols = [
      { name: 'order_id', type: 'bigint' },
      { name: 'customer_id', type: 'bigint' },
    ]
    const links = [link('e1', ID1, A, 'identifies', 'Customer_ID')]
    const withCols = conceptOverlay([table(A, 0, 0, { showColumns: true, columns: cols })], data([concept(ID1, 'Customer')], links))
    expect(withCols.edges[0].targetHandle).toBe('t-l:customer_id')
    expect(withCols.nodes[0].data.targets).toEqual(['identifies orders.Customer_ID'])
    const hidden = conceptOverlay([table(A, 0, 0, { showColumns: false, columns: cols })], data([concept(ID1, 'Customer')], links))
    expect(hidden.edges[0].targetHandle).toBe('tgt-t')
    const missing = conceptOverlay(
      [table(A, 0, 0, { showColumns: true, columns: cols })],
      data([concept(ID1, 'Customer')], [link('e1', ID1, A, 'identifies', 'nope')]),
    )
    expect(missing.edges[0].targetHandle).toBe('tgt-t')
  })
})
