import { describe, expect, it } from 'vitest'
import type { DiagramFile, GraphEdge } from '../api/types'
import { fromDiagram, toDiagramBody } from './diagram'
import { deriveFlow } from './derive'
import { ageDays, parseTs, shortType } from './format'
import { computeLayout, type LayoutEdge, type LayoutNode } from './layout'
import { DEFAULT_FILTERS, useGraphStore } from './graphStore'
import type { EdgeFilters, FlowEdge, FlowNode } from './types'

const ALL_ON: EdgeFilters = { ...DEFAULT_FILTERS }
const NOW = Date.parse('2026-11-11T00:00:00Z')

function flowNode(id: string, extra: Partial<FlowNode['data']> = {}): FlowNode {
  const parts = id.split('.')
  return {
    id,
    type: 'table',
    position: { x: 0, y: 0 },
    data: {
      name: parts[2] ?? id,
      schema: parts.slice(0, 2).join('.'),
      kind: 'table',
      focus: false,
      selfRef: false,
      ...extra,
    },
  }
}

function flowEdge(info: GraphEdge): FlowEdge {
  return { id: info.id, source: info.source, target: info.target, data: { info } }
}

const S = 'main.sales'

describe('layout (legacy relayout rules)', () => {
  const box = (id: string, focus = false, w = 100, h = 40): LayoutNode => ({ id, width: w, height: h, focus, x: 0, y: 0 })

  it('places an FK-only parent in a row under its child, centered', () => {
    const nodes = [box('F', true), box('L'), box('P', false, 80)]
    const edges: LayoutEdge[] = [
      { source: 'F', target: 'L', kind: 'lineage' },
      { source: 'F', target: 'P', kind: 'fk' },
    ]
    const pos = computeLayout(nodes, edges)
    const F = pos.get('F')!
    const L = pos.get('L')!
    const P = pos.get('P')!
    const bottom = Math.max(F.y + 40, L.y + 40)
    expect(P.y).toBe(bottom + 90 - 20)
    // P's center sits under F's center.
    expect(P.x + 40).toBe(F.x + 50)
    // Lineage runs left to right (LR).
    expect(L.x).toBeGreaterThan(F.x)
  })

  it('spaces several FK-only parents under one child with a 24px gap', () => {
    const nodes = [box('F', true), box('P1', false, 80), box('P2', false, 60)]
    const edges: LayoutEdge[] = [
      { source: 'F', target: 'P1', kind: 'fk' },
      { source: 'F', target: 'P2', kind: 'fk' },
    ]
    const pos = computeLayout(nodes, edges)
    const F = pos.get('F')!
    const P1 = pos.get('P1')!
    const P2 = pos.get('P2')!
    expect(P2.x - P1.x).toBe(80 + 24)
    // The whole row (P1 left edge to P2 right edge) is centered under F.
    expect((P1.x + P2.x + 60) / 2).toBeCloseTo(F.x + 50)
  })

  it('never treats the focus node as FK-only, even if all its edges are FK', () => {
    const nodes = [box('F', true), box('P')]
    const pos = computeLayout(nodes, [{ source: 'F', target: 'P', kind: 'fk' }])
    // F is in the main layout (dagre), so its y comes from rank placement at the top, not the FK row.
    expect(pos.get('F')!.y).toBeLessThan(pos.get('P')!.y)
  })

  it('keeps an incoming-FK-only node at its current x (legacy child = source quirk)', () => {
    // C references the focus table F, so the first edge's source (the child) is C itself.
    const nodes: LayoutNode[] = [box('F', true), { ...box('C', false, 80), x: 300, y: 0 }]
    const pos = computeLayout(nodes, [{ source: 'C', target: 'F', kind: 'fk' }])
    // Centered on its own current center (300 + 40), so top-left x is unchanged.
    expect(pos.get('C')!.x).toBe(300)
  })
})

describe('deriveFlow', () => {
  const F = flowNode(`${S}.orders`, { focus: true })
  const A = flowNode(`${S}.raw`)
  const B = flowNode(`${S}.report`)
  const C = flowNode('main.other.x')

  it('marks lineage older than staleDays as stale, hides it when showStale is off', () => {
    const edge = flowEdge({
      id: `lineage:${S}.orders<->${S}.raw`,
      source: `${S}.orders`,
      target: `${S}.raw`,
      kind: 'lineage',
      last_seen: '2026-10-01 00:00:00.0',
    })
    const base = { nodes: [F, A], edges: [edge], focusSchema: S, staleDays: 7, hoverId: null, now: NOW }

    const shown = deriveFlow({ ...base, filters: ALL_ON })
    expect(shown.edges[0].type).toBe('stale')
    expect(shown.edges[0].data!.stale).toBe(true)
    expect(shown.edges[0].hidden).toBe(false)

    const hidden = deriveFlow({ ...base, filters: { ...ALL_ON, showStale: false } })
    expect(hidden.edges[0].hidden).toBe(true)
    // A has only hidden edges and is not the focus, so A hides too. F stays.
    expect(hidden.nodes.find((n) => n.id === A.id)!.hidden).toBe(true)
    expect(hidden.nodes.find((n) => n.id === F.id)!.hidden).toBe(false)
  })

  it('keeps fresh lineage as lineage', () => {
    const edge = flowEdge({
      id: `lineage:${S}.orders<->${S}.raw`,
      source: `${S}.orders`,
      target: `${S}.raw`,
      kind: 'lineage',
      last_seen: '2026-11-10 00:00:00.0',
    })
    const out = deriveFlow({ nodes: [F, A], edges: [edge], focusSchema: S, filters: ALL_ON, staleDays: 7, hoverId: null, now: NOW })
    expect(out.edges[0].type).toBe('lineage')
    expect(out.edges[0].data!.stale).toBe(false)
  })

  it('hides FK-only neighbors when the fk filter is off, but never hides the focus', () => {
    const fk = flowEdge({ id: `fk:${S}.orders->${S}.customers`, source: `${S}.orders`, target: `${S}.customers`, kind: 'fk', child_columns: ['cust_id'] })
    const cust = flowNode(`${S}.customers`)
    const out = deriveFlow({
      nodes: [F, cust],
      edges: [fk],
      focusSchema: S,
      filters: { ...ALL_ON, fk: false },
      staleDays: 7,
      hoverId: null,
      now: NOW,
    })
    expect(out.edges[0].hidden).toBe(true)
    expect(out.nodes.find((n) => n.id === cust.id)!.hidden).toBe(true)
    expect(out.nodes.find((n) => n.id === F.id)!.hidden).toBe(false)
  })

  it('labels an FK parent with the child columns (via) and marks other-schema nodes external', () => {
    const fk = flowEdge({ id: `fk:${S}.orders->${S}.customers`, source: `${S}.orders`, target: `${S}.customers`, kind: 'fk', child_columns: ['cust_id', 'region'] })
    const cust = flowNode(`${S}.customers`)
    const other = flowNode('main.other.x')
    const out = deriveFlow({ nodes: [F, cust, other], edges: [fk], focusSchema: S, filters: ALL_ON, staleDays: 7, hoverId: null, now: NOW })
    const byId = (id: string) => out.nodes.find((n) => n.id === id)!
    expect(byId(cust.id).data.via).toBe('cust_id, region')
    expect(byId(F.id).data.via).toBeUndefined()
    expect(byId(other.id).data.external).toBe(true)
    expect(byId(other.id).data.showSchema).toBe(true)
    expect(byId(F.id).data.external).toBe(false)
  })

  it('fades non-neighbors and edges that do not touch the hovered node', () => {
    const e1 = flowEdge({ id: 'l1', source: F.id, target: A.id, kind: 'lineage', last_seen: '2026-11-10 00:00:00.0' })
    const e2 = flowEdge({ id: 'l2', source: A.id, target: B.id, kind: 'lineage', last_seen: '2026-11-10 00:00:00.0' })
    const out = deriveFlow({ nodes: [F, A, B, C], edges: [e1, e2], focusSchema: S, filters: ALL_ON, staleDays: 7, hoverId: F.id, now: NOW })
    const node = (id: string) => out.nodes.find((n) => n.id === id)!
    expect(node(F.id).data.faded).toBe(false)
    expect(node(A.id).data.faded).toBe(false)
    expect(node(B.id).data.faded).toBe(true)
    expect(node(C.id).data.faded).toBe(true)
    expect(out.edges.find((e) => e.id === 'l1')!.data!.faded).toBe(false)
    expect(out.edges.find((e) => e.id === 'l2')!.data!.faded).toBe(true)
  })

  it('adds a start marker for bidirectional lineage', () => {
    const e = flowEdge({ id: 'l1', source: F.id, target: A.id, kind: 'lineage', bidir: true, last_seen: '2026-11-10 00:00:00.0' })
    const out = deriveFlow({ nodes: [F, A], edges: [e], focusSchema: S, filters: ALL_ON, staleDays: 7, hoverId: null, now: NOW })
    expect(out.edges[0].markerStart).toBeDefined()
    expect(out.edges[0].markerEnd).toBeDefined()
  })
})

describe('timestamps and labels', () => {
  it('parses the Databricks lineage format and ISO strings', () => {
    expect(ageDays('2026-10-26 14:02:52.0', NOW)).toBe(15)
    expect(ageDays('2026-11-10T00:00:00Z', NOW)).toBe(1)
    expect(Number.isNaN(parseTs(undefined))).toBe(true)
    expect(ageDays(null, NOW)).toBeNull()
  })

  it('shortens picker type tags like the legacy list', () => {
    expect(shortType('MATERIALIZED_VIEW')).toBe('mv')
    expect(shortType('STREAMING_TABLE')).toBe('streaming')
    expect(shortType('MANAGED')).toBe('')
    expect(shortType('VIEW')).toBe('view')
    expect(shortType(null)).toBe('')
  })
})

describe('saved diagrams', () => {
  it('reads a diagram written by the legacy UI', () => {
    const legacy = {
      name: 'orders',
      saved_at: '2026-11-01T10:00:00+00:00',
      focus_schema: `${S}`,
      nodes: [
        { data: { id: `${S}.orders`, label: 'orders', kind: 'table', focus: true, external: false, display: 'orders' }, position: { x: 100, y: 50 } },
        { data: { id: 'main.other.customers', label: 'customers', kind: 'view', external: true, via: 'cust_id' }, position: { x: 300, y: 200 } },
      ],
      edges: [
        {
          data: {
            id: `fk:${S}.orders->main.other.customers`,
            source: `${S}.orders`,
            target: 'main.other.customers',
            kind: 'fk',
            constraint: 'fk_cust',
            child_columns: ['cust_id'],
            parent_columns: ['id'],
            label: 'cust_id',
          },
        },
      ],
    } as DiagramFile

    const payload = fromDiagram(legacy)
    expect(payload.focusSchema).toBe(S)
    expect(payload.nodes.map((n) => n.id)).toEqual([`${S}.orders`, 'main.other.customers'])
    expect(payload.nodes[0].data.focus).toBe(true)
    expect(payload.nodes[1].data.kind).toBe('view')
    expect(payload.edges).toHaveLength(1)
    expect(payload.edges[0].data!.info.kind).toBe('fk')
    expect(payload.edges[0].data!.info.child_columns).toEqual(['cust_id'])
  })

  it('round-trips through the saved format with the same nodes, flags, and edges', () => {
    const nodes = [flowNode(`${S}.orders`, { focus: true, selfRef: true, selfRefLastSeen: '2026-11-10 00:00:00.0' }), flowNode('main.other.x')]
    const edges = [flowEdge({ id: 'l1', source: `${S}.orders`, target: 'main.other.x', kind: 'lineage', last_seen: '2026-11-10 00:00:00.0' })]
    const body = toDiagramBody('rt', { nodes, edges, focusSchema: S })
    expect(body.focus_schema).toBe(S)
    const back = fromDiagram({ saved_at: 'now', ...body })
    expect(back.nodes.map((n) => n.id)).toEqual(nodes.map((n) => n.id))
    expect(back.nodes[0].data.focus).toBe(true)
    expect(back.nodes[0].data.selfRef).toBe(true)
    expect(back.nodes[0].data.selfRefLastSeen).toBe('2026-11-10 00:00:00.0')
    expect(back.edges[0].data!.info.kind).toBe('lineage')
  })

  it('skips malformed entries instead of throwing', () => {
    const payload = fromDiagram({
      name: 'bad',
      saved_at: 'x',
      nodes: [{ nope: true }, { data: { id: `${S}.a` }, position: { x: 0, y: 0 } }],
      edges: [{ data: { id: 'e1', source: `${S}.a`, target: `${S}.missing`, kind: 'lineage' } }],
    } as DiagramFile)
    expect(payload.nodes.map((n) => n.id)).toEqual([`${S}.a`])
    expect(payload.edges).toHaveLength(0)
  })
})

describe('graph store merge (legacy addGraph)', () => {
  it('keeps the focus flag on the first batch only, skips duplicates, drops edges with missing ends', () => {
    const store = useGraphStore.getState()
    store.clear()
    store.mergeRelations({
      nodes: [
        { id: `${S}.a`, label: 'a', kind: 'table', focus: true },
        { id: `${S}.b`, label: 'b', kind: 'view' },
      ],
      edges: [{ id: 'l1', source: `${S}.a`, target: `${S}.b`, kind: 'lineage' }],
      errors: [],
    })
    let s = useGraphStore.getState()
    expect(s.nodes.find((n) => n.id === `${S}.a`)!.data.focus).toBe(true)
    expect(s.nodes.find((n) => n.id === `${S}.b`)!.data.focus).toBe(false)
    expect(s.layoutPending).toBe(true)

    // Expansion from b: a already exists, c is new, and the edge to "ghost" has no node.
    useGraphStore.getState().mergeRelations({
      nodes: [
        { id: `${S}.a`, label: 'a', kind: 'table', focus: true },
        { id: `${S}.c`, label: 'c', kind: 'table', self_ref: true, self_ref_last_seen: '2026-11-10 00:00:00.0' },
      ],
      edges: [
        { id: 'l2', source: `${S}.b`, target: `${S}.c`, kind: 'lineage' },
        { id: 'l3', source: `${S}.c`, target: `${S}.ghost`, kind: 'lineage' },
      ],
      errors: [],
    })
    s = useGraphStore.getState()
    expect(s.nodes.map((n) => n.id)).toEqual([`${S}.a`, `${S}.b`, `${S}.c`])
    expect(s.nodes.find((n) => n.id === `${S}.c`)!.data.focus).toBe(false)
    expect(s.edges.map((e) => e.id)).toEqual(['l1', 'l2'])
    store.clear()
  })
})
