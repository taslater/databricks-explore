import { useState } from 'react'
import { useCanvases } from '../api/hooks'
import { useCanvasStore } from '../store/canvasStore'
import { useUiStore } from '../store/uiStore'
import { runAllWindows, stopRunAll, useBatchStore } from './runAll'
import { useSketchStore } from '../sketch/sketchStore'
import { useCanvasPersistence } from './persistence/useCanvasPersistence'
import { usePersistStore, type PersistPhase } from './persistence/persistStore'
import { ConfirmDialog, NameDialog } from '../shared/Dialog'
import { toCanvasName } from '../shared/canvasName'
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

/** The dialog showing over the toolbar, if any. */
type DialogState =
  | null
  | { kind: 'name'; initial: string; error?: string }
  | { kind: 'replace'; name: string }
  | { kind: 'discard-new' }
  | { kind: 'discard-open'; name: string }

/** Save, Save as, Open, the canvas name, the save status, and the layout Doctor and Arrange buttons. Mounted in a React Flow panel. */
export function CanvasToolbar() {
  const canvasName = useCanvasStore((s) => s.canvasName)
  const windowCount = useCanvasStore((s) => s.windows.length)
  const queryCount = useCanvasStore((s) => s.windows.filter((w) => w.type === 'query').length)
  const connected = useUiStore((s) => s.connectedProfile !== null)
  const batch = useBatchStore()
  const sketchCount = useSketchStore((s) => s.nodes.length)
  const phase = usePersistStore((s) => s.phase)
  const message = usePersistStore((s) => s.message)
  const messageIsError = usePersistStore((s) => s.messageIsError)
  const canvases = useCanvases(true)
  const persistence = useCanvasPersistence()
  const [pick, setPick] = useState('')
  const [dialog, setDialog] = useState<DialogState>(null)
  const doctorOpen = useLayoutUi((s) => s.panelOpen)
  const setDoctorOpen = useLayoutUi((s) => s.setPanelOpen)
  const layoutNote = useLayoutUi((s) => s.note)

  const hasUnnamedWork = canvasName === null && windowCount + sketchCount > 0

  /** Writes under `name`. Returns the reason it failed, or null after closing the dialog. */
  async function saveUnder(name: string): Promise<string | null> {
    const reason = await persistence.saveAs(name)
    if (reason === null) setDialog(null)
    return reason
  }

  /** Name dialog: asks before replacing another saved canvas, using a list fetched just now (an agent may have added some). */
  async function onNameChosen(name: string): Promise<string | null> {
    if (name !== canvasName) {
      const list = (await canvases.refetch()).data ?? canvases.data
      if (list?.includes(name)) {
        setDialog({ kind: 'replace', name })
        return null
      }
    }
    return saveUnder(name)
  }

  async function onReplaceConfirmed(name: string) {
    const reason = await saveUnder(name)
    if (reason !== null) setDialog({ kind: 'name', initial: name, error: reason })
  }

  function onSaveAs() {
    setDialog({ kind: 'name', initial: canvasName ?? '' })
  }

  function onSave() {
    if (canvasName === null) {
      onSaveAs()
      return
    }
    void persistence.saveCurrent()
  }

  function onNew() {
    if (hasUnnamedWork) setDialog({ kind: 'discard-new' })
    else void persistence.newDiagram()
  }

  function onOpen() {
    if (!pick) return
    if (hasUnnamedWork) setDialog({ kind: 'discard-open', name: pick })
    else void persistence.open(pick)
  }

  return (
    <div className="ld-wrap">
      <div className="canvas-toolbar" role="toolbar" aria-label="Canvas">
        <select
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          // An agent can add canvases at any time, so opening the list asks the server again.
          onMouseDown={() => void canvases.refetch()}
          onFocus={() => void canvases.refetch()}
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
        <button onClick={onOpen} disabled={!pick}>
          Open
        </button>
        <button onClick={onNew} title="Start a blank sketch. No profile or warehouse needed.">
          New diagram
        </button>
        <button onClick={onSave}>Save</button>
        <button onClick={onSaveAs}>Save as</button>
        <button
          onClick={() => setDoctorOpen(!doctorOpen)}
          aria-pressed={doctorOpen}
          title="Check the layout for overlaps, near-misses and connectors through nodes"
        >
          Doctor
        </button>
        <ArrangeMenu />
        <button
          onClick={runAllWindows}
          disabled={batch.active || queryCount === 0 || !connected}
          title={
            connected
              ? 'Run every query window. A window that references another through {{title}} runs after it.'
              : 'Connect to a profile to run queries.'
          }
        >
          Run all windows
        </button>
        {batch.active && (
          <>
            <span className="hint canvas-message" role="status">
              Running {batch.finished} of {batch.total}
            </span>
            <button onClick={stopRunAll} title="Cancel the statements still running and start no more">
              Stop
            </button>
          </>
        )}
        {!batch.active && batch.summary && (
          <span className="hint canvas-message" role="status">
            {batch.summary}
          </span>
        )}
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
      {dialog?.kind === 'name' && (
        <NameDialog
          title={canvasName === null ? 'Save canvas' : 'Save canvas as'}
          label="Canvas name"
          placeholder="Returns tour"
          initial={dialog.initial}
          initialError={dialog.error}
          convert={toCanvasName}
          previewText={(name) => `Saved as ${name}`}
          onSubmit={onNameChosen}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'replace' && (
        <ConfirmDialog
          title="Replace canvas"
          message={`Replace the saved canvas "${dialog.name}"? Its current contents are overwritten.`}
          confirmLabel="Replace"
          destructive
          onConfirm={() => void onReplaceConfirmed(dialog.name)}
          onCancel={() => setDialog({ kind: 'name', initial: dialog.name })}
        />
      )}
      {dialog?.kind === 'discard-new' && (
        <ConfirmDialog
          title="Discard unnamed canvas"
          message="Discard the unnamed canvas and start a new diagram?"
          confirmLabel="Discard"
          destructive
          onConfirm={() => {
            setDialog(null)
            void persistence.newDiagram()
          }}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'discard-open' && (
        <ConfirmDialog
          title="Discard unnamed canvas"
          message={`Discard the unnamed canvas and open "${dialog.name}"?`}
          confirmLabel="Discard"
          destructive
          onConfirm={() => {
            setDialog(null)
            void persistence.open(dialog.name)
          }}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  )
}
