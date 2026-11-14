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
