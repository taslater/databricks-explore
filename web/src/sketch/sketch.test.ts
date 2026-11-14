import { beforeEach, describe, expect, it } from 'vitest'
import { fromCanvasFile, parseCanvasFile, toCanvasFile } from '../canvas/persistence/canvasFile'
import type { CanvasWindow } from '../api/types'
import * as H from './history'
import { align, containedIds, copyClip, distribute, newSketchNode, nextId, pasteClip, reorder, snapValue, toItems } from './model'
import { createSketchStore } from './sketchStore'
import { diffColumns, sketchImportFile, storeDirection, storeTableName } from './tables'
import type { HostNode, SketchEdge, SketchHost, SketchNode } from './types'

const item = (id: string, x: number, y: number, w = 100, h = 50, extra: object = {}) => ({
  id,
  type: 'shape',
  position: { x, y },
  size: { w, h },
  ...extra,
})

describe('align and distribute', () => {
  const items = [item('a', 0, 0), item('b', 50, 100, 60, 50), item('c', 300, 200)]
  const all = new Set(['a', 'b', 'c'])
  it('aligns left, right and middle to the selection bounds', () => {
    expect(align(items, all, 'left')).toEqual({ b: { x: 0, y: 100 }, c: { x: 0, y: 200 } })
    expect(align(items, all, 'right').a).toEqual({ x: 300, y: 0 })
    expect(align(items, all, 'middle').a).toEqual({ x: 0, y: 100 })
  })
  it('skips locked items and needs two', () => {
    expect(align([item('a', 0, 0, 100, 50, { locked: true }), item('b', 50, 0)], new Set(['a', 'b']), 'left')).toEqual({ b: { x: 0, y: 0 } })
    expect(align(items, new Set(['a']), 'left')).toEqual({})
  })
  it('distributes with equal gaps', () => {
    const out = distribute(items, all, 'horizontal')
    expect(out).toEqual({ b: { x: 170, y: 100 } })
    expect(distribute(items, new Set(['a', 'b']), 'horizontal')).toEqual({})
  })
})

describe('stacking order', () => {
  const items = [item('a', 0, 0), item('b', 0, 0), item('c', 0, 0)]
  it('moves one step and to the ends', () => {
    expect(reorder(items, new Set(['a']), 'front')).toEqual({ b: 0, c: 1, a: 2 })
    expect(reorder(items, new Set(['a']), 'forward')).toEqual({ b: 0, a: 1, c: 2 })
    expect(reorder(items, new Set(['c']), 'back')).toEqual({ c: 0, a: 1, b: 2 })
    expect(reorder(items, new Set(['a']), 'backward')).toEqual({})
  })
  it('puts frames behind by default', () => {
    const withFrame = [item('a', 0, 0), { ...item('f', 0, 0), type: 'frame' }]
    expect(reorder(withFrame, new Set(['a']), 'front')).toEqual({})
    expect(reorder(withFrame, new Set(['f']), 'front')).toEqual({ a: 0, f: 1 })
  })
})

describe('frames, snapping, copy and paste', () => {
  it('contains what lies fully inside and is unlocked', () => {
    const f = item('f', 0, 0, 400, 300)
    const items = [f, item('in', 10, 10), item('out', 350, 10), item('lock', 10, 100, 50, 50, { locked: true })]
    expect(containedIds(f, items)).toEqual(['in'])
  })
  it('snaps to the grid', () => {
    expect(snapValue(29)).toBe(20)
    expect(snapValue(31)).toBe(40)
  })
  it('pastes with new ids, a new placeholder uuid, and no saved relationship', () => {
    const a = newSketchNode('s1', 'placeholder', { x: 0, y: 0 })
    const b = newSketchNode('s2', 'shape', { x: 200, y: 0 }, { shape: 'ellipse' })
    const edge: SketchEdge = { id: 'c1', source: 's1', target: 's2', line: 'step', arrow_start: false, arrow_end: true, dashed: false, relationship: { id: 'e_x' } }
    const clip = copyClip([a, b], [edge], new Set(['s1', 's2']))
    const made = pasteClip(clip, { x: 20, y: 20 }, ['s1', 's2'], ['c1'])
    expect(made.nodes.map((n) => n.id)).toEqual(['s3', 's4'])
    expect(made.nodes[0].position).toEqual({ x: 20, y: 20 })
    expect(made.nodes[0].placeholder?.id).not.toBe(a.placeholder?.id)
    expect(made.edges[0]).toMatchObject({ id: 'c2', source: 's3', target: 's4' })
    expect(made.edges[0].relationship).toBeUndefined()
    expect(nextId('s', ['s1', 's9'])).toBe('s10')
  })
})

describe('history', () => {
  const snap = (n: number): H.Snapshot => ({ nodes: [], edges: [], host: { w1: { position: { x: n, y: 0 }, size: { w: 1, h: 1 } } } })
  it('undoes and redoes, and clears redo on a new step', () => {
    let h = H.push(H.EMPTY_HISTORY, snap(1))
    h = H.push(h, snap(2))
    const u = H.undo(h, snap(3))!
    expect(u.snapshot).toEqual(snap(2))
    const r = H.redo(u.history, snap(2))!
    expect(r.snapshot).toEqual(snap(3))
    expect(H.push(u.history, snap(9)).future).toEqual([])
    expect(H.undo(H.EMPTY_HISTORY, snap(0))).toBeNull()
  })
  it('coalesces same-key pushes in quick succession', () => {
    let h = H.push(H.EMPTY_HISTORY, snap(1), 'k', 1000)
    h = H.push(h, snap(2), 'k', 1500)
    expect(h.past).toHaveLength(1)
    h = H.push(h, snap(3), 'k', 5000)
    expect(h.past).toHaveLength(2)
  })
})

describe('sketch store with a host', () => {
  let geo: Record<string, { x: number; y: number }>
  let host: SketchHost
  const useStore = createSketchStore()
  beforeEach(() => {
    geo = { w1: { x: 0, y: 0 } }
    host = {
      nodes: (): HostNode[] => Object.entries(geo).map(([id, p]) => ({ id, type: 'table', table: 'a.b.c', position: p, size: { w: 100, h: 100 } })),
      patch: (p) => {
        for (const [id, v] of Object.entries(p)) if (v.position) geo[id] = v.position
      },
    }
    useStore.setState({ ...useStore.getInitialState(), snap: false })
    useStore.getState().setHost(host)
  })
  it('undoes and redoes adding, connecting, and moving a host node', () => {
    const st = () => useStore.getState()
    const id = st().addNode('shape', { x: 300, y: 0 }, { shape: 'rect' })
    expect(st().nodes).toHaveLength(1)
    st().connect({ source: id, target: 'w1', sourceHandle: 'l', targetHandle: 'r' })
    expect(st().edges).toHaveLength(1)
    st().checkpoint('move')
    host.patch({ w1: { position: { x: 50, y: 50 } } })
    st().undo()
    expect(geo.w1).toEqual({ x: 0, y: 0 })
    st().undo()
    expect(st().edges).toHaveLength(0)
    st().undo()
    expect(st().nodes).toHaveLength(0)
    st().redo()
    st().redo()
    expect(st().edges).toHaveLength(1)
  })
  it('does not delete locked nodes and removes connectors with their node', () => {
    const st = () => useStore.getState()
    const a = st().addNode('shape', { x: 0, y: 200 })
    st().connect({ source: a, target: 'w1' })
    st().select([a])
    st().toggleLock()
    st().removeSelection()
    expect(st().nodes).toHaveLength(1)
    st().toggleLock()
    st().removeSelection()
    expect(st().nodes).toHaveLength(0)
    expect(st().edges).toHaveLength(0)
  })
  it('rejects a self-connection and a missing end', () => {
    const a = useStore.getState().addNode('shape', { x: 0, y: 0 })
    expect(useStore.getState().connect({ source: a, target: a })).toBeNull()
    expect(useStore.getState().connect({ source: a, target: 'zz' })).toBeNull()
  })
  it('aligns a mix of sketch and host nodes', () => {
    const st = () => useStore.getState()
    const a = st().addNode('shape', { x: 300, y: 40 })
    st().select([a, 'w1'])
    st().align('left')
    expect(st().nodes[0].position.x).toBe(0)
  })
  it('keeps a pruned edge list in step with the host', () => {
    const st = () => useStore.getState()
    const a = st().addNode('shape', { x: 0, y: 0 })
    st().connect({ source: a, target: 'w1' })
    st().prune([])
    expect(st().edges).toHaveLength(0)
  })
})

describe('tables', () => {
  it('names nodes for the relationship store', () => {
    expect(storeTableName({ type: 'table', table: 'a.b.c' })).toBe('a.b.c')
    const ph = newSketchNode('s1', 'placeholder', { x: 0, y: 0 })
    expect(storeTableName(ph)).toBe(`ph:${ph.placeholder!.id}`)
    ph.placeholder!.linked = 'a.b.real'
    expect(storeTableName(ph)).toBe('a.b.real')
    expect(storeTableName({ type: 'note' })).toBeNull()
  })
  it('diffs sketch columns against a real table', () => {
    const rows = diffColumns(
      [{ name: 'ID', type: 'BIGINT' }, { name: 'email', type: 'int' }, { name: 'extra', type: '' }, { name: 'loose', type: '' }],
      [{ name: 'id', type: 'bigint' }, { name: 'email', type: 'string' }, { name: 'extra', type: 'string' }, { name: 'created', type: 'date' }],
    )
    expect(rows.map((r) => [r.name, r.status])).toEqual([
      ['ID', 'same'],
      ['email', 'type'],
      ['extra', 'same'],
      ['loose', 'new'],
      ['created', 'existing'],
    ])
  })
  it('turns a connector into one sketch edge for the store', () => {
    expect(storeDirection({ arrow_start: true, arrow_end: false })).toEqual({ swap: true, directed: true })
    const edge: SketchEdge = { id: 'c1', source: 's1', target: 'w1', line: 'step', arrow_start: true, arrow_end: false, dashed: false, label: 'fk', relationship: { source_column: 'cid', target_column: 'id' } }
    const file = sketchImportFile({ edge, sourceTable: 'ph:x', targetTable: 'a.b.c', canvasName: 'd', id: 'e_1', now: 't' })
    expect(file.edges[0]).toMatchObject({
      kind: 'sketch',
      source: { table: 'a.b.c', column: 'id' },
      target: { table: 'ph:x', column: 'cid' },
      directed: true,
      note: 'fk',
      status: 'accepted',
    })
  })
})

describe('canvas file version 2', () => {
  const meta = { name: 'plan', profile: null, warehouseId: null }
  const viewport = { x: 0, y: 0, zoom: 1 }
  const windows: CanvasWindow[] = [{ id: 'w1', type: 'table', title: 'orders', position: { x: 0, y: 0 }, size: { w: 320, h: 300 }, table: 'a.b.orders', collapsed: false, z: 3 }]
  const nodes: SketchNode[] = [
    { ...newSketchNode('s1', 'shape', { x: 400, y: 0 }, { shape: 'cylinder' }), label: 'DB', locked: true },
    newSketchNode('s2', 'placeholder', { x: 400, y: 200 }),
    newSketchNode('s3', 'frame', { x: 380, y: -40 }),
  ]
  const edges: SketchEdge[] = [
    { id: 'c1', source: 's1', target: 'w1', source_handle: 'l', target_handle: 'r', line: 'curve', arrow_start: true, arrow_end: true, dashed: true, label: 'x', color: '#dc2626', relationship: { id: 'e_1', source_column: 'a' } },
  ]
  it('round trips sketch nodes and connectors through JSON', () => {
    const file = toCanvasFile({ viewport, windows, sketchNodes: nodes, edges }, meta)
    expect(file.version).toBe(2)
    const back = fromCanvasFile(parseCanvasFile(JSON.parse(JSON.stringify(file))))
    expect(back.windows).toEqual(windows)
    expect(back.sketchNodes).toEqual(nodes)
    expect(back.edges).toEqual(edges)
  })
  it('loads a version 1 file unchanged', () => {
    const v1 = { version: 1, name: 'old', profile: 'dev', warehouse_id: null, viewport, windows: [{ id: 'w1', type: 'note', title: 'n', position: { x: 1, y: 2 }, size: { w: 3, h: 4 }, text: 'hi', collapsed: false }], links: [] }
    const back = fromCanvasFile(parseCanvasFile(v1))
    expect(back.windows).toEqual(v1.windows)
    expect(back.sketchNodes).toEqual([])
    expect(back.edges).toEqual([])
  })
  it('rejects what version 1 cannot hold and dangling connectors', () => {
    const file = JSON.parse(JSON.stringify(toCanvasFile({ viewport, windows, sketchNodes: nodes, edges }, meta)))
    expect(() => parseCanvasFile({ ...file, version: 1, profile: 'dev' })).toThrow(/version 2|edges/)
    file.edges[0].target = 'zz'
    expect(() => parseCanvasFile(file)).toThrow(/edges\[0\]\.target/)
    expect(() => parseCanvasFile({ ...file, version: 1, profile: null, edges: undefined, windows: [] })).toThrow(/profile/)
  })
  it('lists every node in toItems for the host and the sketch together', () => {
    expect(toItems(nodes, [{ id: 'w1', type: 'table', position: { x: 0, y: 0 }, size: { w: 1, h: 1 } }]).map((i) => i.id)).toEqual(['w1', 's1', 's2', 's3'])
  })
})
