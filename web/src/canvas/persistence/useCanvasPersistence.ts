// Save, Save as, Open, and autosave for the canvas. Writes go through the TanStack hooks
// (useSaveCanvas, useSetWarehouse) and the cached GET (fetchQuery), so cache keys match
// the rest of the app. Every write and open runs on one queue, so saves never overlap.
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import * as api from '../../api/client'
import { useSaveCanvas, useSetWarehouse } from '../../api/hooks'
import { useCanvasStore } from '../../store/canvasStore'
import { useUiStore } from '../../store/uiStore'
import { fromCanvasFile, parseCanvasFile, toCanvasFile, type CanvasFile } from './canvasFile'
import { usePersistStore } from './persistStore'

export const AUTOSAVE_DELAY_MS = 1500

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Validated file for the current state, plus its JSON for change detection. Throws on invalid state. */
function buildFile(name: string, profile: string): { file: CanvasFile; json: string } {
  const { viewport, windows } = useCanvasStore.getState()
  const warehouseId = useUiStore.getState().warehouseId
  const file = parseCanvasFile(toCanvasFile({ viewport, windows }, { name, profile, warehouseId }))
  return { file, json: JSON.stringify(file) }
}

export interface CanvasPersistence {
  /** Writes the current canvas under its own name. Caller handles unnamed canvases. */
  saveCurrent: () => Promise<void>
  /** Writes the current canvas under a new name and makes that the canvas name. Resolves true on success. */
  saveAs: (name: string) => Promise<boolean>
  /** Loads a saved canvas into the store. Pending edits to the current canvas are saved first. */
  open: (name: string) => Promise<void>
}

/**
 * Canvas persistence actions. Mount it once, in the toolbar. It subscribes to window
 * changes for autosave. Unmounting (switching to the graph view) saves pending edits.
 */
export function useCanvasPersistence(): CanvasPersistence {
  const qc = useQueryClient()
  const saveMutation = useSaveCanvas()
  const setWarehouseMutation = useSetWarehouse()

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const queue = useRef<Promise<unknown>>(Promise.resolve())

  // Closures below are created once (by the subscription). They read the latest hooks through this ref.
  const latest = useRef({
    save: saveMutation.mutateAsync,
    setWarehouse: setWarehouseMutation.mutateAsync,
    qc,
  })
  useEffect(() => {
    latest.current = { save: saveMutation.mutateAsync, setWarehouse: setWarehouseMutation.mutateAsync, qc }
  })

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.current.then(task, task)
    queue.current = run.catch(() => undefined)
    return run
  }

  function cancelTimer() {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  /** Writes `name` with the current state. Skips the request when nothing changed since the last write. */
  async function writeCanvas(name: string, adopt: boolean): Promise<boolean> {
    const profile = useUiStore.getState().connectedProfile
    if (profile === null) {
      usePersistStore.getState().setStatus('error', 'Connect to a profile before saving.', true)
      return false
    }
    const { windows } = useCanvasStore.getState()
    let built: { file: CanvasFile; json: string }
    try {
      built = buildFile(name, profile)
    } catch (e) {
      usePersistStore.getState().setStatus('error', errorText(e), true)
      return false
    }
    const persist = usePersistStore.getState()
    if (!adopt && name === useCanvasStore.getState().canvasName && built.json === persist.savedJson) {
      persist.markSaved(built.json)
      return true
    }

    persist.setStatus('saving')
    try {
      await latest.current.save(built.file)
    } catch (e) {
      usePersistStore.getState().setStatus('error', errorText(e), true)
      return false
    }

    if (adopt) useCanvasStore.getState().setCanvasName(name)
    if (useCanvasStore.getState().windows === windows) {
      usePersistStore.getState().markSaved(built.json)
    } else {
      // Edits arrived while the request was in flight. Record what was written, then save again.
      usePersistStore.setState({ savedJson: built.json })
      scheduleAutosave()
    }
    return true
  }

  /** Saves pending autosave edits now. Used before switching canvases and on unmount. */
  async function flushPending() {
    if (timer.current === null) return
    cancelTimer()
    const name = useCanvasStore.getState().canvasName
    if (name !== null) await writeCanvas(name, false)
  }

  function scheduleAutosave() {
    const name = useCanvasStore.getState().canvasName
    // A new canvas has no name yet. It never autosaves.
    if (name === null) {
      usePersistStore.getState().setStatus('unnamed')
      return
    }
    usePersistStore.getState().setStatus('unsaved')
    cancelTimer()
    timer.current = setTimeout(() => {
      timer.current = null
      void enqueue(async () => {
        const current = useCanvasStore.getState().canvasName
        if (current !== null) await writeCanvas(current, false)
      })
    }, AUTOSAVE_DELAY_MS)
  }

  useEffect(() => {
    const unsubscribe = useCanvasStore.subscribe((s, prev) => {
      if (s.windows !== prev.windows) scheduleAutosave()
    })
    return () => {
      unsubscribe()
      if (timer.current !== null) void enqueue(flushPending)
    }
    // The functions used here only read refs and stores, so subscribing once on mount is correct.
  }, [])

  function saveCurrent(): Promise<void> {
    return enqueue(async () => {
      cancelTimer()
      const name = useCanvasStore.getState().canvasName
      if (name !== null) await writeCanvas(name, false)
    })
  }

  function saveAs(name: string): Promise<boolean> {
    return enqueue(async () => {
      await flushPending()
      return writeCanvas(name, true)
    })
  }

  function open(name: string): Promise<void> {
    return enqueue(async () => {
      await flushPending()

      let file: CanvasFile
      try {
        const raw = await latest.current.qc.fetchQuery({
          queryKey: ['canvas', name],
          queryFn: () => api.getCanvas(name),
          staleTime: 0,
          retry: false,
        })
        file = parseCanvasFile(raw)
      } catch (e) {
        usePersistStore.getState().setStatus('error', `Open failed: ${errorText(e)}`, true)
        return
      }

      // The canvas's warehouse becomes the top-bar selection when it differs and a profile is connected.
      let warehouseError: string | null = null
      const ui = useUiStore.getState()
      if (file.warehouse_id && ui.connectedProfile !== null && file.warehouse_id !== ui.warehouseId) {
        try {
          await latest.current.setWarehouse(file.warehouse_id)
          useUiStore.getState().setWarehouseId(file.warehouse_id)
        } catch (e) {
          warehouseError = `Could not select warehouse ${file.warehouse_id}: ${errorText(e)}`
        }
      }

      // loadState schedules an autosave through the subscription. The baseline below turns that
      // into a no-op, so opening a canvas never writes it back.
      useCanvasStore.getState().loadState(fromCanvasFile(file))
      const after = useUiStore.getState()
      const profile = after.connectedProfile ?? file.profile
      let baseline: string
      try {
        baseline = buildFile(name, profile).json
      } catch (e) {
        usePersistStore.getState().setStatus('error', `Open failed: ${errorText(e)}`, true)
        return
      }
      usePersistStore.getState().markSaved(baseline)

      const notices: string[] = []
      if (warehouseError) notices.push(warehouseError)
      if (after.connectedProfile !== null && file.profile !== after.connectedProfile) {
        notices.push(
          `Saved under profile "${file.profile}". Connected to "${after.connectedProfile}", so saving records that profile.`,
        )
      }
      if (notices.length > 0) usePersistStore.getState().setStatus('saved', notices.join(' '), warehouseError !== null)
    })
  }

  return { saveCurrent, saveAs, open }
}
