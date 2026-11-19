import { describe, expect, it } from 'vitest'
import type { Cardinality, GraphEdge, GraphEdgeKind } from '../api/types'
import { colorNodes } from './colorBy'
import { ENDS_TEXT, dateLine, factsReadDate, fileStem, frameMetrics, legendRows, pictureLegend, type LegendInput } from './exportPicture'
import { DEFAULT_FILTERS } from './graphStore'
import type { FlowNode } from './types'

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
