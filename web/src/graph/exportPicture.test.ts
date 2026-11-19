import { describe, expect, it } from 'vitest'
import type { Cardinality, GraphEdge, GraphEdgeKind } from '../api/types'
import { colorNodes } from './colorBy'
import { DEFAULT_GROUPING } from './collapse'
import { ENDS_TEXT, dateLine, exportScene, factsReadDate, fileStem, frameMetrics, legendRows, pictureLegend, type LegendInput } from './exportPicture'
import { DEFAULT_FILTERS } from './graphStore'
import type { FlowEdge, FlowNode } from './types'

const S = 'main.sales'
const node = (name: string, extra: Partial<FlowNode['data']> = {}, hidden = false): FlowNode => ({
  id: `${S}.${name}`,
  type: 'table',
  position: { x: 0, y: 0 },
  hidden,
  data: { name, schema: S, kind: 'table', focus: false, selfRef: false, ...extra },
})
const info = (kind: GraphEdgeKind, extra: Partial<GraphEdge> = {}): GraphEdge => ({ id: `${kind}:${extra.target ?? 'b'}`, source: `${S}.a`, target: `${S}.b`, kind, status: 'derived', ...extra })
const ends: Record<string, Cardinality | null> = { 'fk:b': { source: { end: 'zero_many', basis: 'constraint', why: '' }, target: { end: 'one', basis: 'constraint', why: '' }, sentence: '' } }
const input = (over: Partial<LegendInput>): LegendInput => ({ edges: [], filters: DEFAULT_FILTERS, ends: undefined, nodes: [], colorBy: 'type', colors: null, ...over })
const texts = (i: LegendInput) => pictureLegend(i).map((l) => l.text)

describe('the legend of an exported picture', () => {
  it('lists only reference edges, the ends and the key markers for a reference-only graph with keys on', () => {
    const cols = [{ name: 'id', type: 'int', pk: true }, { name: 'b_id', type: 'int', fk: true }]
    const out = texts(input({ edges: [info('fk')], ends, nodes: [node('a', { showColumns: true, columns: cols }), node('b')] }))
    expect(out).toEqual(['key reference', ENDS_TEXT, 'key icon: primary key', 'arrow icon: foreign key', 'table'])
    expect(out.join()).not.toMatch(/data flows|dashed/)
  })

  it('adds dashed for an inferred edge, and flow when a flow edge is drawn', () => {
    const out = texts(input({ edges: [info('lineage'), info('join_mined', { status: 'proposed', target: `${S}.c` })] }))
    expect(out).toEqual(['data flows', 'key reference', 'dashed: inferred or proposed'])
  })

  it('leaves out the ends when no edge has one, and what the filters hide', () => {
    expect(texts(input({ edges: [info('fk')], ends: { 'fk:b': null } }))).toEqual(['key reference'])
    expect(texts(input({ edges: [info('lineage')], filters: { ...DEFAULT_FILTERS, flow: false } }))).toEqual([])
  })

  it('explains the fill by what it means, and skips hidden nodes', () => {
    const nodes = [node('a'), node('b', {}, true)]
    const colors = colorNodes('schema', [{ id: nodes[0].id, schema: S }], undefined)
    expect(pictureLegend(input({ nodes, colorBy: 'schema', colors })).map((l) => l.text)).toEqual([`schema: ${S}`])
    expect(texts(input({ nodes }))).toEqual(['table'])
  })
})

describe('the date of an exported picture', () => {
  it('is the oldest read among the evidence shown', () => {
    const edges = [info('fk', { provenance: { origin: 'unity_catalog', fetched_at: '2026-11-18T10:00:00Z' } }), info('lineage', { provenance: { origin: 'unity_catalog', fetched_at: '2026-11-12T09:00:00Z' } })]
    const facts = { t: { grain: null, stats: { fetched_at: '2026-11-15T00:00:00Z' } as never } }
    expect(factsReadDate(edges, facts)).toBe('2026-11-12')
    expect(factsReadDate([info('fk')], undefined)).toBeNull()
  })

  it('says when the facts were read, else when the picture was drawn', () => {
    expect(dateLine('2026-11-12', '2026-11-19')).toBe('Facts read 2026-11-12')
    expect(dateLine(null, '2026-11-19')).toBe('Exported 2026-11-19')
  })
})

describe('the frame around the picture', () => {
  it('puts three legend items in a row and a long line in a row of its own', () => {
    const item = (text: string) => ({ kind: 'text' as const, text })
    expect(legendRows([item('a'), item('b'), item('c'), item('d')]).map((r) => r.length)).toEqual([3, 1])
    expect(legendRows([item('a'), item(ENDS_TEXT), item('b'), item('c')]).map((r) => r.length)).toEqual([1, 1, 2])
    expect(legendRows([])).toEqual([])
  })

  it('grows with the caption and the legend rows', () => {
    expect(frameMetrics(800, 400, 0, false).rows).toBe(1)
    expect(frameMetrics(800, 400, 2, false).rows).toBe(2)
    expect(frameMetrics(800, 400, 1, true).header).toBeGreaterThan(frameMetrics(800, 400, 1, false).header)
    expect(frameMetrics(800, 400, 3, false).height).toBe(frameMetrics(800, 400, 3, false).header + 400 + frameMetrics(800, 400, 3, false).footer)
  })

  it('names the file after the title', () => {
    expect(fileStem('Order model, v2')).toBe('Order-model-v2')
    expect(fileStem('  ')).toBe('graph')
  })
})

describe('what an export draws', () => {
  const at = (schema: string, name: string, kind = 'table'): FlowNode => ({ id: `c.${schema}.${name}`, type: 'table', position: { x: 0, y: 0 }, data: { name, schema: `c.${schema}`, kind, focus: false, selfRef: false } })
  const link = (id: string, source: string, target: string, kind: GraphEdgeKind = 'lineage'): FlowEdge => ({ id, source, target, data: { info: { id, source, target, kind, status: 'derived' } } })
  const scene = (nodes: FlowNode[], edges: FlowEdge[], extra: Partial<Parameters<typeof exportScene>[0]> = {}) =>
    exportScene({ nodes, edges, columnEdges: [], focusSchema: null, filters: DEFAULT_FILTERS, grouping: DEFAULT_GROUPING, groupTags: {}, trace: null, ...extra })

  it('is a collapsed group as one node and its edges merged, as the canvas draws it', () => {
    const big = Array.from({ length: 10 }, (_, i) => at('big', `t${i}`))
    const small = [at('small', 'x'), at('small', 'y')]
    const out = scene([...big, ...small], [link('e1', 'c.big.t0', 'c.small.x'), link('e2', 'c.big.t1', 'c.small.x')])
    expect(out.nodes.map((n) => n.id).sort()).toEqual(['c.small.x', 'c.small.y', 'summary:c.big'])
    expect(out.nodes.find((n) => n.id === 'summary:c.big')!.data.summary).toMatchObject({ label: 'big', count: 10 })
    expect(out.edges.map((e) => [e.source, e.target])).toEqual([['summary:c.big', 'c.small.x']])
    expect(out.edges).toHaveLength(1) // two edges into one table from one group are one
  })

  it('is a chain of pass-through views as one edge, or every table when chains are off', () => {
    const nodes = [at('a', 'src'), at('a', 'v1', 'view'), at('b', 'v2', 'view'), at('b', 'out')]
    const edges = [link('e1', 'c.a.src', 'c.a.v1', 'view_dep'), link('e2', 'c.a.v1', 'c.b.v2', 'view_dep'), link('e3', 'c.b.v2', 'c.b.out')]
    const chained = scene(nodes, edges)
    expect(chained.nodes.map((n) => n.id).sort()).toEqual(['c.a.src', 'c.b.out'])
    expect(chained.edges.map((e) => [e.source, e.target])).toEqual([['c.a.src', 'c.b.out']])
    expect(scene(nodes, edges, { grouping: { ...DEFAULT_GROUPING, chains: false } }).nodes).toHaveLength(4)
  })

  it('leaves out what the filters hide (the Model lens draws references only) and the column edges of a trace', () => {
    const nodes = [at('a', 'x'), at('a', 'y'), at('a', 'z')]
    const column = { ...link('col', 'c.a.x', 'c.a.y'), data: { info: { ...link('col', 'c.a.x', 'c.a.y').data!.info, source_column: 'v', target_column: 'v' } } }
    const model = { ...DEFAULT_FILTERS, lineage: false, view_dep: false, flow: false }
    const out = scene(nodes, [link('l1', 'c.a.x', 'c.a.y'), link('r1', 'c.a.y', 'c.a.z', 'fk')], { filters: model, columnEdges: [column] })
    expect(out.edges.map((e) => e.id)).toEqual(['r1'])
  })
})
