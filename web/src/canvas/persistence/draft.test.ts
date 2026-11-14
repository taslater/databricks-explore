import { beforeEach, describe, expect, it } from 'vitest'
import { useCanvasStore } from '../../store/canvasStore'
import { useSketchStore } from '../../sketch/sketchStore'
import { DRAFT_KEY, decodeDraft, encodeDraft, hasUnsavedWork, restoreDraft, writeDraft } from './draft'
import { buildFile } from './useCanvasPersistence'
import { usePersistStore } from './persistStore'

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.map.set(k, v)
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
}

const note = {
  id: 'w1',
  type: 'note' as const,
  title: 'note_1',
  position: { x: 10, y: 20 },
  size: { w: 320, h: 220 },
  text: 'hello',
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true })
  useCanvasStore.setState({ canvasName: null, windows: [], viewport: { x: 5, y: 6, zoom: 0.5 } })
  useSketchStore.getState().load([], [])
  usePersistStore.setState({ phase: 'unnamed', message: null, messageIsError: false })
})

describe('hasUnsavedWork', () => {
  it('is true for an unnamed canvas with content and false when it is empty', () => {
    expect(hasUnsavedWork('unnamed', null, 2)).toBe(true)
    expect(hasUnsavedWork('unnamed', null, 0)).toBe(false)
  })
  it('follows the save phase for a named canvas', () => {
    expect(hasUnsavedWork('saved', 'a', 3)).toBe(false)
    expect(hasUnsavedWork('unsaved', 'a', 3)).toBe(true)
    expect(hasUnsavedWork('saving', 'a', 3)).toBe(true)
    expect(hasUnsavedWork('error', 'a', 3)).toBe(true)
  })
})

describe('encodeDraft and decodeDraft', () => {
  it('keeps nothing for an empty canvas', () => {
    expect(encodeDraft('{}', 0)).toBeNull()
  })
  it('round-trips a canvas file', () => {
    useCanvasStore.setState({ windows: [note] })
    const { json } = buildFile('draft', null)
    const file = decodeDraft(encodeDraft(json, 1))
    expect(file?.windows).toHaveLength(1)
    expect(file?.viewport).toEqual({ x: 5, y: 6, zoom: 0.5 })
  })
  it('rejects missing, damaged and foreign entries', () => {
    expect(decodeDraft(null)).toBeNull()
    expect(decodeDraft('not json')).toBeNull()
    expect(decodeDraft(JSON.stringify({ v: 2, json: '{}' }))).toBeNull()
    expect(decodeDraft(JSON.stringify({ v: 1, json: '{"version":2}' }))).toBeNull()
  })
})

describe('writeDraft and restoreDraft', () => {
  it('stores the unnamed canvas and restores it into an empty one', () => {
    useCanvasStore.setState({ windows: [note] })
    writeDraft()
    expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull()

    useCanvasStore.setState({ windows: [], viewport: { x: 0, y: 0, zoom: 1 } })
    expect(restoreDraft()).toBe(true)
    const s = useCanvasStore.getState()
    expect(s.canvasName).toBeNull()
    expect(s.windows.map((w) => w.id)).toEqual(['w1'])
    expect(s.viewport).toEqual({ x: 5, y: 6, zoom: 0.5 })
    expect(usePersistStore.getState().phase).toBe('unnamed')
  })

  it('removes the draft once the canvas has a name or is empty', () => {
    useCanvasStore.setState({ windows: [note] })
    writeDraft()
    useCanvasStore.setState({ canvasName: 'saved-one' })
    writeDraft()
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()

    useCanvasStore.setState({ canvasName: null, windows: [note] })
    writeDraft()
    useCanvasStore.setState({ windows: [] })
    writeDraft()
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull()
  })

  it('does not overwrite a canvas that already has content or a name', () => {
    useCanvasStore.setState({ windows: [note] })
    writeDraft()
    expect(restoreDraft()).toBe(false)
    useCanvasStore.setState({ windows: [], canvasName: 'x' })
    expect(restoreDraft()).toBe(false)
  })
})
