// A draft of the unnamed canvas, kept in localStorage so a page reload does not drop it. A canvas with a name
// autosaves to the server instead, so only the unnamed one needs this. The draft is the same file the server
// stores (version 2, validated on the way in), under the placeholder name `draft`.
import { useEffect } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { useSketchStore } from '../../sketch/sketchStore'
import { fromCanvasFile, parseCanvasFile, type CanvasFile } from './canvasFile'
import { usePersistStore, type PersistPhase } from './persistStore'
import { buildFile } from './useCanvasPersistence'

export const DRAFT_KEY = 'canvasDraft'
export const DRAFT_DELAY_MS = 500
const DRAFT_NAME = 'draft'

interface StoredDraft {
  v: 1
  json: string
}

function storage(): Storage | null {
  try {
    return localStorage
  } catch {
    return null
  }
}

/** True when the page holds work the server does not have: edits waiting to save, a failed save, or an unnamed canvas with content. */
export function hasUnsavedWork(phase: PersistPhase, canvasName: string | null, itemCount: number): boolean {
  if (canvasName === null) return itemCount > 0
  return phase === 'unsaved' || phase === 'saving' || phase === 'error'
}

/** The text to keep for a draft, or null when the canvas has nothing in it to keep. */
export function encodeDraft(fileJson: string, itemCount: number): string | null {
  if (itemCount === 0) return null
  const draft: StoredDraft = { v: 1, json: fileJson }
  return JSON.stringify(draft)
}

/** The file inside stored draft text. Null for anything that is not a valid draft (a missing, old or damaged entry). */
export function decodeDraft(text: string | null): CanvasFile | null {
  if (text === null) return null
  try {
    const stored = JSON.parse(text) as Partial<StoredDraft>
    if (stored.v !== 1 || typeof stored.json !== 'string') return null
    return parseCanvasFile(JSON.parse(stored.json))
  } catch {
    return null
  }
}

export function clearDraft() {
  try {
    storage()?.removeItem(DRAFT_KEY)
  } catch {
    // Storage can be unavailable. Nothing was kept either.
  }
}

function itemCount(): number {
  return useCanvasStore.getState().windows.length + useSketchStore.getState().nodes.length
}

/** Writes the draft for the current unnamed canvas, or removes it when the canvas is named or empty. */
export function writeDraft() {
  if (useCanvasStore.getState().canvasName !== null) {
    clearDraft()
    return
  }
  try {
    const text = encodeDraft(buildFile(DRAFT_NAME, null).json, itemCount())
    if (text === null) clearDraft()
    else storage()?.setItem(DRAFT_KEY, text)
  } catch {
    // An invalid state or a full storage: the draft is skipped, the canvas itself is untouched.
  }
}

/** Puts a stored draft into an empty, unnamed canvas. Returns true when it did. */
export function restoreDraft(): boolean {
  if (useCanvasStore.getState().canvasName !== null || itemCount() > 0) return false
  let text: string | null = null
  try {
    text = storage()?.getItem(DRAFT_KEY) ?? null
  } catch {
    return false
  }
  const file = decodeDraft(text)
  if (file === null) return false
  const loaded = fromCanvasFile(file)
  if (loaded.windows.length + loaded.sketchNodes.length === 0) return false
  useCanvasStore.getState().loadState({ ...loaded, canvasName: null })
  useSketchStore.getState().load(loaded.sketchNodes, loaded.edges)
  usePersistStore.getState().setStatus('unnamed', 'Restored your unsaved canvas.')
  return true
}

/**
 * Keeps the draft of the unnamed canvas, restores it once on load, and warns before the page closes with unsaved work.
 * Mounted once in the top bar, which is always there, so it covers every view.
 */
export function useCanvasDraft() {
  useEffect(() => {
    restoreDraft()

    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        writeDraft()
      }, DRAFT_DELAY_MS)
    }
    const unsubscribeCanvas = useCanvasStore.subscribe((s, prev) => {
      if (s.windows !== prev.windows || s.canvasName !== prev.canvasName) schedule()
    })
    const unsubscribeSketch = useSketchStore.subscribe((s, prev) => {
      if (s.nodes !== prev.nodes || s.edges !== prev.edges) schedule()
    })

    function onBeforeUnload(e: BeforeUnloadEvent) {
      // The debounce may not have fired yet, so write now. The draft is the safety net, the warning is the prompt.
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
        writeDraft()
      }
      if (hasUnsavedWork(usePersistStore.getState().phase, useCanvasStore.getState().canvasName, itemCount())) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)

    return () => {
      unsubscribeCanvas()
      unsubscribeSketch()
      window.removeEventListener('beforeunload', onBeforeUnload)
      if (timer !== null) {
        clearTimeout(timer)
        writeDraft()
      }
    }
  }, [])
}
