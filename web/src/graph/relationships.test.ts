import { describe, expect, it } from 'vitest'
import type { GraphEdge, Relationship } from '../api/types'
import { deriveFlow } from './derive'
import { fromDiagram, toDiagramBody } from './diagram'
import { isDerivedKind } from './edgeStyles'
import { nameOf, schemaOf } from './format'
import { DEFAULT_FILTERS, useGraphStore } from './graphStore'
import { canReview, patchIds, toGraphEdges, toRelations } from './relationships'
import type { FlowEdge, FlowNode } from './types'

const A = 'main.sales.orders'
const B = 'main.sales.customers'
const C = 'main.sales.raw'
const PH = 'ph:7f0c2d3e-1111-4222-8333-444455556666'

function rel(extra: Partial<Relationship> & Pick<Relationship, 'id' | 'kind'>, source = A, target = B): Relationship {
  return {
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
  }
}

const node = (id: string, focus = false): FlowNode => ({
  id,
  type: 'table',
  position: { x: 0, y: 0 },
  data: { name: nameOf(id), schema: schemaOf(id), kind: 'table', focus, selfRef: false },
})
const flowEdge = (info: GraphEdge): FlowEdge => ({ id: info.id, source: info.source, target: info.target, data: { info } })

describe('superseded and last read', () => {
  it('keeps the superseded status, and a pair is superseded only when both of its directions are', () => {
    const both = toGraphEdges([
      rel({ id: `lineage:${A}->${C}`, kind: 'lineage', status: 'superseded' }, A, C),
      rel({ id: `lineage:${C}->${A}`, kind: 'lineage', status: 'superseded' }, C, A),
    ])
    expect(both).toHaveLength(1)
    expect(both[0]).toMatchObject({ bidir: true, status: 'superseded' })
    const one = toGraphEdges([
      rel({ id: `lineage:${A}->${C}`, kind: 'lineage', status: 'superseded' }, A, C),
      rel({ id: `lineage:${C}->${A}`, kind: 'lineage' }, C, A),
    ])
    expect(one[0].status).toBe('derived')
  })

  it("shows a view dependency's lineage time as when it was last read", () => {
    const [e] = toGraphEdges([
      rel({ id: `view_dep:${C}->${A}`, kind: 'view_dep', evidence: { last_seen: '2026-11-15 10:42:00.0', sample_refs: [] } }, C, A),
    ])
    expect(e).toMatchObject({ kind: 'view_dep', last_seen: '2026-11-15 10:42:00.0' })
  })
})

describe('toGraphEdges', () => {
  it('fills the legacy FK fields from the rolled column pairs and the provenance', () => {
    const [fk] = toGraphEdges([
      rel({
        id: `fk:${A}->${B}`,
        kind: 'fk',
        provenance: { origin: 'unity_catalog:table_constraints', source_ref: 'fk_cust' },
        columns: [
          { source: 'cust_id', target: 'id' },
          { source: 'region', target: 'region' },
        ],
        members: [`fk:${A}#cust_id->${B}#id`, `fk:${A}#region->${B}#region`],
      }),
    ])
    expect(fk.constraint).toBe('fk_cust')
    expect(fk.child_columns).toEqual(['cust_id', 'region'])
    expect(fk.parent_columns).toEqual(['id', 'region'])
    expect(fk.label).toBe('cust_id, region')
    expect(fk.status).toBe('derived')
    // A note on a derived edge is saved against the edge's own id, not its column members.
    expect(patchIds(fk)).toEqual([`fk:${A}->${B}`])
  })

  it('merges the two directions of lineage into one bidirectional edge with the legacy id', () => {
    const edges = toGraphEdges([
      rel({ id: `lineage:${C}->${A}`, kind: 'lineage', evidence: { last_seen: '2026-11-10 00:00:00.0', sample_refs: [] } }, C, A),
      rel({ id: `lineage:${A}->${C}`, kind: 'lineage', evidence: { last_seen: '2026-11-01 00:00:00.0', sample_refs: [] }, note: 'hi' }, A, C),
    ])
    expect(edges).toHaveLength(1)
    const e = edges[0]
    expect(e.id).toBe(`lineage:${[A, C].sort().join('<->')}`)
    expect(e.bidir).toBe(true)
    expect(e.last_seen).toBe('2026-11-10 00:00:00.0')
    expect(e.last_seen_by_dir).toEqual({
      [`${C}->${A}`]: '2026-11-10 00:00:00.0',
      [`${A}->${C}`]: '2026-11-01 00:00:00.0',
    })
    expect(e.note).toBe('hi')
    expect(patchIds(e)).toEqual([`lineage:${C}->${A}`, `lineage:${A}->${C}`])
  })

  it('keeps one-way lineage as one non-bidirectional edge', () => {
    const [e] = toGraphEdges([rel({ id: `lineage:${C}->${A}`, kind: 'lineage' }, C, A)])
    expect(e.bidir).toBe(false)
    expect(e.source).toBe(C)
    expect(e.target).toBe(A)
  })

  it('patches a stored edge through its members', () => {
    const [m] = toGraphEdges([
      rel({ id: `manual:${A}->${B}`, kind: 'manual', status: 'accepted', members: ['e_1', 'e_2'] }),
    ])
    expect(patchIds(m)).toEqual(['e_1', 'e_2'])
    const [single] = toGraphEdges([rel({ id: 'e_9', kind: 'manual', status: 'accepted' })])
    expect(patchIds(single)).toEqual(['e_9'])
    expect(canReview(single)).toBe(true)
    expect(canReview(toGraphEdges([rel({ id: `view_dep:${A}->${B}`, kind: 'view_dep' })])[0])).toBe(false)
  })

  it('passes nodes and errors through', () => {
    const out = toRelations({
      table: A,
      level: 'table',
      nodes: [{ id: A, label: 'orders', kind: 'table', focus: true }],
      edges: [],
      errors: ['lineage: x'],
    })
    expect(out.nodes).toHaveLength(1)
    expect(out.errors).toEqual(['lineage: x'])
  })
})

describe('patchIds for edges from an older saved diagram', () => {
  const base = { source: A, target: B }
  it('uses the saved id for FK and view dependency edges (it is the derived id)', () => {
    expect(patchIds({ ...base, id: `fk:${A}->${B}`, kind: 'fk' })).toEqual([`fk:${A}->${B}`])
    expect(patchIds({ ...base, id: `view_dep:${A}->${B}`, kind: 'view_dep' })).toEqual([`view_dep:${A}->${B}`])
  })
  it('rebuilds one derived id per direction for lineage', () => {
    expect(patchIds({ ...base, id: 'lineage:x<->y', kind: 'lineage' })).toEqual([`lineage:${A}->${B}`])
    expect(patchIds({ ...base, id: 'lineage:x<->y', kind: 'lineage', bidir: true })).toEqual([
      `lineage:${A}->${B}`,
      `lineage:${B}->${A}`,
    ])
    expect(
      patchIds({ ...base, id: 'lineage:x<->y', kind: 'lineage', bidir: true, last_seen_by_dir: { [`${B}->${A}`]: 't' } }),
    ).toEqual([`lineage:${B}->${A}`])
  })
})

describe('kinds in deriveFlow', () => {
  const nodes = [node(A, true), node(B), node(PH)]
  const base = { nodes, focusSchema: 'main.sales', hoverId: null }
  const manual = (status: GraphEdge['status'], extra: Partial<GraphEdge> = {}): FlowEdge =>
    flowEdge({ id: 'e_1', source: A, target: B, kind: 'manual', directed: true, status, ...extra })

  it('hides a kind whose filter is off, and the neighbor that only it reached', () => {
    const out = deriveFlow({ ...base, edges: [manual('accepted')], filters: { ...DEFAULT_FILTERS, manual: false } })
    expect(out.edges[0].hidden).toBe(true)
    expect(out.nodes.find((n) => n.id === B)!.hidden).toBe(true)
    const on = deriveFlow({ ...base, edges: [manual('accepted')], filters: DEFAULT_FILTERS })
    expect(on.edges[0].hidden).toBe(false)
    expect(on.edges[0].type).toBe('manual')
  })

  it('hides rejected edges unless asked for', () => {
    const edges = [manual('rejected')]
    expect(deriveFlow({ ...base, edges, filters: DEFAULT_FILTERS }).edges[0].hidden).toBe(true)
    expect(deriveFlow({ ...base, edges, filters: { ...DEFAULT_FILTERS, showRejected: true } }).edges[0].hidden).toBe(false)
  })

  it('draws no arrowheads on an undirected edge', () => {
    const [und] = deriveFlow({ ...base, edges: [manual('accepted', { directed: false })], filters: DEFAULT_FILTERS }).edges
    expect(und.markerEnd).toBeUndefined()
    const [dir] = deriveFlow({ ...base, edges: [manual('accepted')], filters: DEFAULT_FILTERS }).edges
    expect(dir.markerEnd).toBeDefined()
  })

  it('treats an edge without a status (old diagram) as a normal derived edge', () => {
    const old = flowEdge({ id: `fk:${A}->${B}`, source: A, target: B, kind: 'fk' })
    expect(deriveFlow({ ...base, edges: [old], filters: DEFAULT_FILTERS }).edges[0].hidden).toBe(false)
  })
})

describe('placeholder names', () => {
  it('shows a placeholder as "new <start of uuid>" with no schema of its own', () => {
    expect(nameOf(PH)).toBe('new 7f0c2d3e')
    expect(schemaOf(PH)).toBe('placeholder')
    expect(nameOf(A)).toBe('orders')
    expect(schemaOf(A)).toBe('main.sales')
  })
})

describe('edge kinds', () => {
  it('knows which kinds are derived', () => {
    expect(['fk', 'lineage', 'view_dep'].every((k) => isDerivedKind(k as GraphEdge['kind']))).toBe(true)
    expect(isDerivedKind('join_mined')).toBe(false)
  })
})

describe('graph store with relationships', () => {
  const resp = (note: string, status: GraphEdge['status'] = 'accepted') => ({
    nodes: [
      { id: A, label: 'orders', kind: 'table', focus: true },
      { id: B, label: 'customers', kind: 'table' },
    ],
    edges: [{ id: 'e_1', source: A, target: B, kind: 'manual' as const, status, note, directed: true }],
    errors: [],
  })

  it('refreshes the info of an edge that is already on screen, without moving anything', () => {
    const store = useGraphStore.getState()
    store.clear()
    store.mergeRelations(resp('first'))
    store.applyNodeChanges([{ id: A, type: 'position', position: { x: 50, y: 60 } }])
    useGraphStore.getState().mergeRelations(resp('second', 'rejected'))
    const s = useGraphStore.getState()
    expect(s.edges).toHaveLength(1)
    expect(s.edges[0].data!.info.note).toBe('second')
    expect(s.edges[0].data!.info.status).toBe('rejected')
    expect(s.nodes.find((n) => n.id === A)!.position).toEqual({ x: 50, y: 60 })
    store.clear()
  })

  it('updates one edge after a review', () => {
    const store = useGraphStore.getState()
    store.clear()
    store.mergeRelations(resp(''))
    useGraphStore.getState().updateEdgeInfo('e_1', { status: 'rejected', note: 'wrong' })
    const info = useGraphStore.getState().edges[0].data!.info
    expect([info.status, info.note, info.kind]).toEqual(['rejected', 'wrong', 'manual'])
    store.clear()
  })

  it('has every kind on, and rejected and superseded edges off, by default', () => {
    expect(DEFAULT_FILTERS.showRejected).toBe(false)
    expect(DEFAULT_FILTERS.showSuperseded).toBe(false)
    expect(Object.entries(DEFAULT_FILTERS).filter(([k]) => !k.startsWith('show')).every(([, v]) => v)).toBe(true)
  })
})

describe('saved diagrams with the new edge fields', () => {
  it('round-trips status, note and kind through save and load', () => {
    const info: GraphEdge = {
      id: 'e_1',
      source: A,
      target: B,
      kind: 'concept_link',
      directed: false,
      status: 'proposed',
      note: 'n',
      patch_ids: ['e_1'],
    }
    const nodes = [node(A, true), node(B)]
    const body = toDiagramBody('rt', { nodes, edges: [flowEdge(info)], focusSchema: 'main.sales' })
    const back = fromDiagram({ saved_at: 'now', ...body })
    expect(back.edges[0].data!.info).toEqual(info)
  })

  it('still loads a diagram saved before the store existed', () => {
    const back = fromDiagram({
      name: 'old',
      saved_at: 'x',
      focus_schema: 'main.sales',
      nodes: [
        { data: { id: A, label: 'orders', focus: true }, position: { x: 0, y: 0 } },
        { data: { id: B, label: 'customers' }, position: { x: 100, y: 0 } },
      ],
      edges: [{ data: { id: `fk:${A}->${B}`, source: A, target: B, kind: 'fk', child_columns: ['cust_id'] } }],
    })
    const info = back.edges[0].data!.info
    expect(info.status).toBeUndefined()
    expect(patchIds(info)).toEqual([`fk:${A}->${B}`])
  })
})
