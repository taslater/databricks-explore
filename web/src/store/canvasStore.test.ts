import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_EDITOR_SPLIT,
  DEFAULT_QUERY_SIZE,
  NEW_WINDOW_EDITOR_SPLIT,
  useCanvasStore,
} from './canvasStore'
import { useRunStore } from '../canvas/runState'

beforeEach(() => {
  useCanvasStore.setState({ windows: [], maximizedId: null, canvasName: null })
  useRunStore.getState().clearAll()
})

describe('new query windows', () => {
  it('start big, with a 30% editor, so the results get room', () => {
    const id = useCanvasStore.getState().addQueryWindow({ x: 0, y: 0 })
    const w = useCanvasStore.getState().windows.find((x) => x.id === id)!
    expect(w.size).toEqual({ w: 760, h: 520 })
    expect(DEFAULT_QUERY_SIZE).toEqual({ w: 760, h: 520 })
    expect(w.editor_split).toBe(30)
    expect(NEW_WINDOW_EDITOR_SPLIT).toBe(30)
  })

  it('leave the fallback split alone for windows saved without one', () => {
    expect(DEFAULT_EDITOR_SPLIT).toBe(40)
  })
})

describe('maximizing', () => {
  it('is not part of the windows, so nothing about it is saved', () => {
    const id = useCanvasStore.getState().addQueryWindow({ x: 500, y: 300 })
    useCanvasStore.getState().setMaximized(id)
    const w = useCanvasStore.getState().windows[0]
    expect(useCanvasStore.getState().maximizedId).toBe(id)
    expect(w.position).toEqual({ x: 500, y: 300 })
    expect(w.size).toEqual({ w: 760, h: 520 })
  })

  it('clears when the window is deleted or another canvas is opened', () => {
    const s = useCanvasStore.getState()
    const id = s.addQueryWindow({ x: 0, y: 0 })
    s.setMaximized(id)
    s.removeWindow(id)
    expect(useCanvasStore.getState().maximizedId).toBeNull()

    const id2 = useCanvasStore.getState().addQueryWindow({ x: 0, y: 0 })
    useCanvasStore.getState().setMaximized(id2)
    useCanvasStore.getState().loadState({ canvasName: 'x', viewport: { x: 0, y: 0, zoom: 1 }, windows: [] })
    expect(useCanvasStore.getState().maximizedId).toBeNull()
  })
})

describe('adding a block of table cards at given positions', () => {
  it('keeps the positions, gives each a unique id and title, and returns the ids by table', () => {
    const ids = useCanvasStore.getState().addTableWindowsAt([
      { table: 'a.b.orders', position: { x: 10, y: 20 } },
      { table: 'c.d.orders', position: { x: 500, y: 20 } },
      { table: 'a.b.items', position: { x: 10, y: 400 } },
    ])
    const ws = useCanvasStore.getState().windows
    expect(ws.map((w) => [w.id, w.title, w.table, w.position])).toEqual([
      ['w1', 'orders', 'a.b.orders', { x: 10, y: 20 }],
      ['w2', 'orders_2', 'c.d.orders', { x: 500, y: 20 }],
      ['w3', 'items', 'a.b.items', { x: 10, y: 400 }],
    ])
    expect(ids).toEqual({ 'a.b.orders': 'w1', 'c.d.orders': 'w2', 'a.b.items': 'w3' })
    expect(ws.every((w) => w.type === 'table' && w.size.w === 320 && w.size.h === 300)).toBe(true)
  })
  it('does nothing for an empty list', () => {
    expect(useCanvasStore.getState().addTableWindowsAt([])).toEqual({})
    expect(useCanvasStore.getState().windows).toEqual([])
  })
})
