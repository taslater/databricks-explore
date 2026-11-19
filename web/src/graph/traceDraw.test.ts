import { describe, expect, it } from 'vitest'
import type { ColumnTrace, TraceHop } from '../api/columnTrace'
import { hopLines, traceColumnEdges, traceFade, traceNodes, tracedColumns, withoutTrace, type ActiveTrace } from './traceDraw'
import type { FlowEdge, FlowNode } from './types'

const node = (id: string, extra: Partial<FlowNode['data']> = {}): FlowNode => ({
  id,
  type: 'table',
  position: { x: 10, y: 20 },
  data: { name: id.split('.').pop()!, schema: 'c.s', kind: 'table', focus: false, selfRef: false, ...extra },
})
const hop = (s: string, sc: string, t: string, tc: string, over: Partial<TraceHop> = {}): TraceHop => ({
  id: `lineage:${s}#${sc}->${t}#${tc}`,
  source: { table: s, column: sc },
  target: { table: t, column: tc },
  hop: 1,
  side: 'up',
  last_seen: null,
  class: 'same',
  label: '=',
  expr: null,
  note: null,
  ...over,
})

const data = (hops: TraceHop[], over: Partial<ColumnTrace> = {}): ColumnTrace => ({
  table: 'c.gold.daily',
  column: 'revenue',
  direction: 'upstream',
  depth: 3,
  nodes: [
    { table: 'c.gold.daily', column: 'revenue', hop: 0, side: 'start' },
    { table: 'c.silver.lines', column: 'net', hop: 1, side: 'up' },
    { table: 'c.bronze.raw', column: 'amt', hop: 2, side: 'up' },
  ],
  hops,
  tables: ['c.gold.daily', 'c.silver.lines', 'c.bronze.raw'],
  readers: [],
  unread: [],
  truncated: false,
  errors: [],
  ...over,
})

const HOPS = [
  hop('c.silver.lines', 'net', 'c.gold.daily', 'revenue', { hop: 1, label: 'Σ sum', class: 'agg', expr: 'SUM(net)' }),
  hop('c.bronze.raw', 'amt', 'c.silver.lines', 'net', { hop: 2, label: '→', class: 'rename' }),
]
const trace = (cols: ActiveTrace['columns'] = {}): ActiveTrace => ({ data: data(HOPS), columns: cols })

describe('traceNodes', () => {
  it('lists the columns of the tables on the path, with the traced ones and the start marked, and leaves the others alone', () => {
    const cols = { 'c.silver.lines': [{ name: 'net', type: 'int' }] }
    const nodes = [node('c.gold.daily'), node('c.silver.lines'), node('c.other.x')]
    const out = traceNodes(nodes, trace(cols))
    expect(out[1].data).toMatchObject({ showColumns: true, columns: cols['c.silver.lines'], traced: ['net'] })
    expect(out[0].data.traceStart).toBe('revenue')
    expect(out[0].data.showColumns).toBeUndefined() // no columns loaded for it yet: nothing to list
    expect(out[2]).toBe(nodes[2])
    expect(nodes[1].data.showColumns).toBeUndefined() // the stored node is not changed
  })

  it('keeps the columns a node already loaded and does nothing without a trace', () => {
    const own = [{ name: 'net', type: 'int' }]
    const nodes = [node('c.silver.lines', { columns: own })]
    expect(traceNodes(nodes, trace({ 'c.silver.lines': [] }))[0].data.columns).toBe(own)
    expect(traceNodes(nodes, null)).toBe(nodes)
  })

  it('knows the traced columns of a table whatever its case', () => {
    expect([...tracedColumns(data(HOPS)).get('c.silver.lines')!]).toEqual(['net'])
  })
})

describe('traceColumnEdges', () => {
  const existing = (s: string, sc: string, t: string, tc: string): FlowEdge => ({
    id: `old:${sc}`,
    source: s,
    target: t,
    data: { info: { id: `old:${sc}`, source: s, target: t, kind: 'lineage', source_column: sc, target_column: tc } },
  })

  it('draws each hop as a column edge with its class, replacing the same pair of columns and keeping the rest', () => {
    const edges = [existing('c.silver.lines', 'NET', 'c.gold.daily', 'revenue'), existing('c.silver.lines', 'other', 'c.gold.daily', 'orders')]
    const out = traceColumnEdges(edges, [node('c.gold.daily'), node('c.silver.lines'), node('c.bronze.raw')], trace())
    expect(out.map((e) => e.id)).toEqual(['old:other', HOPS[0].id, HOPS[1].id])
    const first = out[1]
    expect(first.data!.trace).toBe(HOPS[0])
    expect(first.data!.info).toMatchObject({ kind: 'lineage', source_column: 'net', target_column: 'revenue', directed: true })
    expect(first).toMatchObject({ source: 'c.silver.lines', target: 'c.gold.daily' })
  })

  it('leaves out a hop with a table that is not on the graph', () => {
    expect(traceColumnEdges([], [node('c.gold.daily'), node('c.silver.lines')], trace()).map((e) => e.id)).toEqual([HOPS[0].id])
  })
})

describe('traceFade', () => {
  it('fades what is off the path, as hover does, and nothing on it', () => {
    const t = trace()
    const flow = {
      nodes: [node('c.gold.daily'), node('c.other.x')],
      edges: [
        { id: 'a', source: 'x', target: 'y', data: { info: { id: 'a', source: 'x', target: 'y', kind: 'lineage' as const }, faded: false } },
        { id: HOPS[0].id, source: 'c.silver.lines', target: 'c.gold.daily', data: { info: { id: HOPS[0].id, source: 'c.silver.lines', target: 'c.gold.daily', kind: 'lineage' as const }, trace: HOPS[0], faded: true } },
      ],
    }
    const out = traceFade(flow, t)
    expect(out.nodes.map((n) => !!n.data.faded)).toEqual([false, true])
    expect(out.edges.map((e) => !!e.data!.faded)).toEqual([true, false])
    expect(traceFade(flow, null)).toBe(flow)
  })
})

describe('withoutTrace', () => {
  it('takes off the tables a trace added with their edges, and puts the others back where they were', () => {
    const state = {
      nodes: [{ ...node('c.gold.daily'), position: { x: 500, y: 9 } }, node('c.silver.lines'), node('c.bronze.raw')],
      edges: [
        { id: 'e1', source: 'c.silver.lines', target: 'c.gold.daily', data: { info: { id: 'e1', source: 'c.silver.lines', target: 'c.gold.daily', kind: 'lineage' as const } } },
        { id: 'e2', source: 'c.bronze.raw', target: 'c.silver.lines', data: { info: { id: 'e2', source: 'c.bronze.raw', target: 'c.silver.lines', kind: 'lineage' as const } } },
      ],
      columnEdges: [] as FlowEdge[],
      selection: { kind: 'node', id: 'c.bronze.raw' },
    }
    const out = withoutTrace(state, ['c.bronze.raw'], { 'c.gold.daily': { x: 1, y: 2 } })
    expect(out.nodes.map((n) => n.id)).toEqual(['c.gold.daily', 'c.silver.lines'])
    expect(out.nodes[0].position).toEqual({ x: 1, y: 2 })
    expect(out.nodes[1].position).toEqual({ x: 10, y: 20 })
    expect(out.edges.map((e) => e.id)).toEqual(['e1'])
    expect(out.selection).toBeNull()
  })
})

describe('hopLines', () => {
  it('lists the trace upstream first, the furthest source at the top, one line per hop with its class', () => {
    const down = hop('c.gold.daily', 'revenue', 'c.gold.report', 'total', { side: 'down', hop: 1, label: 'cast', class: 'cast', expr: 'CAST(revenue AS INT)' })
    const unknown = hop('c.silver.x', 'k', 'c.gold.daily', 'key', { hop: 1, label: null, class: null, note: 'unread' })
    const lines = hopLines(data([down, HOPS[0], unknown, HOPS[1]]))
    expect(lines.map((l) => `${l.from} ${l.label ?? '?'} ${l.to}`)).toEqual([
      'bronze.raw.amt → silver.lines.net',
      'silver.lines.net Σ sum gold.daily.revenue',
      'silver.x.k ? gold.daily.key',
      'gold.daily.revenue cast gold.report.total',
    ])
    expect(lines[2].note).toBe('unread')
    expect(lines[3].expr).toBe('CAST(revenue AS INT)')
  })
})
