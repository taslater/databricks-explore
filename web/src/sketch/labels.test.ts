import { describe, expect, it } from 'vitest'
import { fitSize, labelCenters, labelNeeds, MAX_FIT_W, segmentsOf } from './labels'
import { fittedSize, newSketchNode, withLabel } from './model'
import { createSketchStore } from './sketchStore'
import type { SketchEdge, SketchNode } from './types'

// The numbers below were computed by layout.py (fit_size and edge_label_boxes). The two files are one rule.

const shape = (over: Partial<SketchNode>): SketchNode => ({
  id: 's1',
  type: 'shape',
  shape: 'rect',
  position: { x: 0, y: 0 },
  size: { w: 140, h: 80 },
  ...over,
})

describe('fitSize', () => {
  it('matches layout.py on a spread of labels', () => {
    expect(fitSize(shape({ shape: 'cylinder', label: 'samples.tpch.orders', size: { w: 100, h: 120 } }))).toEqual({ w: 184, h: 120 })
    expect(fitSize(shape({ shape: 'rounded', label: Array(14).fill('wrapping').join(' ') }))).toEqual({ w: 320, h: 81 })
    expect(fitSize(shape({ type: 'text', label: 'Revenue by customer segment\nand month', font_size: 16, size: { w: 140, h: 40 } }))).toEqual({ w: 258, h: 50 })
    expect(fitSize(shape({ shape: 'diamond', label: 'x'.repeat(80), size: { w: 120, h: 100 } }))).toEqual({ w: 1287, h: 100 })
    expect(fitSize(shape({ type: 'frame', label: 'A frame title that is long', size: { w: 100, h: 100 } }))).toEqual({ w: 220, h: 100 })
    expect(fitSize(shape({ type: 'sticky', label: 'short', size: { w: 160, h: 160 } }))).toEqual({ w: 160, h: 160 })
  })

  it('never shrinks, caps the width by wrapping, and leaves the result fitting', () => {
    expect(fitSize(shape({ label: 'tiny', size: { w: 400, h: 300 } }))).toEqual({ w: 400, h: 300 })
    const n = shape({ label: Array(14).fill('wrapping').join(' ') })
    const size = fitSize(n)
    expect(size.w).toBe(MAX_FIT_W)
    expect(size.h).toBeGreaterThan(80)
    expect(labelNeeds({ ...n, size })).toBeNull()
    expect(labelNeeds(shape({ label: '', size: { w: 10, h: 10 } }))).toBeNull()
  })

  it('sizes a placeholder by its table name', () => {
    const ph = shape({ type: 'placeholder', size: { w: 100, h: 100 }, placeholder: { id: 'x', name: 'a_long_placeholder_table_name', columns: [] } })
    expect(fitSize(ph).w).toBeGreaterThan(100)
  })
})

describe('a label commit sizes the node unless it was resized', () => {
  const fresh = () => newSketchNode('s1', 'shape', { x: 0, y: 0 }, { shape: 'cylinder' })

  it('grows a node still at its default size, and shrinks back when the label gets short', () => {
    const grown = withLabel(fresh(), 'samples.tpch.orders', false)
    expect(grown.size).toEqual({ w: 184, h: 120 })
    expect(withLabel(grown, 'orders', false).size).toEqual({ w: 100, h: 120 })
  })

  it('keeps a size the person set', () => {
    const resized = { ...fresh(), size: { w: 260, h: 90 } }
    expect(withLabel(resized, 'samples.tpch.orders', false).size).toEqual({ w: 260, h: 90 })
    const drawn = { ...fresh(), size: { w: 100, h: 120 + 20 } }
    expect(withLabel(drawn, 'samples.tpch.orders', false).size).toEqual({ w: 100, h: 140 })
  })

  it('rounds up to the grid when snapping, and still recognizes its own size afterwards', () => {
    const grown = withLabel(fresh(), 'samples.tpch.orders', true)
    expect(grown.size).toEqual({ w: 200, h: 120 })
    expect(fittedSize(grown, 'samples.tpch.orders', true)).toEqual(grown.size)
    expect(withLabel(grown, 'orders', true).size).toEqual({ w: 100, h: 120 })
  })

  it('goes through the store: one undo step restores the label and the size', () => {
    const store = createSketchStore()
    const id = store.getState().addNode('shape', { x: 0, y: 0 }, { shape: 'cylinder' })
    store.getState().setSnap(false)
    store.getState().setLabel(id, 'samples.tpch.orders')
    expect(store.getState().nodes[0]).toMatchObject({ label: 'samples.tpch.orders', size: { w: 184, h: 120 } })
    store.getState().undo()
    expect(store.getState().nodes[0]).toMatchObject({ label: '', size: { w: 100, h: 120 } })
  })
})

describe('connector label placement', () => {
  const box = (id: string, x: number, y: number) => ({ id, position: { x, y }, size: { w: 120, h: 60 } })
  const nodes = [box('a', 0, 0), box('b', 0, 300), box('t', 500, 150), box('u', 0, 600), box('v', 300, 600)]
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
  const edges = [
    edge('e1', 'a', 't', { source_handle: 'r', target_handle: 'l', label: 'source' }),
    edge('e2', 'b', 't', { source_handle: 'r', target_handle: 'l', label: 'join', label_offset: 25 }),
    edge('e3', 'u', 'v', { source_handle: 'r', target_handle: 'l', label: 'first' }),
    edge('e4', 'u', 'v', { source_handle: 'r', target_handle: 'l', label: 'second' }),
    edge('e5', 'a', 'u', { line: 'straight', label: 'down' }),
    edge('e6', 'v', 't', { label: 'bend\ntwo' }),
    edge('e7', 'a', 'b'),
    edge('e8', 'a', 'a', { label: 'loop' }),
    edge('e9', 'a', 'zzz', { label: 'dangling' }),
  ]

  it('matches layout.py: the middle of the longest segment nobody else runs along, plus the offset', () => {
    const c = labelCenters(nodes, edges)
    expect(Object.keys(c).sort()).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6'])
    expect(c.e1).toEqual({ x: 215, y: 30 })
    expect(c.e2).toEqual({ x: 240, y: 330 }) // 215 plus the offset of 25
    expect(c.e3).toEqual({ x: 210, y: 630 }) // parallel connectors share every segment: the longest, with no nudge
    expect(c.e4).toEqual(c.e3)
    expect(c.e5).toEqual({ x: 60, y: 330 })
    expect(c.e6).toEqual({ x: 460, y: 405 })
  })

  it('clamps the offset to the segment', () => {
    const far = labelCenters(nodes, [edge('e1', 'a', 't', { source_handle: 'r', target_handle: 'l', label: 'x', label_offset: 9999 })])
    expect(far.e1).toEqual({ x: 310, y: 30 })
  })

  it('merges a route that doubles back along one line into a single segment', () => {
    expect(segmentsOf([[0, 0], [90, 0], [90, 0], [180, 0]])).toEqual([[[0, 0], [180, 0]]])
  })
})
