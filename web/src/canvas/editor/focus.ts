// Focus for the SQL editor. A click in the editor's blank space (below the last line, or beside it) has to
// land in the editor, or the typing that follows goes to the canvas shortcuts. No React imports.
import type { EditorView } from '@codemirror/view'

export interface ScrollerBox {
  /** The scroller's border box on screen. */
  left: number
  top: number
  /** Its client size: the box without scrollbars. */
  clientWidth: number
  clientHeight: number
}

/** True when a point lies on the scroller's own scrollbar (right or bottom edge), which must keep working. */
export function onScrollbar(box: ScrollerBox, x: number, y: number): boolean {
  return x - box.left >= box.clientWidth || y - box.top >= box.clientHeight
}

/**
 * Handles a mouse press anywhere in the editor area. CodeMirror handles presses on the text itself. A press on
 * blank space (the empty area below the last line, padding) focuses the editor and puts the cursor at the end of
 * the document. A press on a scrollbar is left alone. Returns true when it took the press.
 */
export function focusFromBlank(
  e: { target: EventTarget | null; clientX: number; clientY: number; preventDefault: () => void },
  view: EditorView | null,
): boolean {
  if (!view) return false
  const target = e.target as Element | null
  if (target && typeof target.closest === 'function' && target.closest('.cm-content') !== null) return false
  const s = view.scrollDOM
  const r = s.getBoundingClientRect()
  if (onScrollbar({ left: r.left, top: r.top, clientWidth: s.clientWidth, clientHeight: s.clientHeight }, e.clientX, e.clientY)) {
    return false
  }
  e.preventDefault()
  view.focus()
  view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true })
  return true
}
