import { useEffect, useRef, useState } from 'react'
import { titleError, useCanvasStore } from '../../store/canvasStore'

/**
 * Inline-editable title for query, note and table windows. Unique on the canvas, no braces, committed on blur
 * or Enter, reverted on Escape. The title is only a text field after a double-click (or Enter or F2 when it has
 * keyboard focus). Until then a press on it drags the window like the rest of the header, so the whole header
 * is a handle and only the field being edited is `nodrag`.
 */
export function WindowTitle({ id, title }: { id: string; title: string }) {
  const windows = useCanvasStore((s) => s.windows)
  const renameWindow = useCanvasStore((s) => s.renameWindow)
  const [draft, setDraft] = useState(title)
  const [editing, setEditing] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  // Follow the store when the title changes from somewhere else (for example a canvas load).
  useEffect(() => setDraft(title), [title])

  // Focus once the field is editable, with the text selected.
  useEffect(() => {
    if (editing) {
      input.current?.focus()
      input.current?.select()
    }
  }, [editing])

  const error = titleError(draft.trim(), windows, id)

  return (
    <div className="qw-title">
      <input
        ref={input}
        className={`qw-title-input${editing ? ' nodrag' : ''}`}
        value={draft}
        readOnly={!editing}
        aria-label="Window title"
        aria-invalid={error !== null}
        title={editing ? undefined : 'Double-click to rename. Drag to move the window.'}
        onChange={(e) => setDraft(e.target.value)}
        onDoubleClick={() => setEditing(true)}
        // Commit on blur. Enter blurs, so it goes through the same path.
        onBlur={() => {
          if (!editing) return
          renameWindow(id, draft)
          setEditing(false)
        }}
        onKeyDown={(e) => {
          if (!editing) {
            if (e.key === 'Enter' || e.key === 'F2') {
              e.preventDefault()
              setEditing(true)
            }
            return
          }
          if (e.key === 'Enter') e.currentTarget.blur()
          // Escape reverts the draft and leaves the field without committing.
          if (e.key === 'Escape') {
            setDraft(title)
            setEditing(false)
          }
        }}
      />
      {error !== null && <div className="error qw-error">{error}</div>}
    </div>
  )
}
