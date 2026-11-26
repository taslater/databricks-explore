import { useEffect, useRef, useState } from 'react'
import { layoutArrange, type ArrangeMode } from '../../api/layout'
import { useSketchStore } from '../../sketch/sketchStore'
import { appliedNote, applyChanges, currentDoc, currentGrid } from './layoutActions'
import { useLayoutUi } from './layoutStore'

interface Choice {
  label: string
  mode: ArrangeMode
  options?: Record<string, unknown>
  title: string
}

export const ARRANGE_CHOICES: Choice[] = [
  { label: 'Grid', mode: 'grid', title: 'Rows and columns in reading order' },
  { label: 'Row', mode: 'row', title: 'One row, left to right' },
  { label: 'Column', mode: 'column', title: 'One column, top to bottom' },
  { label: 'Layered, left to right', mode: 'layered', options: { direction: 'LR' }, title: 'Connectors run left to right' },
  { label: 'Layered, top to bottom', mode: 'layered', options: { direction: 'TB' }, title: 'Connectors run top to bottom' },
]

/** Lays the selected nodes out from their structure. The top-left corner of the selection stays put. */
export function ArrangeMenu() {
  const selectedIds = useSketchStore((s) => s.selectedIds)
  const setNote = useLayoutUi((s) => s.setNote)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
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

  async function run(choice: Choice) {
    setOpen(false)
    setBusy(true)
    try {
      const out = await layoutArrange(currentDoc(), choice.mode, {
        ids: selectedIds,
        options: choice.options,
        grid: currentGrid(),
      })
      setNote(appliedNote(applyChanges(out.changes), out.score.before, out.score.after))
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e), true)
    } finally {
      setBusy(false)
    }
  }

  // Arranging needs a selection, so the button appears with one instead of sitting disabled.
  if (selectedIds.length < 2) return null

  return (
    <div className="ld-menu when-selected" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        aria-expanded={open}
        title="Lay the selected nodes out"
      >
        Arrange selection &#9662;
      </button>
      {open && (
        <div className="ld-menu-body" role="menu">
          {ARRANGE_CHOICES.map((c) => (
            <button key={c.label} role="menuitem" title={c.title} onClick={() => void run(c)}>
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
