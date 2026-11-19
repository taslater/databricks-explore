// A layout that is still running when the graph changes under it (lens switch, trace cleared, diagram loaded) must not paint its result.
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphEdge, RelationsResponse } from '../api/types'
import { useGraphStore } from './graphStore'
import { useTraceStore } from './traceStore'
import { makeTraceActions } from './traceActions'
import type { FlowNode } from './types'

const T = (n: string) => 'main.sales.' + n
const rel = (a: string, b: string): GraphEdge => ({ id: 'lineage:' + a + '<->' + b, kind: 'lineage', source: a, target: b, status: 'accepted' }) as GraphEdge
const resp = (nodes: string[], edges: GraphEdge[], focus?: string): RelationsResponse => ({
  nodes: nodes.map((id) => ({ id, label: id, kind: 'table', focus: id === focus })),
  edges,
  errors: [],
})
const pos = (id: string) => useGraphStore.getState().nodes.find((n) => n.id === id)!.position
const at = (id: string, x: number, y: number): FlowNode => ({ id, type: 'table', position: { x, y }, data: { name: id.split('.')[2], schema: 'main.sales', kind: 'table', focus: false, selfRef: false } })

async function laidOut() {
  useGraphStore.getState().clear()
  useGraphStore.getState().mergeRelations(resp([T('a'), T('b'), T('c')], [rel(T('a'), T('b')), rel(T('b'), T('c'))], T('b')))
  await useGraphStore.getState().runLayout()
}

describe('a layout in flight', () => {
  beforeEach(() => {
    vi.useRealTimers()
    useTraceStore.getState().reset()
  })
  afterEach(() => vi.useRealTimers())

  it('does not paint over the positions a lens switch brought back', async () => {
    await laidOut()
    useGraphStore.getState().setLens('flow')
    await useGraphStore.getState().runLayout() // Flow's own layout; All waits with the positions above
    const before = { [T('a')]: { x: 1, y: 2 }, [T('b')]: { x: 3, y: 4 }, [T('c')]: { x: 5, y: 6 } } // where All left them, apart from where Flow puts them
    useGraphStore.setState({ lensPositions: { all: before } })
    useGraphStore.getState().requestLayout()
    const inflight = useGraphStore.getState().runLayout()
    useGraphStore.getState().setLens('all') // All has its place for every table, so no layout follows
    await inflight
    for (const id of [T('a'), T('b'), T('c')]) expect(pos(id)).toEqual(before[id])
    expect(useGraphStore.getState().layoutPending).toBe(false)
  })

  it('leaves the layout a lens switch asked for pending', async () => {
    await laidOut()
    useGraphStore.getState().requestLayout()
    const inflight = useGraphStore.getState().runLayout()
    useGraphStore.getState().setLens('model') // Model has no positions: it needs its own layout
    await inflight
    const s = useGraphStore.getState()
    expect(s.layoutPending).toBe(true)
    expect(s.layoutFresh).toBe(true)
    await s.runLayout()
    expect(useGraphStore.getState().layoutPending).toBe(false)
  })

  it('does not paint over a diagram loaded meanwhile', async () => {
    await laidOut()
    useGraphStore.getState().requestLayout()
    const inflight = useGraphStore.getState().runLayout()
    useGraphStore.getState().loadDiagram({ nodes: [at(T('a'), 5, 6), at(T('b'), 7, 8), at(T('c'), 9, 10)], edges: [], focusSchema: null })
    await inflight
    expect([pos(T('a')), pos(T('b')), pos(T('c'))]).toEqual([{ x: 5, y: 6 }, { x: 7, y: 8 }, { x: 9, y: 10 }])
    expect(useGraphStore.getState().layoutPending).toBe(false)
  })

  it('does not paint over the positions clearing a trace put back, or lay out again after it', async () => {
    await laidOut()
    const stand = Object.fromEntries(useGraphStore.getState().nodes.map((n) => [n.id, { ...n.position }]))
    useTraceStore.getState().begin({ table: T('b'), column: 'v', direction: 'both', depth: 4 }, stand)
    useTraceStore.getState().setAdded([T('c')])
    useGraphStore.getState().requestLayout()
    const inflight = useGraphStore.getState().runLayout()
    makeTraceActions(new QueryClient()).stop()
    await inflight
    expect(useGraphStore.getState().nodes.map((n) => n.id).sort()).toEqual([T('a'), T('b')])
    expect(pos(T('a'))).toEqual(stand[T('a')])
    expect(pos(T('b'))).toEqual(stand[T('b')])
    expect(useGraphStore.getState().layoutPending).toBe(false)
  })

  it('does not lay out when a trace is cleared before the layout it asked for was due', async () => {
    await laidOut()
    vi.useFakeTimers()
    useTraceStore.getState().begin({ table: T('b'), column: 'v', direction: 'both', depth: 4 }, {})
    useGraphStore.getState().requestLayoutSoon([T('a'), T('b')])
    makeTraceActions(new QueryClient()).stop()
    vi.advanceTimersByTime(1000)
    expect(useGraphStore.getState().layoutPending).toBe(false)
  })
})
