// runLayout: positions from ELK, the order of placed nodes kept after an expansion, a fresh layout on request.
import { beforeEach, describe, expect, it } from 'vitest'
import type { GraphEdge, RelationsResponse } from '../api/types'
import { layoutInput } from './layoutInput'
import { DEFAULT_FILTERS, useGraphStore } from './graphStore'
import type { FlowEdge, FlowNode } from './types'

const T = (n: string) => 'main.sales.' + n
const rel = (a: string, b: string): GraphEdge =>
  ({ id: 'lineage:' + a + '<->' + b, kind: 'lineage', source: a, target: b, status: 'accepted' }) as GraphEdge
const resp = (nodes: string[], edges: GraphEdge[], focus?: string): RelationsResponse => ({
  nodes: nodes.map((id) => ({ id, label: id, kind: 'table', focus: id === focus })),
  edges,
  errors: [],
})
const pos = (id: string) => useGraphStore.getState().nodes.find((n) => n.id === id)!.position

describe('runLayout', () => {
  beforeEach(() => useGraphStore.getState().clear())

  it('lays the nodes out left to right and clears the request', async () => {
    useGraphStore.getState().mergeRelations(resp([T('a'), T('b'), T('c')], [rel(T('a'), T('b')), rel(T('b'), T('c'))], T('b')))
    expect(useGraphStore.getState().layoutPending).toBe(true)
    await useGraphStore.getState().runLayout()
    expect(useGraphStore.getState().layoutPending).toBe(false)
    expect(pos(T('b')).x).toBeGreaterThan(pos(T('a')).x)
    expect(pos(T('c')).x).toBeGreaterThan(pos(T('b')).x)
  })

  it('keeps the nodes already placed where they are in the order, when an expansion adds one', async () => {
    const s = useGraphStore.getState()
    s.mergeRelations(resp([T('a'), T('b'), T('c')], [rel(T('a'), T('c')), rel(T('b'), T('c'))], T('c')))
    await s.runLayout()
    const aAboveB = pos(T('a')).y < pos(T('b')).y
    useGraphStore.getState().mergeRelations(resp([T('c'), T('d')], [rel(T('c'), T('d'))]))
    expect(useGraphStore.getState().layoutPending).toBe(true)
    await useGraphStore.getState().runLayout()
    expect(pos(T('a')).y < pos(T('b')).y).toBe(aAboveB)
    expect(pos(T('d')).x).toBeGreaterThan(pos(T('c')).x)
  })

  it('treats nodes as placed after a diagram is loaded, and not after clear', () => {
    const node = (id: string): FlowNode => ({ id, type: 'table', position: { x: 5, y: 5 }, data: { name: id, schema: 'main.sales', kind: 'table', focus: false, selfRef: false } })
    const input = layoutInput({ nodes: [node(T('a'))], edges: [], columnEdges: [], focusSchema: null, filters: DEFAULT_FILTERS }, new Set([T('a')]))
    expect(input.nodes[0].placed).toBe(true)
    expect(layoutInput({ nodes: [node(T('a'))], edges: [], columnEdges: [], focusSchema: null, filters: DEFAULT_FILTERS }, new Set()).nodes[0].placed).toBeUndefined()
  })

  it('starts over when the layout is requested for everything', () => {
    const s = useGraphStore.getState()
    s.requestLayout(['x'])
    expect(useGraphStore.getState().layoutFresh).toBe(false)
    s.requestLayout()
    expect(useGraphStore.getState().layoutFresh).toBe(true)
  })

  it('drops a second run while one is in flight and leaves the request pending when the nodes changed meanwhile', async () => {
    const s = useGraphStore.getState()
    s.mergeRelations(resp([T('a'), T('b')], [rel(T('a'), T('b'))], T('a')))
    const first = s.runLayout()
    await s.runLayout() // dropped
    useGraphStore.getState().mergeRelations(resp([T('b'), T('c')], [rel(T('b'), T('c'))]))
    await first
    expect(useGraphStore.getState().layoutPending).toBe(true)
    await useGraphStore.getState().runLayout()
    expect(useGraphStore.getState().layoutPending).toBe(false)
  })
})

describe('layoutInput', () => {
  it('gives the layout the rows each node draws and the column edges both of whose rows show', () => {
    const cols = (names: string[]) => names.map((name) => ({ name, type: 'int', ...(name === 'id' && { pk: true }) }))
    const node = (id: string, names: string[]): FlowNode => ({
      id,
      type: 'table',
      position: { x: 0, y: 0 },
      data: { name: id, schema: 'main.sales', kind: 'table', focus: false, selfRef: false, showColumns: true, columns: cols(names) },
    })
    const edge = (info: GraphEdge): FlowEdge => ({ id: info.id, source: info.source, target: info.target, data: { info } })
    const table = rel(T('a'), T('b'))
    const column = { ...rel(T('a'), T('b')), id: 'lineage:x', source_column: 'amount', target_column: 'total' } as GraphEdge
    const { nodes, links } = layoutInput(
      {
        nodes: [node(T('a'), ['id', 'amount', 'note']), node(T('b'), ['id', 'total'])],
        edges: [edge(table)],
        columnEdges: [edge(column)],
        focusSchema: null,
        filters: DEFAULT_FILTERS,
      },
      new Set(),
    )
    expect(nodes[0].rows).toEqual(['id', 'amount'])
    expect(nodes[0].moreRow).toBe(true)
    expect(nodes[1].rows).toEqual(['id', 'total'])
    expect(nodes[1].moreRow).toBe(false)
    expect(links.find((l) => l.sourceColumn)).toMatchObject({ source: T('a'), sourceColumn: 'amount', targetColumn: 'total' })
  })
})
