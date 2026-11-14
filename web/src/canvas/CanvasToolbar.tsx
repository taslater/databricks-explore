import { useState } from 'react'
import { useCanvases } from '../api/hooks'
import { useCanvasStore } from '../store/canvasStore'
import { useSketchStore } from '../sketch/sketchStore'
import { useCanvasPersistence } from './persistence/useCanvasPersistence'
import { usePersistStore, type PersistPhase } from './persistence/persistStore'
import { ArrangeMenu } from './layout/ArrangeMenu'
import { LayoutDoctor } from './layout/LayoutDoctor'
import { useLayoutUi } from './layout/layoutStore'

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

/** Save, Save as, Open, the canvas name, the save status, and the layout Doctor and Arrange buttons. Mounted in a React Flow panel. */
export function CanvasToolbar() {
  const canvasName = useCanvasStore((s) => s.canvasName)
  const windowCount = useCanvasStore((s) => s.windows.length)
  const sketchCount = useSketchStore((s) => s.nodes.length)
  const phase = usePersistStore((s) => s.phase)
  const message = usePersistStore((s) => s.message)
  const messageIsError = usePersistStore((s) => s.messageIsError)
  const canvases = useCanvases()
  const persistence = useCanvasPersistence()
  const [pick, setPick] = useState('')
  const doctorOpen = useLayoutUi((s) => s.panelOpen)
  const setDoctorOpen = useLayoutUi((s) => s.setPanelOpen)
  const layoutNote = useLayoutUi((s) => s.note)

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

  async function onNew() {
    if (canvasName === null && windowCount + sketchCount > 0) {
      if (!window.confirm('Discard the unnamed canvas and start a new diagram?')) return
    }
    await persistence.newDiagram()
  }

  async function onOpen() {
    if (!pick) return
    if (canvasName === null && windowCount + sketchCount > 0) {
      if (!window.confirm(`Discard the unnamed canvas and open "${pick}"?`)) return
    }
    await persistence.open(pick)
  }

  return (
    <div className="ld-wrap">
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
        <button onClick={() => void onNew()} title="Start a blank sketch. No profile or warehouse needed.">
          New diagram
        </button>
        <button onClick={onSave}>Save</button>
        <button onClick={() => void onSaveAs()}>Save as</button>
        <button
          onClick={() => setDoctorOpen(!doctorOpen)}
          aria-pressed={doctorOpen}
          title="Check the layout for overlaps, near-misses and connectors through nodes"
        >
          Doctor
        </button>
        <ArrangeMenu />
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
        {!doctorOpen && layoutNote && (
          <span className={layoutNote.error ? 'error canvas-message' : 'hint canvas-message'} role={layoutNote.error ? 'alert' : undefined}>
            {layoutNote.text}
          </span>
        )}
      </div>
      {doctorOpen && <LayoutDoctor />}
    </div>
  )
}
