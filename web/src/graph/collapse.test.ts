import { describe, expect, it } from 'vitest'
import type { EdgeTransform } from '../api/edgeTransforms'
import type { GraphEdgeKind } from '../api/types'
import { collapseGraph, groupingBody, mergeTransforms, parseGrouping, withMergedTransforms, DEFAULT_GROUPING, type Grouping } from './collapse'
import { fromDiagram, toDiagramBody } from './diagram'
import { graphSignature } from './diagramSync'
import { DEFAULT_FILTERS } from './graphStore'
import { layoutInput } from './layoutInput'
import type { FlowEdge, FlowNode } from './types'

const node = (id: string, kind = 'table', extra: Partial<FlowNode['data']> = {}): FlowNode => {
  const parts = id.split('.')
  return { id, type: 'table', position: { x: 0, y: 0 }, data: { name: parts[2], schema: parts.slice(0, 2).join('.'), kind, focus: false, selfRef: false, ...extra } }
}
const edge = (source: string, target: string, kind: GraphEdgeKind = 'lineage'): FlowEdge => ({
  id: `${kind}:${source}>${target}`,
  source,
  target,
  data: { info: { id: `${kind}:${source}>${target}`, source, target, kind } },
})
const run = (nodes: FlowNode[], edges: FlowEdge[], grouping: Grouping = DEFAULT_GROUPING, filters = DEFAULT_FILTERS) => collapseGraph({ nodes, edges, filters, grouping })

/** Ten tables in lake.bronze, two in lake.silver, one view and one table in lake.gold. */
function lake() {
  const bronze = Array.from({ length: 10 }, (_, i) => node(`lake.bronze.t${i}`))
  const silver = [node('lake.silver.a'), node('lake.silver.b')]
  const gold = [node('lake.gold.v'), node('lake.gold.w')]
  const edges = [
    ...bronze.slice(0, 5).map((b) => edge(b.id, 'lake.silver.a')),
    ...bronze.slice(5).map((b) => edge(b.id, 'lake.silver.b')),
    edge('lake.silver.a', 'lake.gold.v'),
    edge('lake.silver.b', 'lake.gold.w'),
  ]
  return { nodes: [...bronze, ...silver, ...gold], edges }
}

describe('groups', () => {
  it('collapses a group of more than eight and leaves the small ones open, in boxes', () => {
    const { nodes, edges } = lake()
    const v = run(nodes, edges)
    const byKey = Object.fromEntries(v.groups.map((g) => [g.key, g]))
    expect(byKey['lake.bronze'].collapsed).toBe(true)
    expect(byKey['lake.bronze'].label).toBe('bronze')
    expect(byKey['lake.bronze'].members).toHaveLength(10)
    expect(byKey['lake.silver'].collapsed).toBe(false)
    expect(byKey['lake.silver'].boxed).toBe(true)
    expect(v.hidden.size).toBe(10)
    expect(v.nodes.find((n) => n.id === 'summary:lake.bronze')?.data.summary).toMatchObject({ count: 10, noun: 'table' })
  })

  it('merges the edges of a collapsed group into one per outside node and counts them', () => {
    const { nodes, edges } = lake()
    const v = run(nodes, edges)
    const merged = v.edges.filter((e) => e.data!.merged)
    expect(merged.map((e) => [e.source, e.target, e.data!.merged!.count]).sort()).toEqual([
      ['summary:lake.bronze', 'lake.silver.a', 5],
      ['summary:lake.bronze', 'lake.silver.b', 5],
    ])
    // The other edges are untouched.
    expect(v.edges.filter((e) => !e.data!.merged && !v.hidden.has(e.source))).toHaveLength(2)
  })

  it('an edge between two members of a collapsed group disappears, and one group is no summary', () => {
    const { nodes } = lake()
    const inside = [edge('lake.bronze.t0', 'lake.bronze.t1')]
    expect(run(nodes, inside).edges.filter((e) => e.data!.merged)).toHaveLength(0)
    const oneSchema = nodes.filter((n) => n.data.schema === 'lake.bronze')
    const v = run(oneSchema, [])
    expect(v.groups).toHaveLength(0)
    expect(v.hidden.size).toBe(0)
  })

  it('keeps a group open when it holds the focus or a pinned table, and an override wins either way', () => {
    const { nodes, edges } = lake()
    const focused = nodes.map((n) => (n.id === 'lake.bronze.t3' ? { ...n, data: { ...n.data, focus: true } } : n))
    expect(run(focused, edges).groups.find((g) => g.key === 'lake.bronze')?.collapsed).toBe(false)
    expect(run(nodes, edges, { ...DEFAULT_GROUPING, overrides: { 'lake.bronze': false } }).groups.find((g) => g.key === 'lake.bronze')?.collapsed).toBe(false)
    expect(run(nodes, edges, { ...DEFAULT_GROUPING, overrides: { 'lake.silver': true } }).groups.find((g) => g.key === 'lake.silver')?.collapsed).toBe(true)
  })

  it('counts what the filters show: a member whose only edges are hidden is not counted', () => {
    const { nodes, edges } = lake()
    const withFk = [...edges, edge('lake.bronze.t0', 'lake.bronze.t9', 'fk')]
    const noRefs = { ...DEFAULT_FILTERS, reference: false }
    // Every bronze table still has a flow edge, so all ten count; a table with only a hidden edge does not.
    expect(run(nodes, withFk, DEFAULT_GROUPING, noRefs).groups.find((g) => g.key === 'lake.bronze')?.members).toHaveLength(10)
    const extra = [...nodes, node('lake.bronze.t10')]
    const only = [...edges, edge('lake.bronze.t10', 'lake.bronze.t0', 'fk')]
    expect(run(extra, only, DEFAULT_GROUPING, noRefs).groups.find((g) => g.key === 'lake.bronze')?.members).toHaveLength(10)
    expect(run(extra, only).groups.find((g) => g.key === 'lake.bronze')?.members).toHaveLength(11)
  })

  it('keeps a table on a column trace out of its collapsed group, and its view out of a chain', () => {
    const { nodes, edges } = lake()
    const traced = nodes.map((n) => (n.id === 'lake.bronze.t3' ? { ...n, data: { ...n.data, traced: ['id'] } } : n))
    const v = run(traced, edges)
    expect(v.groups.find((g) => g.key === 'lake.bronze')?.collapsed).toBe(false)
    const pinned = run(traced, edges, { ...DEFAULT_GROUPING, overrides: { 'lake.bronze': true } })
    expect(pinned.hidden.has('lake.bronze.t3')).toBe(false)
    expect(pinned.hidden.size).toBe(9)
    const c = [node('d.s.a'), node('d.s.v', 'view', { traced: ['x'] }), node('d.s.b')]
    expect(run(c, [edge('d.s.a', 'd.s.v'), edge('d.s.v', 'd.s.b')]).chains).toHaveLength(0)
  })

  it('groups by a tag, and not at all', () => {
    const { nodes, edges } = lake()
    const tags = Object.fromEntries(nodes.map((n, i) => [n.id, i % 2 ? 'pii' : 'plain']))
    const v = collapseGraph({ nodes, edges, filters: DEFAULT_FILTERS, grouping: { ...DEFAULT_GROUPING, by: 'tag:class' }, groupTags: tags })
    expect(v.groups.map((g) => g.key).sort()).toEqual(['pii', 'plain'])
    expect(run(nodes, edges, { ...DEFAULT_GROUPING, by: 'none', chains: false }).groups).toHaveLength(0)
  })

  it('hands the layout the collapsed group as one node and the open ones as boxes', () => {
    const { nodes, edges } = lake()
    const input = layoutInput(
      { nodes, edges, columnEdges: [], focusSchema: null, filters: DEFAULT_FILTERS, grouping: DEFAULT_GROUPING },
      new Set(),
    )
    const ids = input.nodes.map((n) => n.id)
    expect(ids).toContain('summary:lake.bronze')
    expect(ids).not.toContain('lake.bronze.t0')
    expect(input.nodes.find((n) => n.id === 'lake.silver.a')?.group).toBe('lake.silver')
    expect(input.links.filter((l) => l.source === 'summary:lake.bronze')).toHaveLength(2)
  })
})

describe('chains', () => {
  const chain = () => ({
    nodes: [node('d.s.src'), node('d.s.v1', 'view'), node('d.s.v2', 'materialized_view'), node('d.s.dst')],
    edges: [edge('d.s.src', 'd.s.v1', 'view_dep'), edge('d.s.v1', 'd.s.v2', 'view_dep'), edge('d.s.v2', 'd.s.dst', 'lineage')],
  })

  it('draws table, view, view, table as one edge via 2 views', () => {
    const { nodes, edges } = chain()
    const v = run(nodes, edges)
    expect(v.chains).toHaveLength(1)
    expect(v.hidden).toEqual(new Set(['d.s.v1', 'd.s.v2']))
    const e = v.edges.find((x) => x.data!.merged)!
    expect([e.source, e.target]).toEqual(['d.s.src', 'd.s.dst'])
    expect(e.data!.merged).toMatchObject({ views: 2, count: 1, chain: v.chains[0].id, viaNodes: ['d.s.v1', 'd.s.v2'] })
  })

  it('leaves a view with a second reader, a pinned one, and one with a reference alone', () => {
    const { nodes, edges } = chain()
    expect(run([...nodes, node('d.s.other')], [...edges, edge('d.s.v1', 'd.s.other', 'view_dep')]).chains.map((c) => c.views)).toEqual([['d.s.v2']])
    expect(run(nodes.map((n) => (n.id === 'd.s.v1' ? { ...n, data: { ...n.data, pinned: true } } : n)), edges).chains.map((c) => c.views)).toEqual([['d.s.v2']])
    expect(run(nodes, [...edges, edge('d.s.v1', 'd.s.dst', 'fk')]).chains.map((c) => c.views)).toEqual([['d.s.v2']])
    expect(run(nodes, edges, { ...DEFAULT_GROUPING, chains: false }).chains).toHaveLength(0)
  })

  it('does not elide when the ends are already joined, or in a ring, and an opened chain draws its views', () => {
    const { nodes, edges } = chain()
    expect(run(nodes, [...edges, edge('d.s.src', 'd.s.dst')]).chains).toHaveLength(0)
    const ring = [node('d.s.v1', 'view'), node('d.s.v2', 'view')]
    expect(run(ring, [edge('d.s.v1', 'd.s.v2'), edge('d.s.v2', 'd.s.v1')]).chains).toHaveLength(0)
    const v = run(nodes, edges)
    const open = run(nodes, edges, { ...DEFAULT_GROUPING, shownChains: [v.chains[0].id] })
    expect(open.hidden.size).toBe(0)
    expect(open.edges.filter((e) => e.data!.merged)).toHaveLength(0)
  })

  it('carries the transforms of the elided edges to the merged one', () => {
    const t = (glyphs: EdgeTransform['glyphs']): EdgeTransform => ({ driving: true, joined: null, union: null, filters: [], aggregate: null, dedupe: null, distinct: false, window: false, pivot: false, merge: null, glyphs, statement: 'select' })
    const { nodes, edges } = chain()
    const v = run(nodes, edges)
    const answer = { origins: {}, edges: { [edges[0].id]: { transform: t(['join']), note: null, error: null }, [edges[2].id]: { transform: t(['aggregate']), note: null, error: null } } }
    const out = withMergedTransforms(v.edges, answer).find((e) => e.data!.merged)!
    expect(out.data!.transform?.glyphs).toEqual(['aggregate', 'join'])
    expect(mergeTransforms([])).toBeUndefined()
  })
})

describe('saved grouping', () => {
  it('goes through a saved diagram, and changing it makes the graph dirty', () => {
    const { nodes, edges } = lake()
    const grouping: Grouping = { ...DEFAULT_GROUPING, overrides: { 'lake.bronze': false }, shownChains: ['chain:x'] }
    const body = toDiagramBody('g', { nodes, edges, focusSchema: null, grouping })
    expect(body.grouping).toEqual({ expanded: ['lake.bronze'] })
    expect(fromDiagram({ ...body, saved_at: '' }).grouping).toEqual({ ...grouping, shownChains: [] })
    expect(toDiagramBody('g', { nodes, edges, focusSchema: null, grouping: DEFAULT_GROUPING })).not.toHaveProperty('grouping')
    expect(graphSignature(nodes, edges, null, 'type', grouping)).not.toBe(graphSignature(nodes, edges, null, 'type'))
    expect(graphSignature(nodes, edges, null, 'type', DEFAULT_GROUPING)).toBe(graphSignature(nodes, edges, null))
  })

  it('writes nothing for the default and reads what it wrote', () => {
    expect(groupingBody(DEFAULT_GROUPING)).toBeUndefined()
    const g: Grouping = { by: 'tag:domain', overrides: { a: true, b: false }, chains: false, shownChains: ['x'] }
    const body = groupingBody(g)!
    expect(body).toEqual({ by: 'tag:domain', collapsed: ['a'], expanded: ['b'], chains: false })
    expect(parseGrouping(body)).toEqual({ ...g, shownChains: [] })
    expect(parseGrouping(undefined)).toEqual(DEFAULT_GROUPING)
    expect(parseGrouping({ by: 'junk' }).by).toBe('schema')
  })
})
