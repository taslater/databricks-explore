import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasRevision } from '../../api/agent'

const { api, revisionApi } = vi.hoisted(() => ({ api: { getCanvas: vi.fn() }, revisionApi: { getCanvasRevision: vi.fn() } }))
vi.mock('../../api/client', async (original) => ({ ...(await original<object>()), ...api }))
vi.mock('../../api/agent', async (original) => ({ ...(await original<object>()), ...revisionApi }))

import { useCanvasStore } from '../../store/canvasStore'
import { useSketchStore } from '../../sketch/sketchStore'
import { decideSync, handleRemote, pollNow, reloadInPlace } from './canvasSync'
import { usePersistStore } from './persistStore'
import { useSyncStore } from './syncStore'

const rev = (revision: number, by: CanvasRevision['by'] = 'agent', snapshots = 1): CanvasRevision => ({ name: 'd', revision, by, snapshots })

const file = (labels: string[]) => ({
  version: 2,
  name: 'd',
  profile: null,
  viewport: { x: 0, y: 0, zoom: 1 },
  windows: labels.map((label, i) => ({
    id: `s${i + 1}`,
    type: 'shape',
    shape: 'rect',
    label,
    position: { x: i * 200, y: 0 },
    size: { w: 100, h: 50 },
  })),
  edges: [],
})

const labels = () => useSketchStore.getState().nodes.map((n) => n.label)

beforeEach(() => {
  api.getCanvas.mockReset()
  revisionApi.getCanvasRevision.mockReset()
  useCanvasStore.setState({ canvasName: 'd', windows: [], viewport: { x: 40, y: 50, zoom: 1.5 } })
  useSketchStore.getState().load([], [])
  usePersistStore.setState({ phase: 'saved', savedJson: null, fileProfile: null })
  useSyncStore.setState({ known: { name: 'd', revision: 3 }, remote: null, conflict: null, keepRequests: 0 })
})

describe('decideSync', () => {
  const known = { name: 'd', revision: 3 }
  it('does nothing without a newer revision', () => {
    expect(decideSync(known, rev(3), 'saved')).toBe('none')
    expect(decideSync(known, rev(2), 'saved')).toBe('none')
    expect(decideSync(null, rev(9), 'saved')).toBe('none')
    expect(decideSync(known, { ...rev(9), name: 'other' }, 'saved')).toBe('none')
  })
  it('reloads when the page has no unsaved edits', () => {
    expect(decideSync(known, rev(4), 'saved')).toBe('reload')
  })
  it('asks when the page has unsaved edits, or its last save failed', () => {
    expect(decideSync(known, rev(4), 'unsaved')).toBe('banner')
    expect(decideSync(known, rev(4), 'error')).toBe('banner')
  })
  it('waits while a save is in flight, since the answer may be its own write', () => {
    expect(decideSync(known, rev(4), 'saving')).toBe('none')
  })
})

describe('reloadInPlace', () => {
  it('loads the saved canvas, keeps the viewport the person has, and takes the new revision', async () => {
    api.getCanvas.mockResolvedValue({ ...file(['from agent']), viewport: { x: 0, y: 0, zoom: 1 } })
    expect(await reloadInPlace(rev(4))).toBe(true)
    expect(labels()).toEqual(['from agent'])
    expect(useCanvasStore.getState().viewport).toEqual({ x: 40, y: 50, zoom: 1.5 })
    expect(useSyncStore.getState().known).toEqual({ name: 'd', revision: 4 })
    expect(usePersistStore.getState().phase).toBe('saved')
    expect(usePersistStore.getState().savedJson).not.toBeNull() // so the autosave this load triggers is a no-op
  })

  it('does not touch edits made while it was fetching', async () => {
    api.getCanvas.mockImplementation(async () => {
      usePersistStore.setState({ phase: 'unsaved' })
      return file(['from agent'])
    })
    expect(await reloadInPlace(rev(4))).toBe(false)
    expect(labels()).toEqual([])
    expect(useSyncStore.getState().known?.revision).toBe(3)
  })

  it('does nothing when another canvas is open by then', async () => {
    api.getCanvas.mockResolvedValue(file(['x']))
    useCanvasStore.setState({ canvasName: 'other' })
    expect(await reloadInPlace(rev(4))).toBe(false)
  })

  it('force (the banner Reload) discards unsaved edits and clears the banner', async () => {
    usePersistStore.setState({ phase: 'unsaved' })
    useSyncStore.setState({ conflict: rev(4) })
    api.getCanvas.mockResolvedValue(file(['theirs']))
    expect(await reloadInPlace(rev(4), true)).toBe(true)
    expect(labels()).toEqual(['theirs'])
    expect(useSyncStore.getState().conflict).toBeNull()
    expect(usePersistStore.getState().phase).toBe('saved')
  })
})

describe('handleRemote', () => {
  it('reloads silently when the page has no edits', async () => {
    api.getCanvas.mockResolvedValue(file(['a', 'b']))
    await handleRemote(rev(4))
    expect(labels()).toEqual(['a', 'b'])
    expect(useSyncStore.getState().conflict).toBeNull()
    expect(useSyncStore.getState().remote?.revision).toBe(4)
  })

  it('shows the banner, and leaves the page alone, when there are unsaved edits', async () => {
    usePersistStore.setState({ phase: 'unsaved' })
    await handleRemote(rev(4))
    expect(api.getCanvas).not.toHaveBeenCalled()
    expect(useSyncStore.getState().conflict).toEqual(rev(4))
    expect(useSyncStore.getState().known?.revision).toBe(3)
  })

  it('ignores the revision of the page\'s own save', async () => {
    useSyncStore.setState({ known: { name: 'd', revision: 4 } })
    await handleRemote(rev(4, 'ui', 0))
    expect(api.getCanvas).not.toHaveBeenCalled()
    expect(useSyncStore.getState().conflict).toBeNull()
  })

  it('starts from the server revision when the page had none yet', async () => {
    useSyncStore.setState({ known: null })
    await handleRemote(rev(7))
    expect(useSyncStore.getState().known).toEqual({ name: 'd', revision: 7 })
    expect(api.getCanvas).not.toHaveBeenCalled()
  })

  it('ignores an answer for a canvas that is no longer open', async () => {
    useCanvasStore.setState({ canvasName: 'other' })
    await handleRemote(rev(9))
    expect(useSyncStore.getState().remote).toBeNull()
  })
})

describe('keep mine', () => {
  it('takes the newer revision as the base, closes the banner and asks for a save', () => {
    useSyncStore.setState({ conflict: rev(4) })
    useSyncStore.getState().keepMine()
    const s = useSyncStore.getState()
    expect(s.conflict).toBeNull()
    expect(s.known).toEqual({ name: 'd', revision: 4 })
    expect(s.keepRequests).toBe(1)
  })

  it('does nothing without a banner', () => {
    useSyncStore.getState().keepMine()
    expect(useSyncStore.getState().keepRequests).toBe(0)
  })
})

describe('pollNow', () => {
  it('asks for the open canvas and applies the answer', async () => {
    revisionApi.getCanvasRevision.mockResolvedValue(rev(5))
    api.getCanvas.mockResolvedValue(file(['polled']))
    await pollNow()
    expect(revisionApi.getCanvasRevision).toHaveBeenCalledWith('d')
    expect(labels()).toEqual(['polled'])
  })

  it('swallows a failing poll and does nothing with no open canvas', async () => {
    revisionApi.getCanvasRevision.mockRejectedValue(new Error('down'))
    await expect(pollNow()).resolves.toBeUndefined()
    useCanvasStore.setState({ canvasName: null })
    revisionApi.getCanvasRevision.mockClear()
    await pollNow()
    expect(revisionApi.getCanvasRevision).not.toHaveBeenCalled()
  })
})
