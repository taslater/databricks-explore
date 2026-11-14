import { beforeEach, describe, expect, it } from 'vitest'
import type { LayoutChange } from '../../api/layout'
import { createSketchStore } from '../../sketch/sketchStore'
import type { HostNode, SketchEdge, SketchHost, SketchNode } from '../../sketch/types'
import { useCanvasStore } from '../../store/canvasStore'
import { useSketchStore } from '../../sketch/sketchStore'
import { ARRANGE_CHOICES } from './ArrangeMenu'
import { appliedNote, applyChanges, changesToPatch, currentDoc, plural } from './layoutActions'

const sketchNode = (id: string, x: number, y: number, extra: Partial<SketchNode> = {}): SketchNode => ({
  id,
  type: 'shape',
  shape: 'rect',
  label: id,
  position: { x, y },
  size: { w: 100, h: 50 },
  ...extra,
})

const edge = (id: string, source: string, target: string, extra: Partial<SketchEdge> = {}): SketchEdge => ({
  id,
  source,
  target,
  line: 'step',
  arrow_start: false,
  arrow_end: true,
  dashed: false,
  ...extra,
})

const node = (id: string, x: number, y: number, w: number, h: number): LayoutChange => ({
  kind: 'node',
  id,
  from: { x: 0, y: 0, w: 1, h: 1 },
  to: { x, y, w, h },
})

describe('changesToPatch', () => {
  it('splits node geometry and connector sides', () => {
    const patch = changesToPatch([
      node('a', 10, 20, 100, 50),
      { kind: 'edge', id: 'e1', from: { source_handle: 'l', target_handle: 'r' }, to: { source_handle: 'r', target_handle: 'l' } },
    ])
    expect(patch.nodes.a).toEqual({ position: { x: 10, y: 20 }, size: { w: 100, h: 50 } })
    expect(patch.edges.e1).toEqual({ source_handle: 'r', target_handle: 'l' })
  })

  it('carries a label offset when the route says one changed', () => {
    const patch = changesToPatch([
      { kind: 'edge', id: 'e1', from: { source_handle: 'r', target_handle: 'l' }, to: { source_handle: 'r', target_handle: 'l', label_offset: 24 } },
    ])
    expect(patch.edges.e1).toEqual({ source_handle: 'r', target_handle: 'l', label_offset: 24 })
  })
})

describe('applyLayout in the sketch store', () => {
  const useStore = createSketchStore()
  let geo: Record<string, { position: { x: number; y: number }; size: { w: number; h: number }; locked?: boolean }>
  let host: SketchHost

  beforeEach(() => {
    geo = {
      w1: { position: { x: 0, y: 0 }, size: { w: 300, h: 200 } },
      w2: { position: { x: 400, y: 0 }, size: { w: 300, h: 200 }, locked: true },
    }
    host = {
      nodes: (): HostNode[] => Object.entries(geo).map(([id, g]) => ({ id, type: 'query', ...g })),
      patch: (p) => {
        for (const [id, v] of Object.entries(p)) {
          if (v.position) geo[id].position = v.position
          if (v.size) geo[id].size = v.size
        }
      },
    }
    useStore.setState({ ...useStore.getInitialState(), snap: true })
    useStore.getState().setHost(host)
    useStore.getState().load(
      [sketchNode('s1', 5, 7), sketchNode('s2', 300, 0, { locked: true })],
      [edge('e1', 's1', 'w1', { source_handle: 'l', target_handle: 'r' })],
    )
  })

  const patch = {
    nodes: {
      s1: { position: { x: 123, y: 77 }, size: { w: 111, h: 55 } },
      s2: { position: { x: 1, y: 1 } },
      w1: { position: { x: 13, y: 17 }, size: { w: 301, h: 201 } },
      w2: { position: { x: 9, y: 9 } },
      nope: { position: { x: 1, y: 1 } },
    },
    edges: { e1: { source_handle: 'r' as const, target_handle: 'l' as const }, nope: { source_handle: 't' as const } },
  }

  it('applies sketch nodes, host nodes and connector sides without snapping, and skips locked and unknown ones', () => {
    const count = useStore.getState().applyLayout(patch)
    const st = useStore.getState()
    expect(count).toBe(3)
    expect(st.nodes[0].position).toEqual({ x: 123, y: 77 })
    expect(st.nodes[0].size).toEqual({ w: 111, h: 55 })
    expect(st.nodes[1].position).toEqual({ x: 300, y: 0 })
    expect(geo.w1).toMatchObject({ position: { x: 13, y: 17 }, size: { w: 301, h: 201 } })
    expect(geo.w2.position).toEqual({ x: 400, y: 0 })
    expect(st.edges[0]).toMatchObject({ source_handle: 'r', target_handle: 'l' })
  })

  it('is one undo step, and redo puts it back', () => {
    useStore.getState().applyLayout(patch)
    useStore.getState().undo()
    const st = useStore.getState()
    expect(st.nodes[0].position).toEqual({ x: 5, y: 7 })
    expect(st.nodes[0].size).toEqual({ w: 100, h: 50 })
    expect(geo.w1).toMatchObject({ position: { x: 0, y: 0 }, size: { w: 300, h: 200 } })
    expect(st.edges[0]).toMatchObject({ source_handle: 'l', target_handle: 'r' })
    expect(st.history.past).toHaveLength(0)
    useStore.getState().redo()
    expect(useStore.getState().nodes[0].position).toEqual({ x: 123, y: 77 })
    expect(geo.w1.position).toEqual({ x: 13, y: 17 })
  })

  it('sets and clears a connector label offset', () => {
    useStore.getState().applyLayout({ nodes: {}, edges: { e1: { label_offset: 24 } } })
    expect(useStore.getState().edges[0]).toMatchObject({ source_handle: 'l', label_offset: 24 })
    useStore.getState().applyLayout({ nodes: {}, edges: { e1: { label_offset: 0 } } })
    expect(useStore.getState().edges[0]).not.toHaveProperty('label_offset')
    useStore.getState().undo()
    expect(useStore.getState().edges[0].label_offset).toBe(24)
  })

  it('removes a side when the patch clears it, and does nothing (no undo step) when nothing applies', () => {
    useStore.getState().applyLayout({ nodes: {}, edges: { e1: { source_handle: null } } })
    expect(useStore.getState().edges[0].source_handle).toBeUndefined()
    expect(useStore.getState().edges[0].target_handle).toBe('r')
    const steps = useStore.getState().history.past.length
    expect(useStore.getState().applyLayout({ nodes: { s2: { position: { x: 9, y: 9 } } }, edges: {} })).toBe(0)
    expect(useStore.getState().history.past).toHaveLength(steps)
  })
})

describe('currentDoc and applyChanges with the shared stores', () => {
  beforeEach(() => {
    useCanvasStore.getState().loadState({
      canvasName: 'plan',
      viewport: { x: 0, y: 0, zoom: 1 },
      windows: [{ id: 'w1', type: 'query', title: 'query_1', position: { x: 0, y: 0 }, size: { w: 300, h: 200 }, sql: 'SELECT 1' }],
    })
    useSketchStore.getState().setHost({
      nodes: () =>
        useCanvasStore.getState().windows.map((w) => ({ id: w.id, type: w.type, position: w.position, size: w.size, title: w.title })),
      patch: (p) => useCanvasStore.getState().patchGeometry(p),
    })
    useSketchStore.getState().load([sketchNode('s1', 400, 0)], [edge('e1', 's1', 'w1')])
  })

  it('builds the canvas the routes read, with windows first and the connectors', () => {
    const doc = currentDoc()
    expect(doc.version).toBe(2)
    expect(doc.name).toBe('plan')
    expect(doc.windows.map((w) => w.id)).toEqual(['w1', 's1'])
    expect(doc.edges?.map((e) => e.id)).toEqual(['e1'])
  })

  it('applies changes to both stores as one undo step', () => {
    const n = applyChanges([
      node('w1', 20, 40, 300, 200),
      node('s1', 420, 40, 100, 50),
      { kind: 'edge', id: 'e1', from: { source_handle: null, target_handle: null }, to: { source_handle: 'l', target_handle: 'r' } },
    ])
    expect(n).toBe(3)
    expect(useCanvasStore.getState().windows[0].position).toEqual({ x: 20, y: 40 })
    expect(useSketchStore.getState().nodes[0].position).toEqual({ x: 420, y: 40 })
    useSketchStore.getState().undo()
    expect(useCanvasStore.getState().windows[0].position).toEqual({ x: 0, y: 0 })
    expect(useSketchStore.getState().nodes[0].position).toEqual({ x: 400, y: 0 })
    expect(useSketchStore.getState().edges[0].source_handle).toBeUndefined()
  })
})

describe('texts and menu', () => {
  it('words the result', () => {
    expect(plural(1, 'item')).toBe('1 item')
    expect(plural(2, 'item')).toBe('2 items')
    expect(appliedNote(0, 80, 80)).toBe('Nothing to change.')
    expect(appliedNote(3, 60, 90)).toContain('score 60 to 90')
  })
  it('offers grid, row, column and both layered directions', () => {
    expect(ARRANGE_CHOICES.map((c) => [c.mode, c.options?.direction])).toEqual([
      ['grid', undefined],
      ['row', undefined],
      ['column', undefined],
      ['layered', 'LR'],
      ['layered', 'TB'],
    ])
  })
})
