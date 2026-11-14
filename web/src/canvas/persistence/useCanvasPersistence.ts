// Save, Save as, Open, and autosave for the canvas. Writes go through the TanStack hooks
// (useSaveCanvas, useSetWarehouse) and the cached GET (fetchQuery), so cache keys match
// the rest of the app. Every write and open runs on one queue, so saves never overlap.
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import * as api from '../../api/client'
import { getCanvasRevision, saveCanvasChecked, SaveConflict } from '../../api/agent'
import type { CanvasDoc } from '../../api/types'
import { useSaveCanvas, useSetWarehouse } from '../../api/hooks'
import { useCanvasStore } from '../../store/canvasStore'
import { useSketchStore } from '../../sketch/sketchStore'
import { useUiStore } from '../../store/uiStore'
import { fromCanvasFile, parseCanvasFile, toCanvasFile, type CanvasFile } from './canvasFile'
import { usePersistStore } from './persistStore'
import { useSyncStore } from './syncStore'

export const AUTOSAVE_DELAY_MS = 1500

/** True when two file JSONs differ at most in the viewport (panning and zooming are not edits worth a banner). */
export function sameContent(a: string, b: string): boolean {
  const strip = (json: string) => {
    const { viewport: _viewport, ...rest } = JSON.parse(json) as Record<string, unknown>
    return JSON.stringify(rest)
  }
  return strip(a) === strip(b)
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** The profile a save records: the connected one, else the one the open file had, else none. */
export function saveProfile(): string | null {
  return useUiStore.getState().connectedProfile ?? usePersistStore.getState().fileProfile
}

/** Validated file for the current state, plus its JSON for change detection. Throws on invalid state. */
export function buildFile(name: string, profile: string | null): { file: CanvasFile; json: string } {
  const { viewport, windows } = useCanvasStore.getState()
  const { nodes: sketchNodes, edges } = useSketchStore.getState()
  const warehouseId = useUiStore.getState().warehouseId
  const file = parseCanvasFile(toCanvasFile({ viewport, windows, sketchNodes, edges }, { name, profile, warehouseId }))
  return { file, json: JSON.stringify(file) }
}

/** Puts a validated file into the canvas store and the sketch store. */
function applyFile(file: CanvasFile) {
  const loaded = fromCanvasFile(file)
  useCanvasStore.getState().loadState(loaded)
  useSketchStore.getState().load(loaded.sketchNodes, loaded.edges)
}

/** Lowest `diagram-N` that is not a saved canvas yet. */
export function nextDiagramName(existing: readonly string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()))
  let n = 1
  while (taken.has(`diagram-${n}`)) n++
  return `diagram-${n}`
}

export interface CanvasPersistence {
  /** Writes the current canvas under its own name. Caller handles unnamed canvases. */
  saveCurrent: () => Promise<void>
  /**
   * Writes the current canvas under a new name and makes that the canvas name. Resolves null on success, or the reason
   * the save failed (the server's refusal, for example). A failure leaves the status line as it was.
   */
  saveAs: (name: string) => Promise<string | null>
  /** Loads a saved canvas into the store. Pending edits to the current canvas are saved first. */
  open: (name: string) => Promise<void>
  /** Starts a blank canvas under a new `diagram-N` name. Needs no profile or warehouse. Saves pending edits first. */
  newDiagram: () => Promise<void>
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
    const profile = saveProfile()
    const { windows } = useCanvasStore.getState()
    const { nodes: sketchNodes, edges: sketchEdges } = useSketchStore.getState()
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
      // The server refuses (409) when something else saved this canvas since the revision the page has.
      const known = useSyncStore.getState().known
      const saved = await saveCanvasChecked(built.file as unknown as CanvasDoc, known !== null && known.name === name ? known.revision : null)
      void latest.current.qc.invalidateQueries({ queryKey: ['canvases'] })
      // The revision the server gave this write: the page has it, so the poll does not mistake it for someone else's.
      if (typeof saved?.revision === 'number') useSyncStore.getState().setKnown(name, saved.revision)
    } catch (e) {
      if (e instanceof SaveConflict) {
        // Nothing was written. A page whose only difference is the viewport has nothing to lose: the next poll reloads it.
        // Otherwise the banner offers Reload or Keep mine, and autosave waits for the choice.
        if (persist.savedJson !== null && sameContent(built.json, persist.savedJson)) {
          usePersistStore.getState().markSaved(persist.savedJson)
        } else {
          useSyncStore.getState().setConflict(e.remote)
          usePersistStore.getState().setStatus('unsaved')
        }
        return false
      }
      usePersistStore.getState().setStatus('error', errorText(e), true)
      return false
    }

    if (adopt) useCanvasStore.getState().setCanvasName(name)
    const after = useSketchStore.getState()
    if (
      useCanvasStore.getState().windows === windows &&
      after.nodes === sketchNodes &&
      after.edges === sketchEdges
    ) {
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
        // Something else saved this canvas while the page had edits: wait for Reload or Keep mine, do not overwrite it.
        if (useSyncStore.getState().conflict !== null) return
        const current = useCanvasStore.getState().canvasName
        if (current !== null) await writeCanvas(current, false)
      })
    }, AUTOSAVE_DELAY_MS)
  }

  useEffect(() => {
    const unsubscribe = useCanvasStore.subscribe((s, prev) => {
      if (s.windows !== prev.windows) scheduleAutosave()
    })
    // Sketch nodes and connectors are part of the file, so changing them saves too.
    const unsubscribeSketch = useSketchStore.subscribe((s, prev) => {
      if (s.nodes !== prev.nodes || s.edges !== prev.edges) scheduleAutosave()
    })
    // "Keep mine" on the agent-changed banner: write the page's version now.
    const unsubscribeSync = useSyncStore.subscribe((s, prev) => {
      if (s.keepRequests === prev.keepRequests) return
      void enqueue(async () => {
        const current = useCanvasStore.getState().canvasName
        if (current !== null) await writeCanvas(current, false)
      })
    })
    return () => {
      unsubscribe()
      unsubscribeSketch()
      unsubscribeSync()
      if (timer.current !== null) void enqueue(flushPending)
    }
    // The functions used here only read refs and stores, so subscribing once on mount is correct.
  }, [])

  function saveCurrent(): Promise<void> {
    useSyncStore.getState().keepMine() // an explicit Save is the person's choice to overwrite a newer revision
    return enqueue(async () => {
      cancelTimer()
      const name = useCanvasStore.getState().canvasName
      if (name !== null) await writeCanvas(name, false)
    })
  }

  function saveAs(name: string): Promise<string | null> {
    return enqueue(async () => {
      await flushPending()
      const { phase, message, messageIsError } = usePersistStore.getState()
      if (await writeCanvas(name, true)) return null
      // The reason goes to the caller's dialog. Put the status line back, so the toolbar does not repeat it.
      const failed = usePersistStore.getState()
      const reason = failed.messageIsError && failed.message ? failed.message : 'The canvas was not saved.'
      usePersistStore.getState().setStatus(phase, message, messageIsError)
      return reason
    })
  }

  function open(name: string): Promise<void> {
    return enqueue(async () => {
      await flushPending()

      // The revision first and the file second: a write in between only makes the page reload once more.
      const revision = await getCanvasRevision(name).then(
        (r) => r.revision,
        () => null,
      )

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

      // Loading schedules an autosave through the subscriptions. The baseline below turns that
      // into a no-op, so opening a canvas never writes it back (a version 1 file stays version 1 until it is changed).
      usePersistStore.setState({ fileProfile: file.profile ?? null })
      applyFile(file)
      const after = useUiStore.getState()
      const profile = saveProfile()
      let baseline: string
      try {
        baseline = buildFile(name, profile).json
      } catch (e) {
        usePersistStore.getState().setStatus('error', `Open failed: ${errorText(e)}`, true)
        return
      }
      usePersistStore.getState().markSaved(baseline)
      usePersistStore.setState((s) => ({ openSeq: s.openSeq + 1 }))
      useSyncStore.getState().setConflict(null)
      if (revision !== null) useSyncStore.getState().setKnown(name, revision)

      const notices: string[] = []
      if (warehouseError) notices.push(warehouseError)
      if (after.connectedProfile !== null && file.profile && file.profile !== after.connectedProfile) {
        notices.push(
          `Saved under profile "${file.profile}". Connected to "${after.connectedProfile}", so saving records that profile.`,
        )
      }
      if (notices.length > 0) usePersistStore.getState().setStatus('saved', notices.join(' '), warehouseError !== null)
    })
  }

  function newDiagram(): Promise<void> {
    return enqueue(async () => {
      await flushPending()
      let existing: string[] = []
      try {
        existing = await latest.current.qc.fetchQuery({ queryKey: ['canvases'], queryFn: api.listCanvases, staleTime: 0 })
      } catch {
        // The list is only for picking a free name. The save below reports a server problem.
      }
      const name = nextDiagramName(existing)
      usePersistStore.setState({ fileProfile: null })
      applyFile(parseCanvasFile({ version: 2, name, profile: null, windows: [], edges: [] }))
      await writeCanvas(name, true)
    })
  }

  return { saveCurrent, saveAs, open, newDiagram }
}
