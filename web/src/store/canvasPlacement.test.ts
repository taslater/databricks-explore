import { beforeEach, describe, expect, it } from 'vitest'
import { useCanvasStore } from './canvasStore'
import { SCREEN_KEEP_OUT } from '../canvas/placement'
import { useRunStore } from '../canvas/runState'

beforeEach(() => {
  useCanvasStore.setState({ windows: [], maximizedId: null, canvasName: null, viewport: { x: 0, y: 0, zoom: 1 } })
  useRunStore.getState().clearAll()
})

function rectOf(id: string) {
  const w = useCanvasStore.getState().windows.find((x) => x.id === id)!
  return { x: w.position.x, y: w.position.y, w: w.size.w, h: w.size.h }
}

function overlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

describe('placing new windows', () => {
  it('moves a second window off the first instead of stacking it', () => {
    const a = useCanvasStore.getState().addQueryWindow({ x: 500, y: 300 })
    const b = useCanvasStore.getState().addQueryWindow({ x: 500, y: 300 })
    expect(overlap(rectOf(a), rectOf(b))).toBe(false)
  })

  it('keeps notes and table cards off existing windows too', () => {
    const q = useCanvasStore.getState().addQueryWindow({ x: 500, y: 300 })
    const n = useCanvasStore.getState().addNoteWindow({ x: 600, y: 400 })
    const t = useCanvasStore.getState().addTableWindow({ x: 600, y: 400 }, 'dev.crm.dim_customer')
    expect(overlap(rectOf(q), rectOf(n))).toBe(false)
    expect(overlap(rectOf(q), rectOf(t))).toBe(false)
    expect(overlap(rectOf(n), rectOf(t))).toBe(false)
  })

  it('does not put a window under the toolbar or palette at the top-left', () => {
    const id = useCanvasStore.getState().addQueryWindow({ x: 0, y: 0 })
    for (const k of SCREEN_KEEP_OUT) expect(overlap(rectOf(id), k)).toBe(false)
  })

  it('keeps a free spot beside a card for "Query this"', () => {
    const card = useCanvasStore.getState().addTableWindow({ x: 500, y: 300 }, 'dev.crm.dim_customer')
    const c = rectOf(card)
    const id = useCanvasStore.getState().addQueryWindowWithSql({ x: c.x + c.w + 40, y: c.y }, 'SELECT 1')
    expect(rectOf(id)).toMatchObject({ x: c.x + c.w + 40, y: c.y })
  })
})

describe('run state of deleted windows', () => {
  it('is cleared when a window is deleted', () => {
    const id = useCanvasStore.getState().addQueryWindow({ x: 500, y: 300 })
    useRunStore.getState().begin(id, ['select 1'])
    useCanvasStore.getState().removeWindow(id)
    expect(useRunStore.getState().runs[id]).toBeUndefined()
  })

  it('is cleared when a different canvas is opened, and kept for a live reload of the same one', () => {
    const id = useCanvasStore.getState().addQueryWindow({ x: 500, y: 300 })
    const win = useCanvasStore.getState().windows[0]
    const vp = { x: 0, y: 0, zoom: 1 }
    useCanvasStore.getState().loadState({ canvasName: 'a', viewport: vp, windows: [win] })
    useRunStore.getState().begin(id, ['select 1'])
    useCanvasStore.getState().loadState({ canvasName: 'a', viewport: vp, windows: [win] })
    expect(useRunStore.getState().runs[id]).toBeDefined()
    useCanvasStore.getState().loadState({ canvasName: 'b', viewport: vp, windows: [win] })
    expect(useRunStore.getState().runs[id]).toBeUndefined()
  })
})
