import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphEdgeKind } from '../api/types'
import { fromDiagram, toDiagramBody } from './diagram'
import { graphSignature } from './diagramSync'
import { DEFAULT_FILTERS, useGraphStore } from './graphStore'
import type { LayoutEdge, LayoutNode } from './layout'
import { computeLayout } from './layout'
import { anyOverlap, depthsOf, isModified, LENS_FAMILIES, parseLens, parseLensPositions, presetFilters, referencePairs, rolesOf } from './lens'
import { modelPart } from './modelLayout'
import type { FlowNode } from './types'

const edge = (source: string, target: string, kind: GraphEdgeKind = 'fk', extra: Partial<GraphEdge> = {}): GraphEdge => ({ id: `${kind}:${source}>${target}`, source, target, kind, status: 'derived', ...extra })
const STAR = [edge('f1', 'd1'), edge('f1', 'd12'), edge('f2', 'd12'), edge('f2', 'd2'), edge('d1', 'dd')]
const IDS = ['f1', 'f2', 'd1', 'd12', 'd2', 'dd', 'solo']

describe('the lens presets', () => {
  it('Flow shows only the flow family, Model only references, All today\'s families, with every kind on', () => {
    expect(presetFilters('flow')).toMatchObject({ flow: true, reference: false, meaning: false, lineage: true, fk: true })
    expect(presetFilters('model')).toMatchObject({ flow: false, reference: true, meaning: false })
    expect(presetFilters('all')).toMatchObject({ flow: true, reference: true, meaning: false })
    expect(isModified({ ...DEFAULT_FILTERS }, 'all')).toBe(false)
    expect(LENS_FAMILIES.model).toEqual(['reference'])
  })

  it('marks a lens modified when an edge filter differs, and not for superseded or rejected edges', () => {
    const flow = { ...DEFAULT_FILTERS, ...presetFilters('flow') }
    expect(isModified(flow, 'flow')).toBe(false)
    expect(isModified({ ...flow, showSuperseded: true, showRejected: true }, 'flow')).toBe(false)
    expect(isModified({ ...flow, reference: true }, 'flow')).toBe(true)
    expect(isModified({ ...flow, lineage: false }, 'flow')).toBe(true)
    expect(isModified(flow, 'model')).toBe(true)
  })

  it('reads an unknown lens as All and keeps only well-formed positions', () => {
    expect(parseLens('model')).toBe('model')
    expect(parseLens('wide')).toBe('all')
    expect(parseLensPositions({ flow: { 'a.b.c': { x: 1, y: 2 }, bad: { x: 1 } }, wide: { 'a.b.c': { x: 1, y: 2 } }, model: 'no' })).toEqual({ flow: { 'a.b.c': { x: 1, y: 2 } } })
  })
})

describe('fact and dimension roles', () => {
  it('calls a table that references others and is not referenced a fact, what is referenced a dimension, with the reason', () => {
    const roles = rolesOf(IDS, STAR)
    expect([...roles].map(([id, r]) => [id, r.role, r.depth])).toEqual([
      ['f1', 'fact', 0], ['f2', 'fact', 0], ['d1', 'dimension', 1], ['d12', 'dimension', 1], ['d2', 'dimension', 1], ['dd', 'dimension', 2],
    ])
    expect(roles.has('solo')).toBe(false)
    expect(roles.get('f1')!.reason).toBe('references d1, d12 and nothing references it')
    expect(roles.get('d12')!.reason).toBe('referenced by f1, f2')
    expect(roles.get('d1')!.reason).toBe('referenced by f1, and references dd in turn (a dimension of a dimension)')
  })

  it('counts only key references: not rejected or superseded, not flow, not a table to itself, one per pair', () => {
    const edges = [edge('a', 'b', 'fk', { status: 'rejected' }), edge('b', 'c', 'fk', { status: 'superseded' }), edge('c', 'c'), edge('a', 'c', 'lineage'), edge('a', 'd', 'manual'), edge('a', 'd', 'join_mined')]
    expect(referencePairs(edges)).toEqual([['a', 'd']])
  })

  it('puts a table at its longest path from a fact, and starts a cycle at its first table', () => {
    expect(depthsOf(['f', 'm', 'd'], [['f', 'm'], ['m', 'd'], ['f', 'd']]).get('d')).toBe(2)
    expect([...depthsOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']])]).toEqual([['a', 0], ['b', 1], ['c', 2]])
  })
})

const box = (id: string, width = 100, height = 40): LayoutNode => ({ id, width, height, focus: false, x: 0, y: 0 })
const links = (edges: GraphEdge[]): LayoutEdge[] => edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind }))

describe('the Model lens layout', () => {
  const nodes = IDS.filter((i) => i !== 'solo').map((i) => box(i, i.startsWith('f') ? 100 : 80, i.startsWith('f') ? 40 : 30))

  it('puts facts in a middle row, dimensions above and below, and a dimension of two facts between them', () => {
    const at = modelPart(nodes, links(STAR))
    const centre = (id: string) => ({ x: at.get(id)!.x + nodes.find((n) => n.id === id)!.width / 2, y: at.get(id)!.y + nodes.find((n) => n.id === id)!.height / 2 })
    expect(centre('f1').y).toBe(centre('f2').y)
    expect(centre('f1').x).toBeLessThan(centre('f2').x)
    const side = (id: string) => Math.sign(centre(id).y - centre('f1').y)
    expect(new Set(['d1', 'd12', 'd2'].map(side))).toEqual(new Set([-1, 1])) // both sides are used
    expect(centre('f1').x).toBeLessThan(centre('d12').x)
    expect(centre('d12').x).toBeLessThan(centre('f2').x)
    expect(side('dd')).toBe(side('d1')) // a dimension of a dimension: the same side...
    expect(Math.abs(centre('dd').y - centre('f1').y)).toBeGreaterThan(Math.abs(centre('d1').y - centre('f1').y)) // ...one row further out
    const boxes = nodes.map((n) => ({ ...at.get(n.id)!, width: n.width, height: n.height }))
    expect(anyOverlap(boxes)).toBe(false)
    expect(modelPart(nodes, links(STAR))).toEqual(at)
  })

  it('stacks parts with no reference between them and leaves them clear of each other', async () => {
    const more = [...nodes, box('x'), box('y')]
    const at = await computeLayout(more, [...links(STAR), ...links([edge('x', 'y')])], { lens: 'model' })
    expect(at.size).toBe(8)
    expect(anyOverlap(more.map((n) => ({ ...at.get(n.id)!, width: n.width, height: n.height })))).toBe(false)
    expect(at.get('x')!.y).toBeGreaterThan(Math.max(...nodes.map((n) => at.get(n.id)!.y + n.height)))
  })
})

const flowNode = (id: string, x: number, y: number): FlowNode => ({ id, type: 'table', position: { x, y }, data: { name: id.split('.')[2], schema: 'c.s', kind: 'table', focus: false, selfRef: false } })

describe('a lens keeps its own positions', () => {
  const a = 'c.s.a'
  const b = 'c.s.b'
  const fresh = () => {
    useGraphStore.getState().clear()
    useGraphStore.setState({ nodes: [flowNode(a, 10, 20), flowNode(b, 300, 20)], edges: [] })
  }

  it('brings Flow back as it was after Model, and lays Model out when it has no positions yet', () => {
    fresh()
    useGraphStore.getState().setLens('flow')
    useGraphStore.setState({ nodes: [flowNode(a, 10, 20), flowNode(b, 300, 20)] }) // the Flow layout
    useGraphStore.getState().setLens('model')
    let now = useGraphStore.getState()
    expect(now.lens).toBe('model')
    expect(now.filters).toMatchObject({ flow: false, reference: true })
    expect(now.columnsRequest).toBe('keys')
    expect(now.layoutPending && now.layoutFresh).toBe(true) // nothing to bring back: lay out
    expect(now.lensHold).toBe(false)
    useGraphStore.setState({ nodes: now.nodes.map((n) => ({ ...n, position: { x: n.position.x + 1, y: 500 } })) }) // the layout ran
    useGraphStore.getState().setLens('flow')
    now = useGraphStore.getState()
    expect(now.nodes.map((n) => [n.id, n.position])).toEqual([[a, { x: 10, y: 20 }], [b, { x: 300, y: 20 }]])
    expect(now.layoutPending).toBe(false)
    expect(now.lensHold).toBe(true) // the columns come off without a new layout
    expect(now.filters).toMatchObject({ flow: true, reference: false })
    useGraphStore.getState().setLens('model')
    expect(useGraphStore.getState().nodes.map((n) => n.position.y)).toEqual([500, 500]) // and Model has its own
  })

  it('lays out only what a lens has no place for, for Flow and All, and everything for Model', () => {
    fresh()
    useGraphStore.getState().setLens('flow')
    useGraphStore.getState().setLens('model')
    useGraphStore.setState({ nodes: [...useGraphStore.getState().nodes, flowNode('c.s.c', 0, 0)] }) // added while in Model
    useGraphStore.getState().setLens('flow') // Flow's saved positions were for a and b
    let s = useGraphStore.getState()
    expect(s.layoutScope).toEqual(['c.s.c'])
    expect(s.layoutFresh).toBe(false)
    expect(s.nodes.find((n) => n.id === a)!.position).toEqual({ x: 10, y: 20 })
    useGraphStore.setState({ nodes: [...useGraphStore.getState().nodes, flowNode('c.s.d', 0, 0)] }) // added while in Flow
    useGraphStore.getState().setLens('model') // Model's saved positions have no place for d
    s = useGraphStore.getState()
    expect(s.layoutFresh).toBe(true) // the Model lens lays the whole graph out again
    expect(s.layoutScope).toBeNull()
  })

  it('saves the lens and the positions of the others as centers, and loads them back', () => {
    fresh()
    const s = useGraphStore.getState()
    s.setLens('model')
    useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((n) => ({ ...n, position: { x: n.position.x, y: 700 } })) })
    const g = useGraphStore.getState()
    const body = toDiagramBody('g', { nodes: g.nodes, edges: g.edges, focusSchema: null, lens: g.lens, lensPositions: g.lensPositions })
    expect(body.lens).toBe('model')
    const waiting = (body.lens_positions as Record<string, Record<string, { x: number; y: number }>>).all
    expect(Object.keys(waiting)).toEqual([a, b])
    expect(waiting[a].x).toBeGreaterThan(10) // a center, not a corner
    const back = fromDiagram({ ...(body as object), name: 'g', saved_at: 'now' })
    expect(back.lens).toBe('model')
    expect(back.lensPositions!.all![a].x).toBeCloseTo(10, 0)
    expect(back.lensPositions!.all![b].y).toBeCloseTo(20, 0)
    const plain = toDiagramBody('g', { nodes: g.nodes, edges: g.edges, focusSchema: null, lens: 'all' })
    expect('lens' in plain || 'lens_positions' in plain).toBe(false)
  })

  it('opens a graph saved in a lens with that lens\'s filters and column level, and clear goes back to All', () => {
    fresh()
    useGraphStore.getState().loadDiagram({ nodes: [flowNode(a, 0, 0)], edges: [], focusSchema: null, lens: 'model', lensPositions: {} })
    let s = useGraphStore.getState()
    expect([s.lens, s.columnsRequest, s.filters.flow, s.filters.reference]).toEqual(['model', 'keys', false, true])
    useGraphStore.getState().resetLens()
    expect(useGraphStore.getState().filters.reference).toBe(true)
    useGraphStore.getState().setFilter('flow', true)
    expect(isModified(useGraphStore.getState().filters, 'model')).toBe(true)
    useGraphStore.getState().resetLens()
    expect(useGraphStore.getState().filters.flow).toBe(false)
    useGraphStore.getState().clear()
    s = useGraphStore.getState()
    expect([s.lens, s.filters.flow, s.columnsRequest, s.lensHold]).toEqual(['all', true, null, false])
  })

  it('ignores layout requests while a lens switch holds the positions it brought back, and sees the lens in the signature', () => {
    fresh()
    useGraphStore.getState().setLens('flow')
    useGraphStore.getState().setLens('all')
    expect(useGraphStore.getState().lensHold).toBe(true)
    useGraphStore.setState({ layoutPending: false })
    useGraphStore.getState().requestLayout()
    expect(useGraphStore.getState().layoutPending).toBe(false)
    useGraphStore.getState().finishLensColumns()
    useGraphStore.getState().requestLayout()
    expect(useGraphStore.getState().layoutPending).toBe(true)
    const nodes = [flowNode(a, 0, 0)]
    expect(graphSignature(nodes, [], null, 'type', undefined, 'model')).not.toBe(graphSignature(nodes, [], null))
    expect(graphSignature(nodes, [], null, 'type', undefined, 'all')).toBe(graphSignature(nodes, [], null))
  })
})
