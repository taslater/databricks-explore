import { useState } from 'react'
import { useCanvases } from '../api/hooks'
import { useCanvasStore } from '../store/canvasStore'
import { useCanvasPersistence } from './persistence/useCanvasPersistence'
import { usePersistStore, type PersistPhase } from './persistence/persistStore'

const PHASE_LABEL: Record<PersistPhase, string> = {
  unnamed: 'Not saved',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Not saved',
}

const PHASE_TITLE: Record<PersistPhase, string | undefined> = {
  unnamed: 'Save as a name to turn on autosave.',
  unsaved: 'Autosave runs 1.5 seconds after the last change.',
  saving: undefined,
  saved: undefined,
  error: undefined,
}

/** Save, Save as, Open, the canvas name, and the save status. Mounted in a React Flow panel. */
export function CanvasToolbar() {
  const canvasName = useCanvasStore((s) => s.canvasName)
  const windowCount = useCanvasStore((s) => s.windows.length)
  const phase = usePersistStore((s) => s.phase)
  const message = usePersistStore((s) => s.message)
  const messageIsError = usePersistStore((s) => s.messageIsError)
  const canvases = useCanvases()
  const persistence = useCanvasPersistence()
  const [pick, setPick] = useState('')

  async function onSaveAs() {
    const entered = window.prompt('Canvas name (letters, digits, _ . -)', canvasName ?? '')?.trim()
    if (!entered) return
    if (entered !== canvasName && canvases.data?.includes(entered)) {
      if (!window.confirm(`Replace the saved canvas "${entered}"?`)) return
    }
    await persistence.saveAs(entered)
  }

  function onSave() {
    if (canvasName === null) {
      void onSaveAs()
      return
    }
    void persistence.saveCurrent()
  }

  async function onOpen() {
    if (!pick) return
    if (canvasName === null && windowCount > 0) {
      if (!window.confirm(`Discard the unnamed canvas and open "${pick}"?`)) return
    }
    await persistence.open(pick)
  }

  return (
    <div className="canvas-toolbar" role="toolbar" aria-label="Canvas">
      <select
        value={pick}
        onChange={(e) => setPick(e.target.value)}
        aria-label="Saved canvases"
        disabled={!canvases.data}
      >
        <option value="">— saved canvases —</option>
        {canvases.data?.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <button onClick={() => void onOpen()} disabled={!pick}>
        Open
      </button>
      <button onClick={onSave}>Save</button>
      <button onClick={() => void onSaveAs()}>Save as</button>
      <span className="canvas-name" title="Canvas name">
        {canvasName ?? 'Unnamed canvas'}
      </span>
      <span className={`canvas-phase ${phase}`} title={PHASE_TITLE[phase]}>
        {PHASE_LABEL[phase]}
      </span>
      {message && (
        <span className={messageIsError ? 'error canvas-message' : 'hint canvas-message'} role={messageIsError ? 'alert' : undefined}>
          {message}
        </span>
      )}
      {canvases.isError && <span className="error canvas-message">{canvases.error.message}</span>}
    </div>
  )
}
