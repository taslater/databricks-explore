import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphEdgeKind } from '../api/types'
import { deriveFlow, edgeShown } from './derive'
import { edgeSource } from './edgeSource'
import { legendOf } from './EdgeFamilies'
import { edgeStyle, FAMILY_OF, FAMILIES, isInferred, KINDS_OF } from './edgeStyles'
import { computeLayout, type LayoutEdge, type LayoutNode } from './layout'
import { DEFAULT_FILTERS } from './graphStore'
import type { FlowEdge, FlowNode } from './types'

const S = 'main.sales'
const node = (id: string, focus = false): FlowNode => ({
  id,
  type: 'table',
  position: { x: 0, y: 0 },
  data: { name: id.split('.')[2], schema: S, kind: 'table', focus, selfRef: false },
})
const info = (kind: GraphEdgeKind, extra: Partial<GraphEdge> = {}): GraphEdge => ({
  id: `${kind}:1`,
  source: `${S}.a`,
  target: `${S}.b`,
  kind,
  status: 'derived',
  ...extra,
})
const flowEdge = (i: GraphEdge): FlowEdge => ({ id: i.id, source: i.source, target: i.target, data: { info: i } })

describe('edge families', () => {
  it('maps every kind to one family, and the family lists agree', () => {
    expect(FAMILY_OF).toEqual({
      lineage: 'flow',
      view_dep: 'flow',
      fk: 'reference',
      join_mined: 'reference',
      manual: 'reference',
      sketch: 'meaning',
      concept_link: 'meaning',
      ontology: 'meaning',
    })
    for (const f of FAMILIES) for (const k of KINDS_OF[f]) expect(FAMILY_OF[k]).toBe(f)
    expect(FAMILIES.flatMap((f) => KINDS_OF[f]).sort()).toEqual(Object.keys(FAMILY_OF).sort())
  })

  it('dashes an edge only when it is proposed', () => {
    expect(isInferred(info('join_mined', { status: 'proposed' }))).toBe(true)
    for (const s of ['derived', 'accepted', 'superseded', 'rejected'] as const) expect(isInferred(info('fk', { status: s }))).toBe(false)
    expect(edgeStyle('reference', false).strokeDasharray).toBeUndefined()
    expect(edgeStyle('reference', true).strokeDasharray).toBeDefined()
    expect(edgeStyle('flow', true, true).stroke).toBe('var(--edge-superseded)') // superseded wins
    // Flow is the strongest line, meaning the lightest.
    expect(edgeStyle('flow', false).strokeWidth!).toBeGreaterThan(edgeStyle('reference', false).strokeWidth!)
    expect(edgeStyle('reference', false).strokeWidth!).toBeGreaterThan(edgeStyle('meaning', false).strokeWidth!)
  })

  it('shows meaning edges only when the family is on, and any edge only when its family and kind are on', () => {
    expect(edgeShown(info('sketch'), DEFAULT_FILTERS)).toBe(false)
    expect(edgeShown(info('sketch'), { ...DEFAULT_FILTERS, meaning: true })).toBe(true)
    expect(edgeShown(info('fk'), { ...DEFAULT_FILTERS, reference: false })).toBe(false)
    expect(edgeShown(info('fk'), { ...DEFAULT_FILTERS, fk: false })).toBe(false)
    expect(edgeShown(info('manual'), { ...DEFAULT_FILTERS, fk: false })).toBe(true)
  })

  it('draws a view dependency, a foreign key and a mined join as two line types, the mined one dashed', () => {
    const A = node(`${S}.a`, true)
    const B = node(`${S}.b`)
    const C = node(`${S}.c`)
    const D = node(`${S}.d`)
    const edges = [
      flowEdge(info('view_dep', { id: 'v', source: B.id, target: A.id })),
      flowEdge(info('fk', { id: 'f', source: A.id, target: C.id })),
      flowEdge(info('join_mined', { id: 'j', source: A.id, target: D.id, status: 'proposed' })),
    ]
    const out = deriveFlow({ nodes: [A, B, C, D], edges, focusSchema: S, filters: DEFAULT_FILTERS, hoverId: null })
    expect(out.edges.map((e) => e.type)).toEqual(['flow', 'reference', 'reference'])
    expect(out.edges.map((e) => !!e.markerEnd)).toEqual([true, false, false])
    const legend = legendOf(edges.map((e) => e.data!.info))
    expect(legend).toEqual({ families: ['flow', 'reference'], inferred: true, superseded: false })
  })

  it('lists only what is on screen in the legend', () => {
    expect(legendOf([])).toEqual({ families: [], inferred: false, superseded: false })
    expect(legendOf([info('lineage')])).toEqual({ families: ['flow'], inferred: false, superseded: false })
    expect(legendOf([info('lineage', { status: 'superseded' })])).toEqual({ families: [], inferred: false, superseded: true })
    // A meaning edge is dotted already, so it adds no dashed entry.
    expect(legendOf([info('sketch', { status: 'proposed' })])).toEqual({ families: ['meaning'], inferred: false, superseded: false })
  })
})

describe('edgeSource', () => {
  it('names the fact each kind stands on', () => {
    expect(edgeSource(info('fk', { constraint: 'fk_orders_customer' }))).toBe('foreign key constraint `fk_orders_customer`')
    expect(edgeSource(info('view_dep', { target: `${S}.v_daily_revenue` }))).toBe('definition of view `v_daily_revenue`')
    expect(edgeSource(info('lineage', { last_seen: '2026-11-14 10:00:00.0' }))).toBe('Unity Catalog lineage, last seen 2026-11-14')
    expect(edgeSource(info('manual'))).toBe('drawn by you')
    expect(edgeSource(info('sketch', { provenance: { origin: 'sketch', source_ref: 'Plan' } }))).toBe('sketched on canvas Plan')
  })

  it('states mined runs on a column edge only, since a table edge adds up its column pairs', () => {
    const evidence = { runs: 213, users: 9, last_seen: '2026-11-14T08:00:00Z', sample_refs: [] }
    expect(edgeSource(info('join_mined', { evidence, source_column: 'id', target_column: 'id' }))).toBe(
      'mined from 213 runs by 9 users, last on 2026-11-14',
    )
    expect(edgeSource(info('join_mined', { evidence }))).toBe('mined from query history, last on 2026-11-14')
  })
})

describe('layout by family', () => {
  const box = (id: string, focus = false): LayoutNode => ({ id, width: 100, height: 40, focus, x: 0, y: 0 })

  it('hangs a table reached only by a mined or manual join below the table it joins, not to its right', async () => {
    for (const kind of ['join_mined', 'manual', 'fk']) {
      const pos = await computeLayout([box('O', true), box('C')], [{ source: 'O', target: 'C', kind }])
      expect(pos.get('C')!.x, kind).toBe(pos.get('O')!.x)
      expect(pos.get('C')!.y, kind).toBeGreaterThan(pos.get('O')!.y + 40)
    }
  })

  it('lets only flow edges set the rank: a flow chain goes left to right, a table joined to its end by a reference is not pushed right', async () => {
    const nodes = [box('A', true), box('B', true), box('R', true)]
    const edges: LayoutEdge[] = [
      { source: 'A', target: 'B', kind: 'lineage' },
      { source: 'B', target: 'R', kind: 'join_mined' },
    ]
    const pos = await computeLayout(nodes, edges)
    expect(pos.get('B')!.x).toBeGreaterThan(pos.get('A')!.x)
    expect(pos.get('R')!.x).toBeLessThan(pos.get('B')!.x)
  })

  it('keeps two pinned tables that only a reference joins in one column', async () => {
    const pos = await computeLayout([box('O', true), box('C', true)], [{ source: 'O', target: 'C', kind: 'fk' }])
    expect(pos.get('C')!.x).toBe(pos.get('O')!.x)
  })
})
