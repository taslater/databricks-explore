import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useReactFlow } from '@xyflow/react'
import { exportDiagram, type ExportFormat } from '../export'
import { useSketchStore } from '../sketchStore'
import { ArrangeControls } from './ArrangeControls'
import { ArrangeIcon } from './icons'

/** A button that opens a small floating menu under it, and closes it on an outside click or Escape. */
function Menu({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === 'Escape') setOpen(false)
      } else if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [open])
  return (
    <div className="sk-menu" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} title={title}>
        {label} &#9662;
      </button>
      {open && <div className="sk-menu-body">{children}</div>}
    </div>
  )
}

/** Export menu: PNG or SVG of the whole canvas or of the selection. */
function ExportMenu({ fileStem }: { fileStem: string }) {
  const rf = useReactFlow()
  const selected = useSketchStore((s) => s.selectedIds.length)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(format: ExportFormat, selectionOnly: boolean) {
    setBusy(true)
    setError(null)
    try {
      const root = document.querySelector<HTMLElement>('.canvas-root')
      if (!root) throw new Error('The canvas is not showing.')
      await exportDiagram(
        { format, selectionOnly, nodes: rf.getNodes(), edges: rf.getEdges(), root },
        `${fileStem}${selectionOnly ? '-selection' : ''}.${format}`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Menu label="Export" title="Export the canvas as an image">
      <div className="sk-menu-list">
        <button disabled={busy} onClick={() => void run('png', false)}>
          Canvas as PNG
        </button>
        <button disabled={busy} onClick={() => void run('svg', false)}>
          Canvas as SVG
        </button>
        <button disabled={busy || selected === 0} onClick={() => void run('png', true)}>
          Selection as PNG
        </button>
        <button disabled={busy || selected === 0} onClick={() => void run('svg', true)}>
          Selection as SVG
        </button>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="hint">SVG embeds the page content, so some vector editors cannot open it.</div>
      </div>
    </Menu>
  )
}

/** Undo, redo, grid snap, the Arrange menu and Export. `children` adds host buttons (such as Properties). */
export function EditBar({ fileStem, children }: { fileStem: string; children?: ReactNode }) {
  const undo = useSketchStore((s) => s.undo)
  const redo = useSketchStore((s) => s.redo)
  const canUndo = useSketchStore((s) => s.history.past.length > 0)
  const canRedo = useSketchStore((s) => s.history.future.length > 0)
  const snap = useSketchStore((s) => s.snap)
  const setSnap = useSketchStore((s) => s.setSnap)
  const duplicate = useSketchStore((s) => s.duplicate)
  const remove = useSketchStore((s) => s.removeSelection)
  const hasSelection = useSketchStore((s) => s.selectedIds.length + s.selectedEdgeIds.length > 0)
  return (
    <div className="sk-editbar" role="toolbar" aria-label="Edit">
      <button disabled={!canUndo} onClick={undo} title="Undo (Cmd/Ctrl+Z)" aria-label="Undo">
        <ArrangeIcon name="undo" />
      </button>
      <button disabled={!canRedo} onClick={redo} title="Redo (Shift+Cmd/Ctrl+Z)" aria-label="Redo">
        <ArrangeIcon name="redo" />
      </button>
      {hasSelection ? (
        <span className="selection-ui" data-selection-ui>
          <button onClick={duplicate} title="Duplicate (Cmd/Ctrl+D)">
            Duplicate
          </button>
          <button className="danger" onClick={remove} title="Delete (Delete or Backspace)">
            Delete
          </button>
        </span>
      ) : (
        <span className="hint sk-select-hint">Select to duplicate or delete</span>
      )}
      <label className="sk-snap" title="Snap to the grid (G)">
        <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> Snap
      </label>
      <Menu label="Arrange" title="Align, distribute, order and lock the selection">
        <ArrangeControls />
      </Menu>
      <ExportMenu fileStem={fileStem} />
      {children}
    </div>
  )
}
