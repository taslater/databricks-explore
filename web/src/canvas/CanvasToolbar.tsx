import { useEffect, useState } from 'react'
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

interface CanvasToolbarProps {
  onAddQuery: () => void
  onAddNote: () => void
  showMinimap: boolean
  onToggleMinimap: () => void
}

/** Add a window, Run all windows, Save, Minimap and the More menu (Save as, Open, New diagram, Doctor), the canvas name, the save status, and the layout Doctor and Arrange buttons. Mounted in a React Flow panel. */
export function CanvasToolbar({ onAddQuery, onAddNote, showMinimap, onToggleMinimap }: CanvasToolbarProps) {
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

  const [moreOpen, setMoreOpen] = useState(false)
  useEffect(() => {
    if (!moreOpen) return
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [moreOpen])

  const note = message ?? (!doctorOpen ? layoutNote?.text : undefined)
  const noteIsError = message ? messageIsError : !!layoutNote?.error

  return (
    <div className="ld-wrap">
      <div className="canvas-toolbar" role="toolbar" aria-label="Canvas">
        <div className="tb-group">
          <button className="primary" onClick={onAddQuery} title="Add a query window (Q)">
            + Query window
          </button>
          <button onClick={onAddNote} title="Add a Markdown note (N)">
            + Note
          </button>
        </div>
        <span className="toolbar-sep" />
        <div className="tb-group">
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
            <span className="hint canvas-message" role="status" title={batch.summary}>
              {batch.summary}
            </span>
          )}
        </div>
        <ArrangeMenu />
        <span className="spacer" />
        {note && (
          <span className={noteIsError ? 'error canvas-message' : 'hint canvas-message'} role={noteIsError ? 'alert' : undefined} title={note}>
            {note}
          </span>
        )}
        {canvases.isError && <span className="error canvas-message">{canvases.error.message}</span>}
        <span className="canvas-name" title="Canvas name">
          {canvasName ?? 'Unnamed canvas'}
        </span>
        <span className={`canvas-phase ${phase}`} title={PHASE_TITLE[phase]}>
          {PHASE_LABEL[phase]}
        </span>
        <span className="toolbar-sep" />
        <div className="tb-group">
          <button onClick={onSave}>Save</button>
          <button onClick={onToggleMinimap} aria-pressed={showMinimap} title="Show or hide the minimap">
            Minimap
          </button>
          <button onClick={() => setMoreOpen((o) => !o)} aria-expanded={moreOpen} title="Save as, open, new diagram and the layout Doctor">
            More &#9662;
          </button>
        </div>
      </div>
      {moreOpen && (
        <div className="canvas-more" role="group" aria-label="More canvas actions">
          <div className="tb-group">
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
            <button
              onClick={() => {
                setMoreOpen(false)
                onOpen()
              }}
              disabled={!pick}
            >
              Open
            </button>
          </div>
          <span className="toolbar-sep" />
          <button
            onClick={() => {
              setMoreOpen(false)
              onNew()
            }}
            title="Start a blank sketch. No profile or warehouse needed."
          >
            New diagram
          </button>
          <button
            onClick={() => {
              setMoreOpen(false)
              onSaveAs()
            }}
          >
            Save as
          </button>
          <button
            onClick={() => setDoctorOpen(!doctorOpen)}
            aria-pressed={doctorOpen}
            title="Check the layout for overlaps, near-misses and connectors through nodes"
          >
            Doctor
          </button>
        </div>
      )}
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
